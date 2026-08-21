import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UsageProviderAdapter } from '../contracts.mjs';
import { accountingOf } from '../accounting.mjs';
import { readCompleteLines } from '../jsonl-tail.mjs';
import { applyParserTail } from '../../scan-pool.mjs';
import {
  detectGeminiRoots,
  discoverGeminiSessions,
  geminiFileStrategy,
  geminiProjectDirName,
  geminiProjectRoots,
  geminiSessionKey,
  readGeminiProjectIndex,
  readGeminiSessionFile,
  resolveGeminiHomes,
  resolveGeminiProject,
} from './detector.mjs';
import {
  GEMINI_PARSER_VERSION,
  createGeminiParserState,
  parseGeminiLogLine,
  parseGeminiSessionFile,
  withSourceOffsets,
} from './parser.mjs';

const FLUSH_BATCH_SIZE = 500;

export class GeminiCollector extends UsageProviderAdapter {
  constructor({ store, geminiHomes = resolveGeminiHomes(), reconcileIntervalMs = 5000 } = {}) {
    super({
      id: 'gemini',
      name: 'Gemini',
      measurement: 'local_observed',
      capabilities: {
        localLedger: true,
        // Gemini 세션 로그에는 서버 한도 정보가 없습니다. Codex 의 rate_limits
        // 같은 필드가 없으므로 있는 것처럼 두지 않습니다.
        serverQuota: false,
        // Gemini CLI 의 hook 규약을 확인하지 못했습니다. true 로 두면 화면에
        // 누를 수 없는 설치 버튼이 생깁니다.
        hooks: false,
        telemetry: false,
        credentials: 'none',
        // 메시지가 이미 요청 단위입니다 — Codex 의 누적 diff 를 쓰면 안 됩니다.
        accounting: 'direct',
        // 캐시 읽기가 input 안에 있습니다(실측). parser.mjs 상단 주석 참고.
        tokenAccounting: accountingOf('gemini'),
      },
    });
    this.store = store;
    this.geminiHomes = geminiHomes;
    this.projectRoots = geminiProjectRoots(geminiHomes);
    this.activeRoots = [];
    this.projectIndex = { bySlug: new Map(), byPathHash: new Map() };
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.watchers = new Map();
    this.scanInFlight = new Map();
    this.reconcileTimer = null;
    this.status = {
      provider: 'gemini',
      detected: false,
      ledgerAvailable: false,
      projectRoots: this.projectRoots,
      watching: false,
      lastScanAt: null,
      lastError: null,
      filesDiscovered: 0,
      parserVersion: GEMINI_PARSER_VERSION,
      // 프로젝트 경로를 되돌린 것과 못 되돌린 것을 따로 셉니다. 화면이
      // "이름을 모르는 프로젝트가 몇 개인지" 말할 수 있어야 합니다.
      projectsIndexed: 0,
      projectsResolved: 0,
      projectsUnresolved: 0,
      // 실측 계약이 깨진 건수. 0 이 아니면 파서가 아니라 로그 포맷이 바뀐
      // 것이므로 보정하지 않고 여기로 드러냅니다.
      identityMismatches: 0,
      cacheOutsideInput: 0,
      toolTokensSeen: 0,
      parseErrors: 0,
      reparsedFiles: 0,
      unchangedByHash: 0,
      // 옛 세션 정체로 묶인 원장을 비우고 다시 만든 횟수(정상은 0 또는 1).
      identityResets: 0,
    };
  }

  // 파서 v2 에서 세션 정체가 바뀌었습니다: 로그의 sessionId → 경로 파생 키.
  // 이미 쌓인 행은 옛 정체로 묶여 있고, upsertUsageEvent 는 event_key 로 찾아
  // 갱신하면서 session_id 는 건드리지 않으므로 **재해석만으로는 고쳐지지
  // 않습니다.** 그래서 이 provider 의 원장을 한 번 비우고 다시 만듭니다 —
  // 전부 로컬 로그에서 파생되는 값이라 잃는 것이 없고, 재스캔은 10초 안쪽입니다.
  //
  // 판정은 "옛 정체로 묶인 세션이 하나라도 있나" 입니다. v2 키는 항상
  // 'gemini-' 로 시작하므로 한 번 정리한 뒤에는 다시 걸리지 않습니다.
  #resetLegacyIdentity() {
    const legacy = this.store.db.prepare(`
      SELECT 1 FROM sessions
      WHERE provider = 'gemini' AND session_id NOT LIKE 'gemini-%' LIMIT 1
    `).get();
    if (!legacy) return false;
    this.store.transaction(() => {
      for (const table of ['usage_events', 'sessions', 'turns', 'provider_scan_state']) {
        this.store.db.prepare(`DELETE FROM ${table} WHERE provider = 'gemini'`).run();
      }
    });
    this.status.identityResets += 1;
    return true;
  }

  async detect() {
    this.activeRoots = await detectGeminiRoots(this.projectRoots);
    this.status.detected = this.activeRoots.length > 0;
    this.status.ledgerAvailable = this.status.detected;
    if (!this.status.detected) return false;
    this.#resetLegacyIdentity();

    // 색인은 reconcile 마다 다시 읽습니다 — 프로젝트가 추가되면 항목이 생기고,
    // 그때 이름이 풀려야 합니다.
    const bySlug = new Map();
    const byPathHash = new Map();
    for (const home of this.geminiHomes) {
      const index = await readGeminiProjectIndex(home);
      for (const [slug, projectPath] of index.bySlug) {
        // 홈이 여럿이고 같은 슬러그가 서로 다른 경로를 가리키면 모호합니다.
        if (bySlug.has(slug) && bySlug.get(slug) !== projectPath) bySlug.set(slug, null);
        else bySlug.set(slug, projectPath);
      }
      for (const [hash, projectPath] of index.byPathHash) byPathHash.set(hash, projectPath);
    }
    this.projectIndex = { bySlug, byPathHash };
    this.status.projectsIndexed = [...bySlug.values()].filter(Boolean).length;
    return true;
  }

  async discoverFiles() {
    const groups = await Promise.all(this.activeRoots.map((root) => discoverGeminiSessions(root)));
    const files = [...new Set(groups.flat())].sort();
    this.status.filesDiscovered = files.length;
    return files;
  }

  #rootFor(filePath) {
    return this.activeRoots.find((root) => !path.relative(root, filePath).startsWith('..')) ?? null;
  }

  async scanFile(filePath, reason = 'reconcile') {
    if (this.scanInFlight.has(filePath)) return this.scanInFlight.get(filePath);
    const task = this.#scanFileInternal(filePath, reason).finally(() => this.scanInFlight.delete(filePath));
    this.scanInFlight.set(filePath, task);
    return task;
  }

  // Codex·Claude 와 같은 준비 → 적재 → 마감 3단계입니다. 다른 점은 포맷이 둘이고
  // 커서 규칙도 둘이라는 것입니다.
  //   line     `.jsonl` — 저장된 바이트 오프셋부터 이어 읽습니다
  //   snapshot `.json`  — 매번 전체를 다시 읽고 내용 해시로 재파싱을 판정합니다
  async prepareScan(filePath) {
    const strategy = geminiFileStrategy(filePath);
    let scanState = this.store.getScanState(this.id, filePath);

    let currentStat;
    try {
      currentStat = await fsp.stat(filePath);
    } catch {
      return { skip: 'missing' };
    }

    let startOffset = strategy === 'line' ? scanState?.byteOffset ?? 0 : 0;
    if (strategy === 'line' && startOffset > currentStat.size) {
      // 절단/교체 → 커서를 버리고 처음부터 안전 재스캔합니다.
      this.store.resetScanState(this.id, filePath);
      scanState = null;
      startOffset = 0;
    }

    const staleParser = scanState && (scanState.parserVersion ?? 0) < GEMINI_PARSER_VERSION;
    const missingTurns = Boolean(scanState) && this.store.hasUnattributedTurns(this.id, filePath);
    if (staleParser || missingTurns) {
      this.status.reparsedFiles += 1;
      scanState = null;
      startOffset = 0;
    }

    if (scanState && scanState.mtimeMs === currentStat.mtimeMs) {
      const readAll = strategy === 'line'
        ? startOffset === currentStat.size
        : scanState.fileSize === currentStat.size;
      if (readAll) return { skip: 'unchanged' };
    }

    const root = this.#rootFor(filePath);
    const projectDirName = geminiProjectDirName(filePath, root);
    const project = resolveGeminiProject(projectDirName, this.projectIndex);
    if (project.resolved) this.status.projectsResolved += 1;
    else this.status.projectsUnresolved += 1;

    // 세션 정체는 경로에서 만듭니다 — 로그의 sessionId 는 파일 간에 유일하지
    // 않습니다(detector.mjs 의 geminiSessionKey 주석). 이 값은 스캔 상태와
    // 무관하게 결정되므로, 커서를 버린 재해석 경로에서도 그대로 쓸 수 있습니다.
    const sessionKey = geminiSessionKey(filePath, root);
    const storedSession = this.store.getSession('gemini', sessionKey);
    const seed = {
      projectDirName,
      project,
      sessionKey,
      session: storedSession,
      // 이어 읽을 때는 마지막 턴 번호를 물려받아야 번호가 되감기지 않습니다.
      // 처음부터 읽으면 1번부터 다시 셉니다.
      turn: startOffset > 0
        ? { index: this.store.getLastTurnIndex('gemini', sessionKey), startedAt: null, compactedPending: false }
        : null,
    };
    const parserState = createGeminiParserState({ filePath, ...seed });
    // 처음부터 다시 읽으면 이 세션의 턴 경계를 지우고 다시 만듭니다.
    //
    // 예전에는 이 조건이 storedSession?.sessionId 에 걸려 있었는데, 바로 위에서
    // 파서 버전업·절단 때 scanState 를 null 로 만들기 때문에 **정작 전량
    // 재해석하는 경로에서 한 번도 실행되지 않았습니다.** 세션 키가 경로에서
    // 나오는 지금은 그 의존이 사라졌습니다.
    if (startOffset === 0) this.store.resetTurns('gemini', sessionKey);

    return {
      strategy,
      startOffset,
      parserState,
      seed,
      knownContentHash: strategy === 'snapshot' ? scanState?.contentHash ?? null : null,
    };
  }

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
            this.store.upsertTurn(event);
            counters.turnEvents += 1;
            counters.changed = true;
          } else if (event.type === 'usage') {
            // 같은 메시지 id 가 여러 파일·여러 줄에 다시 나타납니다(실측
            // .json 298건 / .jsonl 636건). 요청 단위 upsert 로 last-wins 입니다.
            const result = event.eventKey
              ? this.store.upsertUsageEvent(event, filePath, sourceOffset, observedAt)
              : { changed: this.store.insertUsageEvent(event, filePath, sourceOffset, observedAt), inserted: true };
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
      // line 은 이어 읽을 지점, snapshot 은 "여기까지 다 읽었다"는 뜻의 크기.
      byteOffset: result.finalOffset ?? result.fileSize,
      fileSize: result.fileSize,
      mtimeMs: result.mtimeMs,
      // Gemini 는 누적 카운터가 없으므로 이전 누적값을 이어받지 않습니다.
      previousUsage: {},
      sessionId: parserState.session.sessionId,
      parserVersion: GEMINI_PARSER_VERSION,
      contentHash: result.contentHash ?? null,
    });

    const stats = parserState.stats ?? {};
    this.status.identityMismatches += stats.identityMismatches ?? 0;
    this.status.cacheOutsideInput += stats.cacheOutsideInput ?? 0;
    this.status.toolTokensSeen += stats.toolTokensSeen ?? 0;
    this.status.parseErrors += counters.parseErrors;
    this.status.lastScanAt = new Date().toISOString();
    this.status.lastError = null;
    if (counters.changed) {
      this.emit('updated', {
        provider: 'gemini',
        filePath,
        reason,
        usageEvents: counters.usageEvents,
        updatedEvents: counters.updatedEvents,
        turnEvents: counters.turnEvents,
      });
    }
    return { ...counters, finalOffset: result.finalOffset ?? result.fileSize };
  }

  async #scanFileInternal(filePath, reason) {
    const prepared = await this.prepareScan(filePath);
    if (prepared.skip) return { changed: false, reason: prepared.skip };
    return prepared.strategy === 'line'
      ? this.#scanLineFile(filePath, reason, prepared)
      : this.#scanSnapshotFile(filePath, reason, prepared);
  }

  async #scanLineFile(filePath, reason, prepared) {
    const { parserState } = prepared;
    const sink = this.createScanSink(filePath);
    const result = await readCompleteLines(filePath, prepared.startOffset, (line, sourceOffset) => {
      for (const event of parseGeminiLogLine(line, parserState)) sink.push(event, sourceOffset);
    });
    sink.flush();
    if (result.truncated) return this.#scanFileInternal(filePath, `${reason}:truncated`);
    return this.finalizeScan(filePath, parserState, result, reason, sink.counters);
  }

  async #scanSnapshotFile(filePath, reason, prepared) {
    let stat;
    let read;
    try {
      stat = await fsp.stat(filePath);
      read = await readGeminiSessionFile(filePath);
    } catch {
      return { changed: false, reason: 'missing' };
    }

    const result = {
      finalOffset: read.byteLength,
      fileSize: read.byteLength,
      mtimeMs: stat.mtimeMs,
      contentHash: read.contentHash,
    };
    if (prepared.knownContentHash && prepared.knownContentHash === read.contentHash) {
      // 내용이 그대로인 재작성입니다. 커서만 갱신하고 파싱·적재는 건너뜁니다 —
      // 이 포맷에서 가장 비싼 단계가 JSON.parse 입니다.
      this.status.unchangedByHash += 1;
      const empty = { changed: false, usageEvents: 0, updatedEvents: 0, turnEvents: 0, parseErrors: 0 };
      return this.finalizeScan(filePath, prepared.parserState, result, `${reason}:hash-unchanged`, empty);
    }

    const sink = this.createScanSink(filePath);
    for (const entry of withSourceOffsets(parseGeminiSessionFile(read.text, prepared.parserState))) {
      sink.push(entry.event, entry.sourceOffset);
    }
    sink.flush();
    return this.finalizeScan(filePath, prepared.parserState, result, reason, sink.counters);
  }

  async #scanFileWithPool(filePath, reason, pool) {
    const prepared = await this.prepareScan(filePath);
    if (prepared.skip) return { changed: false, reason: prepared.skip };

    const { parserState } = prepared;
    const sink = this.createScanSink(filePath);
    const result = await pool.submit(
      {
        provider: this.id,
        strategy: prepared.strategy,
        filePath,
        startOffset: prepared.startOffset,
        seed: prepared.seed,
        knownContentHash: prepared.knownContentHash,
      },
      (events) => {
        for (const { event, sourceOffset } of events) sink.push(event, sourceOffset);
      },
    );
    sink.flush();

    // 절단이 감지되면 처음부터 다시 읽습니다. 재시도는 인라인 경로로 보냅니다
    // — 이미 워커 한 자리를 쓰고 있어 재귀로 또 잡으면 교착입니다.
    if (result.truncated) return this.#scanFileInternal(filePath, `${reason}:truncated`);
    if (result.skippedParse) this.status.unchangedByHash += 1;
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
      this.emit('error-state', { provider: 'gemini', error: this.status.lastError });
      return { changed: false, error: this.status.lastError };
    }
  }

  // chats 디렉터리만 감시합니다. tmp 아래를 전부 감시하면 프로젝트 수만큼
  // watcher 가 늘고 logs.json 변경까지 신호로 받습니다.
  async refreshWatchers(knownFiles = null) {
    const files = knownFiles ?? await this.discoverFiles();
    const dirs = new Set(files.map((filePath) => path.dirname(filePath)));

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
          const name = filename ? String(filename) : null;
          if (name && (name.endsWith('.json') || name.endsWith('.jsonl'))) {
            const target = path.join(dir, name);
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
    await this.detect();
    if (backfill) {
      await this.reconcile('startup');
      this.startWatching();
    }
    return this.getStatus();
  }

  startWatching() {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => this.reconcile('interval'), this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

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
        failures += 1;
        this.status.lastError = String(error?.message ?? error);
        this.emit('error-state', { provider: 'gemini', error: this.status.lastError });
      } finally {
        done += 1;
        onProgress?.({ detected: true, filesTotal: files.length, filesDone: done });
      }
    };

    // 턴 번호는 세션 단위 상태입니다. 파일 이름만으로는 sessionId 를 알 수
    // 없으므로 같은 chats 디렉터리를 한 줄로 세웁니다 — resume 사본은 같은
    // 디렉터리에 생깁니다.
    const byDir = new Map();
    for (const filePath of files) {
      const key = path.dirname(filePath);
      if (!byDir.has(key)) byDir.set(key, []);
      byDir.get(key).push(filePath);
    }

    await Promise.all([...byDir.values()].map(async (group) => {
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

  getStatus() {
    return { ...this.status, watcherCount: this.watchers.size, activeRoots: this.activeRoots };
  }
}
