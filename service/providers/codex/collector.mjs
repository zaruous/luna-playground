import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CODEX_PARSER_VERSION, createCodexParserState, parseCodexRolloutLine } from './parser.mjs';
import { resolveCodexHome } from '../../utils.mjs';
import { readCompleteLines } from '../jsonl-tail.mjs';
import { UsageProviderAdapter } from '../contracts.mjs';
import { accountingOf } from '../accounting.mjs';
import { applyParserTail } from '../../scan-pool.mjs';

// 한 건씩 커밋하면 백필의 커밋 횟수가 이벤트 수만큼 늘어납니다.
const FLUSH_BATCH_SIZE = 500;

async function walkJsonlFiles(root) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(target);
    }
  }
  await walk(root);
  return files.sort();
}

export class CodexCollector extends UsageProviderAdapter {
  constructor({ store, codexHome = resolveCodexHome(), reconcileIntervalMs = 5000 } = {}) {
    super({
      id: 'codex',
      name: 'Codex',
      measurement: 'local_observed',
      capabilities: {
        localLedger: true,
        serverQuota: true,
        hooks: true,
        // 다음 둘은 어떤 토큰 회계를 쓰는지 밝혀 다른 provider 가 엉뚱한
        // 모델을 재사용하지 않도록 합니다(docs/dev/provider-token-api.md §2).
        // Codex 는 누적 스냅샷을 diff 하고, 캐시 읽기가 input 어에 있습니다.
        accounting: 'cumulative_diff',
        tokenAccounting: accountingOf('codex'),
      },
    });
    this.store = store;
    this.codexHome = codexHome;
    this.sessionsRoot = path.join(codexHome, 'sessions');
    this.archivedRoot = path.join(codexHome, 'archived_sessions');
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.watchers = new Map();
    this.scanInFlight = new Map();
    this.reconcileTimer = null;
    this.status = {
      provider: 'codex',
      detected: false,
      sessionsRoot: this.sessionsRoot,
      watching: false,
      lastScanAt: null,
      lastError: null,
      filesDiscovered: 0,
    };
  }

  async detect() {
    const roots = [this.sessionsRoot, this.archivedRoot];
    const checks = await Promise.all(roots.map(async (root) => {
      try { return (await fsp.stat(root)).isDirectory(); } catch { return false; }
    }));
    this.status.detected = checks.some(Boolean);
    return this.status.detected;
  }

  async discoverFiles() {
    const roots = [this.sessionsRoot, this.archivedRoot];
    const groups = await Promise.all(roots.map((root) => walkJsonlFiles(root)));
    const files = [...new Set(groups.flat())].sort();
    this.status.filesDiscovered = files.length;
    return files;
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
    let previousUsage = scanState?.previousUsage ?? null;

    let currentStat;
    try {
      currentStat = await fsp.stat(filePath);
    } catch {
      return { skip: 'missing' };
    }

    if (startOffset > currentStat.size) {
      this.store.resetScanState(this.id, filePath);
      scanState = null;
      startOffset = 0;
      previousUsage = null;
    }

    // 파서 버전업 시 한 번 다시 해석합니다(Claude 어댑터와 같은 규칙).
    const staleParser = scanState && (scanState.parserVersion ?? 0) < CODEX_PARSER_VERSION;
    // 버전 도장은 찍혔는데 원장에 턴이 안 붙은 경우도 재해석 대상입니다
    // (결함이 있던 중간 버전이 버전만 올려놓은 상황).
    const missingTurns = Boolean(scanState) && this.store.hasUnattributedTurns(this.id, filePath);
    if (staleParser || missingTurns) {
      scanState = null;
      startOffset = 0;
      previousUsage = null;
    }

    if (startOffset === currentStat.size && scanState?.mtimeMs === currentStat.mtimeMs) {
      return { skip: 'unchanged' };
    }

    const storedSession = scanState?.sessionId ? this.store.getSession('codex', scanState.sessionId) : null;
    // 파서 상태는 이 씨앗만으로 결정됩니다. 워커에는 상태가 아니라 씨앗을
    // 보내고, 워커가 같은 상태를 다시 만듭니다.
    const seed = {
      previousUsage,
      session: storedSession,
      // 이어 읽을 때 턴 번호를 물려받습니다(docs/dev/menus/session.md).
      turn: startOffset > 0 && storedSession?.sessionId
        ? { index: this.store.getLastTurnIndex('codex', storedSession.sessionId), startedAt: null, compactedPending: false }
        : null,
    };
    const parserState = createCodexParserState({ filePath, ...seed });
    if (startOffset === 0 && storedSession?.sessionId) {
      this.store.resetTurns('codex', storedSession.sessionId);
    }
    return { startOffset, parserState, seed };
  }

  // 이벤트를 모아 트랜잭션으로 한 번에 넣습니다. 도착 순서를 그대로 지켜야
  // 세션·턴이 그 뒤의 사용량보다 먼저 들어갑니다.
  createScanSink(filePath) {
    const counters = { changed: false, usageEvents: 0, rateSnapshots: 0, turnEvents: 0, parseErrors: 0 };
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
            if (this.store.insertUsageEvent(event, filePath, sourceOffset, observedAt)) {
              counters.changed = true;
              counters.usageEvents += 1;
            }
          } else if (event.type === 'rate_limits') {
            const inserted = this.store.insertRateLimits(event, filePath, sourceOffset, observedAt);
            if (inserted.length) {
              counters.changed = true;
              counters.rateSnapshots += inserted.length;
            }
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
      previousUsage: parserState.previousUsage,
      sessionId: parserState.session.sessionId,
      parserVersion: CODEX_PARSER_VERSION,
    });

    this.status.lastScanAt = new Date().toISOString();
    this.status.lastError = null;
    if (counters.changed) {
      this.emit('updated', {
        provider: 'codex',
        filePath,
        reason,
        usageEvents: counters.usageEvents,
        rateSnapshots: counters.rateSnapshots,
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
      for (const event of parseCodexRolloutLine(line, parserState)) sink.push(event, sourceOffset);
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
      await this.refreshWatchers();
      this.status.lastScanAt = new Date().toISOString();
      this.status.lastError = null;
      return { changed, files: files.length };
    } catch (error) {
      this.status.lastError = String(error?.message ?? error);
      this.emit('error-state', { provider: 'codex', error: this.status.lastError });
      return { changed: false, error: this.status.lastError };
    }
  }

  async refreshWatchers() {
    const dirs = new Set();
    for (const root of [this.sessionsRoot, this.archivedRoot]) {
      async function walk(current) {
        let entries;
        try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
        dirs.add(current);
        for (const entry of entries) if (entry.isDirectory()) await walk(path.join(current, entry.name));
      }
      await walk(root);
    }

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
        // Periodic reconciliation remains the reliability fallback.
      }
    }
    this.status.watching = this.watchers.size > 0;
  }

  async start({ backfill = true } = {}) {
    // detect 는 stat 두 번이라 즉시 끝납니다. 전량 스캔을 미루더라도 "로그가
    // 있다"는 사실은 화면이 바로 알아야 합니다.
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
  // 여기서 합니다. Codex 는 파일 하나가 세션 하나라서 파일을 그냥 병렬로
  // 돌려도 세션 상태가 겹치지 않습니다.
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

    await Promise.all(files.map(async (filePath) => {
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
        this.emit('error-state', { provider: 'codex', error: this.status.lastError });
      } finally {
        done += 1;
        onProgress?.({ detected: true, filesTotal: files.length, filesDone: done });
      }
    }));

    await this.refreshWatchers();
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

  async handleHookSignal(payload = {}) {
    const transcriptPath = payload.transcript_path ?? payload.transcriptPath ?? null;
    if (transcriptPath && transcriptPath.endsWith('.jsonl')) {
      await this.scanFile(transcriptPath, `hook:${payload.hook_event_name ?? payload.event ?? 'unknown'}`);
    } else {
      await this.reconcile(`hook:${payload.hook_event_name ?? payload.event ?? 'unknown'}`);
    }
    this.emit('hook', payload);
  }

  getStatus() {
    return { ...this.status, watcherCount: this.watchers.size };
  }
}
