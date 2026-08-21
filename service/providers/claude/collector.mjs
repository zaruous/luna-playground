import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UsageProviderAdapter } from '../contracts.mjs';
import { accountingOf } from '../accounting.mjs';
import { readCompleteLines } from '../jsonl-tail.mjs';
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

  async #scanFileInternal(filePath, reason) {
    let scanState = this.store.getScanState(this.id, filePath);
    let startOffset = scanState?.byteOffset ?? 0;

    let currentStat;
    try {
      currentStat = await fsp.stat(filePath);
    } catch {
      return { changed: false, reason: 'missing' };
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
      return { changed: false, reason: 'unchanged' };
    }

    const storedSession = scanState?.sessionId ? this.store.getSession('claude', scanState.sessionId) : null;
    const parserState = createClaudeParserState({
      filePath,
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
    });
    // 전체 재스캔이면 이 세션의 턴 경계를 지우고 다시 만듭니다 — 턴 번호는
    // 스캔 시작점에 따라 달라질 수 있어 재구성이 안전합니다.
    if (startOffset === 0 && !parserState.subagentFile) {
      this.store.resetTurns('claude', parserState.session.sessionId);
    }

    let changed = false;
    let usageEvents = 0;
    let updatedEvents = 0;
    let turnEvents = 0;
    let parseErrors = 0;
    let pending = [];

    const flush = () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      this.store.transaction(() => {
        for (const { event, sourceOffset, observedAt } of batch) {
          // Claude 는 같은 요청이 여러 줄로 나뉘고 resume 시 파일이 복사되므로
          // insert 가 아니라 요청 단위 upsert 입니다(R1 last-wins).
          const result = this.store.upsertUsageEvent(event, filePath, sourceOffset, observedAt);
          if (!result.changed) continue;
          changed = true;
          if (result.inserted) usageEvents += 1;
          else updatedEvents += 1;
        }
      });
    };

    const result = await readCompleteLines(filePath, startOffset, async (line, sourceOffset) => {
      const events = parseClaudeTranscriptLine(line, parserState);
      const observedAt = new Date().toISOString();
      for (const event of events) {
        if (event.type === 'session') {
          this.store.upsertSession(event.session, filePath, observedAt);
        } else if (event.type === 'turn') {
          // 턴 경계는 사실이라 즉시 씁니다. 토큰은 여기 담지 않습니다.
          this.store.upsertTurn(event);
          turnEvents += 1;
          changed = true;
        } else if (event.type === 'usage') {
          pending.push({ event, sourceOffset, observedAt });
          if (pending.length >= FLUSH_BATCH_SIZE) flush();
        } else if (event.type === 'parse_error') {
          parseErrors += 1;
        }
      }
    });

    flush();

    if (result.truncated) return this.#scanFileInternal(filePath, `${reason}:truncated`);

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
    this.status.parseErrors += parseErrors;
    this.status.lastScanAt = new Date().toISOString();
    this.status.lastError = null;
    if (changed) {
      this.emit('updated', { provider: 'claude', filePath, reason, usageEvents, updatedEvents, turnEvents });
    }
    return { changed, usageEvents, updatedEvents, turnEvents, parseErrors, finalOffset: result.finalOffset };
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

  async start() {
    await this.reconcile('startup');
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => this.reconcile('interval'), this.reconcileIntervalMs);
      this.reconcileTimer.unref?.();
    }
    return this.getStatus();
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
