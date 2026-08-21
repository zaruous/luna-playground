import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UsageProviderAdapter } from '../contracts.mjs';
import { accountingOf } from '../accounting.mjs';
import { readCompleteLines } from '../jsonl-tail.mjs';
import { applyParserTail } from '../../scan-pool.mjs';
import {
  claudeProjectRoots,
  detectClaudeRoots,
  discoverClaudeTranscripts,
  resolveClaudeHomes,
} from './detector.mjs';
import {
  CLAUDE_PARSER_VERSION,
  claudeSessionIdFromPath,
  createClaudeParserState,
  parseClaudeTranscriptLine,
} from './parser.mjs';

const FLUSH_BATCH_SIZE = 500;

// 이어 읽기 시점에 어느 세션의 턴을 물려받을지 알아야 합니다. 저장된 세션이
// 있으면 그것을, 없으면 경로에서 유추합니다(서브에이전트 파일은 부모 세션).
function parserSessionId(filePath, storedSession) {
  return storedSession?.sessionId ?? claudeSessionIdFromPath(filePath);
}

export class ClaudeCollector extends UsageProviderAdapter {
  constructor({ store, claudeHomes = resolveClaudeHomes(), reconcileIntervalMs = 5000 } = {}) {
    super({
      id: 'claude',
      name: 'Claude',
      measurement: 'local_observed',
      capabilities: {
        localLedger: true,
        // JSONL 에는 한도 정보가 없습니다. percent 원장이 생기는 것은 공식
        // 서버 사용량 연동이 붙은 다음입니다(docs/claude-code-adapter.md §21).
        serverQuota: false,
        hooks: true,
        // OTLP 보강 경로는 아직 켜지 않았습니다. 켜면 measurement_source
        // 'telemetry' 로 별도 레인에 병렬 보관합니다(R8).
        telemetry: false,
        credentials: 'none',
        // Codex 의 누적 diff 회계를 실수로 재사용하지 않도록 못박습니다(§4).
        accounting: 'direct',
        // 캐시 읽기가 input 밖에 있는 회계입니다. Codex 는 input 안에 있습니다.
        tokenAccounting: accountingOf('claude'),
      },
    });
    this.store = store;
    this.claudeHomes = claudeHomes;
    this.projectRoots = claudeProjectRoots(claudeHomes);
    this.activeRoots = [];
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.watchers = new Map();
    this.scanInFlight = new Map();
    this.reconcileTimer = null;
    this.status = {
      provider: 'claude',
      detected: false,
      ledgerAvailable: false,
      projectRoots: this.projectRoots,
      watching: false,
      lastScanAt: null,
      lastError: null,
      filesDiscovered: 0,
      parserVersion: CLAUDE_PARSER_VERSION,
      emptyUsageRecords: 0,
      syntheticRecords: 0,
      iterationDiscrepancies: 0,
      cacheWriteDiscrepancies: 0,
      parseErrors: 0,
      reparsedFiles: 0,
    };
  }

  async detect() {
    this.activeRoots = await detectClaudeRoots(this.projectRoots);
    this.status.detected = this.activeRoots.length > 0;
    this.status.ledgerAvailable = this.status.detected;
    return this.status.detected;
  }

  async discoverFiles() {
    const groups = await Promise.all(this.activeRoots.map((root) => discoverClaudeTranscripts(root)));
    const files = [...new Set(groups.flat())].sort();
    this.status.filesDiscovered = files.length;
    return files;
  }

  #projectsRootFor(filePath) {
    return this.projectRoots.find((root) => !path.relative(root, filePath).startsWith('..')) ?? null;
  }

  async scanFile(filePath, reason = 'reconcile') {
    if (this.scanInFlight.has(filePath)) return this.scanInFlight.get(filePath);
    const task = this.#scanFileInternal(filePath, reason).finally(() => this.scanInFlight.delete(filePath));
    this.scanInFlight.set(filePath, task);
    return task;
  }

  // 스캔은 준비 → 적재 → 마감 세 단계입니다. 파일을 이 스레드에서 직접 읽든
  // (scanFile) 워커가 읽어 배치로 보내오든(backfill) 스토어에 반영하는 규칙은
  // 한 곳에만 있어야 합니다.
  async prepareScan(filePath) {
    let scanState = this.store.getScanState(this.id, filePath);
    let startOffset = scanState?.byteOffset ?? 0;

    let currentStat;
    try {
      currentStat = await fsp.stat(filePath);
    } catch {
      return { skip: 'missing' };
    }

    // 절단/교체 감지 → 커서를 버리고 처음부터 안전 재스캔합니다. 이벤트 키가
    // 요청 단위이므로 다시 읽어도 합계는 늘지 않습니다.
    if (startOffset > currentStat.size) {
      this.store.resetScanState(this.id, filePath);
      scanState = null;
      startOffset = 0;
    }

    // 파서가 버전업되면 이전 버전으로 읽은 파일을 한 번 다시 해석합니다.
    // 예: 턴 계층이 생긴 v2 는 v1 로 읽은 파일의 턴 정보를 갖고 있지 않습니다.
    // 중복 제거가 있어 재해석이 합계를 늘리지는 않습니다.
    const staleParser = scanState && (scanState.parserVersion ?? 0) < CLAUDE_PARSER_VERSION;
    // 버전 도장은 찍혔는데 원장에 턴이 안 붙은 경우도 재해석 대상입니다
    // (결함이 있던 중간 버전이 버전만 올려놓은 상황).
    const missingTurns = Boolean(scanState) && this.store.hasUnattributedTurns(this.id, filePath);
    if (staleParser || missingTurns) {
      this.status.reparsedFiles += 1;
      scanState = null;
      startOffset = 0;
    }

    if (startOffset === currentStat.size && scanState?.mtimeMs === currentStat.mtimeMs) {
      return { skip: 'unchanged' };
    }

    const storedSession = scanState?.sessionId ? this.store.getSession('claude', scanState.sessionId) : null;
    // 파서 상태는 이 씨앗만으로 결정됩니다. 워커에는 상태가 아니라 씨앗을
    // 보내고, 워커가 같은 상태를 다시 만듭니다.
    const seed = {
      projectsRoot: this.#projectsRootFor(filePath),
      session: storedSession,
      // 처음부터 읽을 때는 턴 번호도 1번부터 다시 셉니다. 이어 읽을 때는
      // 마지막 턴 번호를 물려받아야 번호가 되감기지 않습니다.
      turn: startOffset > 0
        ? {
            index: this.store.getLastTurnIndex('claude', parserSessionId(filePath, storedSession)),
            startedAt: null,
            compactedPending: false,
          }
        : null,
    };
    const parserState = createClaudeParserState({ filePath, ...seed });
    // 전체 재스캔이면 이 세션의 턴 경계를 지우고 다시 만듭니다 — 턴 번호는
    // 스캔 시작점에 따라 달라질 수 있어 재구성이 안전합니다.
    if (startOffset === 0 && !parserState.subagentFile) {
      this.store.resetTurns('claude', parserState.session.sessionId);
    }
    return { startOffset, parserState, seed };
  }

  // 이벤트를 모아 트랜잭션으로 한 번에 넣습니다. 도착 순서를 그대로 지켜야
  // 세션·턴이 그 뒤의 사용량보다 먼저 들어갑니다.
  createScanSink(filePath) {
    const counters = { changed: false, usageEvents: 0, updatedEvents: 0, turnEvents: 0, parseErrors: 0 };
    let pending = [];

    const flush = () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      this.store.transaction(() => {
        for (const { event, sourceOffset, observedAt } of batch) {
          if (event.type === 'session') {
            this.store.upsertSession(event.session, filePath, observedAt);
          } else if (event.type === 'turn') {
            // 턴 경계는 사실이라 그대로 씁니다. 토큰은 여기 담지 않습니다.
            this.store.upsertTurn(event);
            counters.turnEvents += 1;
            counters.changed = true;
          } else if (event.type === 'usage') {
            // Claude 는 같은 요청이 여러 줄로 나뉘고 resume 시 파일이 복사되므로
            // insert 가 아니라 요청 단위 upsert 입니다(R1 last-wins).
            const result = this.store.upsertUsageEvent(event, filePath, sourceOffset, observedAt);
            if (!result.changed) continue;
            counters.changed = true;
            if (result.inserted) counters.usageEvents += 1;
            else counters.updatedEvents += 1;
          } else if (event.type === 'parse_error') {
            counters.parseErrors += 1;
          }
        }
      });
    };

    return {
      counters,
      push(event, sourceOffset) {
        pending.push({ event, sourceOffset, observedAt: new Date().toISOString() });
        if (pending.length >= FLUSH_BATCH_SIZE) flush();
      },
      flush,
    };
  }

  finalizeScan(filePath, parserState, result, reason, counters) {
    this.store.saveScanState({
      provider: this.id,
      sourcePath: filePath,
      byteOffset: result.finalOffset,
      fileSize: result.fileSize,
      mtimeMs: result.mtimeMs,
      // Claude 는 누적 카운터가 없으므로 이전 누적값을 이어받을 필요가 없습니다.
      previousUsage: {},
      sessionId: parserState.session.sessionId,
      parserVersion: CLAUDE_PARSER_VERSION,
    });

    this.status.emptyUsageRecords += parserState.stats.emptyUsageRecords;
    this.status.syntheticRecords += parserState.stats.syntheticRecords;
    this.status.iterationDiscrepancies += parserState.stats.iterationDiscrepancies;
    this.status.cacheWriteDiscrepancies += parserState.stats.cacheWriteDiscrepancies;
    this.status.parseErrors += counters.parseErrors;
    this.status.lastScanAt = new Date().toISOString();
    this.status.lastError = null;
    if (counters.changed) {
      this.emit('updated', {
        provider: 'claude',
        filePath,
        reason,
        usageEvents: counters.usageEvents,
        updatedEvents: counters.updatedEvents,
        turnEvents: counters.turnEvents,
      });
    }
    return { ...counters, finalOffset: result.finalOffset };
  }

  async #scanFileInternal(filePath, reason) {
    const prepared = await this.prepareScan(filePath);
    if (prepared.skip) return { changed: false, reason: prepared.skip };

    const { parserState } = prepared;
    const sink = this.createScanSink(filePath);
    const result = await readCompleteLines(filePath, prepared.startOffset, (line, sourceOffset) => {
      for (const event of parseClaudeTranscriptLine(line, parserState)) sink.push(event, sourceOffset);
    });
    sink.flush();

    if (result.truncated) return this.#scanFileInternal(filePath, `${reason}:truncated`);
    return this.finalizeScan(filePath, parserState, result, reason, sink.counters);
  }

  // 워커가 읽고 해석한 결과를 받아 적재합니다. 준비와 마감은 메인 스레드에
  // 그대로 남습니다 — 커서와 턴 번호를 정하는 일은 스토어를 봐야 합니다.
  async #scanFileWithPool(filePath, reason, pool) {
    const prepared = await this.prepareScan(filePath);
    if (prepared.skip) return { changed: false, reason: prepared.skip };

    const { parserState } = prepared;
    const sink = this.createScanSink(filePath);
    const result = await pool.submit(
      { provider: this.id, strategy: 'line', filePath, startOffset: prepared.startOffset, seed: prepared.seed },
      (events) => {
        for (const { event, sourceOffset } of events) sink.push(event, sourceOffset);
      },
    );
    sink.flush();

    // 절단이 감지되면 처음부터 다시 읽어야 합니다. 재시도는 인라인 경로로
    // 보냅니다 — 이미 워커 한 자리를 쓰고 있어 재귀로 또 잡으면 교착입니다.
    if (result.truncated) return this.#scanFileInternal(filePath, `${reason}:truncated`);
    applyParserTail(parserState, result.tail);
    return this.finalizeScan(filePath, parserState, result, reason, sink.counters);
  }

  async reconcile(reason = 'interval') {
    try {
      await this.detect();
      if (!this.status.detected) return { changed: false, files: 0 };
      const files = await this.discoverFiles();
      let changed = false;
      for (const filePath of files) {
        const result = await this.scanFile(filePath, reason);
        changed ||= Boolean(result?.changed);
      }
      await this.refreshWatchers(files);
      this.status.lastScanAt = new Date().toISOString();
      this.status.lastError = null;
      return { changed, files: files.length };
    } catch (error) {
      this.status.lastError = String(error?.message ?? error);
      this.emit('error-state', { provider: 'claude', error: this.status.lastError });
      return { changed: false, error: this.status.lastError };
    }
  }

  // transcript 가 실제로 들어 있는 디렉터리만 감시합니다. projects 아래를 전부
  // 감시하면 프로젝트 수만큼 watcher 가 늘고 도구 산출물 디렉터리의 잡음까지
  // 받습니다. watcher 는 어차피 힌트일 뿐이고 주기 reconcile 이 안전망입니다.
  async refreshWatchers(knownFiles = null) {
    const files = knownFiles ?? await this.discoverFiles();
    const dirs = new Set(files.map((filePath) => path.dirname(filePath)));
    for (const root of this.activeRoots) dirs.add(root);

    for (const [dir, watcher] of this.watchers) {
      if (!dirs.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }

    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
          if (filename && String(filename).endsWith('.jsonl')) {
            const target = path.join(dir, String(filename));
            setTimeout(() => this.scanFile(target, 'fs-watch').catch(() => {}), 80);
          } else {
            setTimeout(() => this.reconcile('fs-watch-directory').catch(() => {}), 120);
          }
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // 주기 reconcile 이 신뢰성 폴백입니다.
      }
    }
    this.status.watching = this.watchers.size > 0;
  }

  async start({ backfill = true } = {}) {
    // detect 는 디렉터리 확인뿐이라 즉시 끝납니다. 전량 스캔을 미루더라도
    // "로그가 있다"는 사실은 화면이 바로 알아야 합니다.
    await this.detect();
    if (backfill) {
      await this.reconcile('startup');
      this.startWatching();
    }
    return this.getStatus();
  }

  // 주기 reconcile 은 백필이 끝난 뒤에 켭니다. 백필 도중에 켜면 5초마다
  // 전량 스캔이 겹쳐 서로를 밀어냅니다.
  startWatching() {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => this.reconcile('interval'), this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  // 첫 실행의 전량 스캔. 풀이 있으면 파일별 읽기·해석을 워커로 넘기고 적재만
  // 여기서 합니다.
  async backfill(reason = 'startup', { pool = null, onProgress = null } = {}) {
    await this.detect();
    if (!this.status.detected) {
      onProgress?.({ detected: false, filesTotal: 0, filesDone: 0 });
      return { changed: false, files: 0 };
    }

    const files = await this.discoverFiles();
    let changed = false;
    let done = 0;
    let failures = 0;
    onProgress?.({ detected: true, filesTotal: files.length, filesDone: 0 });

    const runOne = async (filePath) => {
      try {
        const result = pool
          ? await this.#scanFileWithPool(filePath, reason, pool)
          : await this.scanFile(filePath, reason);
        changed ||= Boolean(result?.changed);
      } catch (error) {
        // 파일 하나가 실패해도 백필 전체를 멈추지 않습니다. 남은 파일이 훨씬
        // 많고, 실패한 파일은 다음 주기 reconcile 이 다시 집습니다.
        failures += 1;
        this.status.lastError = String(error?.message ?? error);
        this.emit('error-state', { provider: 'claude', error: this.status.lastError });
      } finally {
        done += 1;
        onProgress?.({ detected: true, filesTotal: files.length, filesDone: done });
      }
    };

    // 턴 번호는 세션 단위 상태입니다. 한 세션의 transcript 는 여러 파일로
    // 갈라질 수 있으므로(서브에이전트, resume 사본) 같은 세션의 파일은 한
    // 줄로 세워 순서대로 처리합니다. 세션끼리는 서로 독립이라 병렬입니다.
    const bySession = new Map();
    for (const filePath of files) {
      const key = claudeSessionIdFromPath(filePath);
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(filePath);
    }

    await Promise.all([...bySession.values()].map(async (group) => {
      for (const filePath of group) await runOne(filePath);
    }));

    await this.refreshWatchers(files);
    this.status.lastScanAt = new Date().toISOString();
    if (!failures) this.status.lastError = null;
    return { changed, files: files.length, failures };
  }

  stop() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.status.watching = false;
  }

  // Hook 은 가속 신호일 뿐입니다. 페이로드에서 transcript 경로와 이벤트 이름만
  // 쓰고, prompt / last_assistant_message 같은 본문 필드는 읽지 않습니다(§11).
  async handleHookSignal(payload = {}) {
    const eventName = payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? 'unknown';
    const transcriptPath = payload.transcript_path ?? payload.transcriptPath ?? null;
    if (transcriptPath && String(transcriptPath).endsWith('.jsonl')) {
      await this.scanFile(String(transcriptPath), `hook:${eventName}`);
    } else {
      await this.reconcile(`hook:${eventName}`);
    }
    this.emit('hook', { hook_event_name: eventName, session_id: payload.session_id ?? null });
  }

  getStatus() {
    return { ...this.status, watcherCount: this.watchers.size, activeRoots: this.activeRoots };
  }
}
