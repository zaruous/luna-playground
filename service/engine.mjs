import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UsageStore } from './store.mjs';
import { CodexCollector } from './providers/codex/collector.mjs';
import { ClaudeCollector } from './providers/claude/collector.mjs';
import { GeminiCollector } from './providers/gemini/collector.mjs';
import { UsageProviderRegistry } from './providers/contracts.mjs';
import { HookServer } from './hook-server.mjs';
import { ScanPool } from './scan-pool.mjs';
// 회계 표는 한 곳에만 둡니다 — 어댑터 capabilities·스토어 쿼리·이 집계가 같은
// 값을 봐야 합니다(service/providers/accounting.mjs).
import { accountingOf, promptSideTokens } from './providers/accounting.mjs';

// snapshot() 은 집계 쿼리 묶음입니다. 백필 중에 파일마다 부르면 스냅샷 쪽이
// 스캔보다 비싸지므로, 진행 알림은 시간으로 조입니다.
const WARMUP_EMIT_INTERVAL_MS = 1000;
const DEFAULT_READY_EMIT_INTERVAL_MS = 1000;

// ready 구간 SSE 는 되감기 때 턴·사용량 이벤트가 연속으로 올라옵니다. 즉시
// 매번 snapshot() 을 부르면 집계가 스캔을 압도하므로 warmup 과 같은 trailing
// 스로틀을 씁니다 — 창 안의 마지막 변경은 반드시 한 번은 나갑니다(R2-b).
export function createTrailingEmitThrottle({
  intervalMs,
  now = () => Date.now(),
  schedule = (fn, delayMs) => setTimeout(fn, delayMs),
  cancelTimer = clearTimeout,
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError('intervalMs is required');
  let lastEmitAt = 0;
  let timer = null;
  let pendingRun = null;

  const clearTimer = () => {
    if (timer != null) {
      cancelTimer(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    const run = pendingRun;
    pendingRun = null;
    if (!run) return false;
    lastEmitAt = now();
    run();
    return true;
  };

  const request = (run) => {
    pendingRun = run;
    const elapsed = now() - lastEmitAt;
    if (elapsed >= intervalMs) {
      flush();
      return;
    }
    clearTimer();
    timer = schedule(() => {
      timer = null;
      flush();
    }, intervalMs - elapsed);
  };

  const cancel = () => {
    clearTimer();
    pendingRun = null;
  };

  return { request, flush, cancel, hasPending: () => pendingRun != null };
}

function emptyWarmupState() {
  return {
    // idle: 아직 시작 안 함 / scanning: 전량 스캔 중 / ready: 끝 / failed: 실패
    phase: 'idle',
    startedAt: null,
    finishedAt: null,
    workers: 0,
    filesTotal: 0,
    filesDone: 0,
    providers: {},
    error: null,
  };
}

function startOfLocalMonthIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString();
}

function reconciliationSummary(rows) {
  const serverOnly = rows.filter((row) => row.classification === 'SERVER_ONLY_CHANGE').length;
  const matched = rows.filter((row) => row.classification === 'MATCHED_ACTIVITY').length;
  const localOnly = rows.filter((row) => row.classification === 'LOCAL_ONLY_ACTIVITY').length;
  let status = 'NO_SERVER_DATA';
  if (rows.length) status = serverOnly ? 'UNATTRIBUTED_SERVER_USAGE' : localOnly ? 'LOCAL_AHEAD_OF_SERVER' : 'SYNCED';
  return { status, serverOnly, matched, localOnly, recent: rows };
}

function sumTokenTotals(providerSnapshots) {
  const totals = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    promptTokens: 0,
    eventCount: 0,
  };
  for (const provider of providerSnapshots) {
    for (const key of Object.keys(totals)) totals[key] += Number(provider.totals?.[key]) || 0;
  }
  totals.cacheRate = totals.promptTokens > 0 ? totals.cachedInputTokens / totals.promptTokens : 0;
  return totals;
}

function flattenQuotaWindows(rateLimits) {
  return (rateLimits?.limits ?? []).flatMap((limit) => Object.values(limit.windows).map((window) => ({
    ...window,
    limitId: limit.limitId,
    limitName: limit.limitName,
  }))).sort((left, right) => {
    const leftMinutes = left.windowMinutes ?? Number.MAX_SAFE_INTEGER;
    const rightMinutes = right.windowMinutes ?? Number.MAX_SAFE_INTEGER;
    return leftMinutes - rightMinutes || left.limitId.localeCompare(right.limitId);
  });
}

export class UsageEngine extends EventEmitter {
  constructor({
    userDataPath,
    codexHome,
    claudeHomes,
    geminiHomes,
    readyEmitIntervalMs = DEFAULT_READY_EMIT_INTERVAL_MS,
    now = Date.now,
    scheduleReadyEmit = (fn, delayMs) => setTimeout(fn, delayMs),
    cancelReadyEmit = clearTimeout,
  } = {}) {
    super();
    this.userDataPath = userDataPath;
    this.store = new UsageStore(path.join(userDataPath, 'usage.sqlite3'));
    this.codex = new CodexCollector({ store: this.store, codexHome });
    this.claude = new ClaudeCollector({
      store: this.store,
      ...(claudeHomes ? { claudeHomes } : {}),
    });
    this.gemini = new GeminiCollector({
      store: this.store,
      ...(geminiHomes ? { geminiHomes } : {}),
    });
    this.providerRegistry = new UsageProviderRegistry({ adapters: [this.codex, this.claude, this.gemini] });
    this.hookServer = new HookServer({ onSignal: (payload) => this.routeHookSignal(payload) });
    this.started = false;
    this.resetting = false;
    this.warmup = emptyWarmupState();
    this.warmupTask = null;
    this.warmupPool = null;
    this.lastWarmupEmitAt = 0;
    this.readyEmitThrottle = createTrailingEmitThrottle({
      intervalMs: readyEmitIntervalMs,
      now,
      schedule: scheduleReadyEmit,
      cancelTimer: cancelReadyEmit,
    });
    this.lastHookAt = new Map();
    this.providerRegistry.on('updated', (event) => this.#emitUpdate(event));
    this.providerRegistry.on('hook', (event) => {
      this.lastHookAt.set(event.provider, new Date().toISOString());
    });
    this.providerRegistry.on('error-state', (event) => this.#emitUpdate(event));
  }

  // provider 마다 hook 설정 경로는 다르지만 우리 쪽 수신 소켓은 하나입니다.
  // 그래서 어떤 수집기를 깨울지 골라야 합니다. 우리가 설치한 hook 스크립트는
  // provider 를 적어 보내지만, 사용자가 손으로 넣은 hook 이면 그 필드가 없을
  // 수 있습니다. 그럴 땐 transcript 경로로 유추하고, 그래도 모르면 모든
  // 수집기를 깨웁니다 — hook 은 가속 신호일 뿐이고 한 번 더 재스캔해도
  // 중복 제거가 흡수하기 때문입니다.
  #adaptersForHook(payload = {}) {
    const declared = typeof payload.provider === 'string' ? payload.provider.trim().toLowerCase() : null;
    if (declared) {
      const adapter = this.providerRegistry.get(declared);
      if (adapter?.handleHookSignal) return [adapter];
    }
    const transcriptPath = String(payload.transcript_path ?? payload.transcriptPath ?? '');
    const inferred = this.providerRegistry.list().filter((adapter) => (
      adapter.handleHookSignal && transcriptPath.includes(`.${adapter.id}`)
    ));
    if (inferred.length) return inferred;
    return this.providerRegistry.list().filter((adapter) => adapter.handleHookSignal);
  }

  async routeHookSignal(payload = {}) {
    for (const adapter of this.#adaptersForHook(payload)) {
      await adapter.handleHookSignal(payload);
    }
  }

  // warmup: 'blocking' 이면 전량 스캔이 끝난 뒤에 돌아옵니다(테스트·CLI 기본).
  // 'background' 면 감지까지만 하고 즉시 돌아오며, 전량 스캔은 워커 풀에서
  // 이어집니다 — 서버가 화면을 먼저 띄우기 위한 경로입니다.
  async start({ warmup = 'blocking' } = {}) {
    if (this.started) return this.snapshot();
    await this.hookServer.start();
    if (warmup === 'background') {
      await this.providerRegistry.startAll({ backfill: false });
      this.started = true;
      this.warmupTask = this.#runWarmup();
      return this.snapshot();
    }
    await this.providerRegistry.startAll();
    this.started = true;
    this.warmup = {
      ...emptyWarmupState(),
      phase: 'ready',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    return this.snapshot();
  }

  async stop() {
    // 풀을 먼저 닫습니다. 진행 중인 백필은 submit 이 실패하며 파일 단위로
    // 정리되고, 그래서 스토어를 닫기 전에 적재가 모두 멈춥니다.
    await this.#quiesce();
    await this.hookServer.stop();
    this.store.close();
    this.started = false;
  }

  // 적재를 멈추되 스토어는 열어 둡니다. stop() 과 초기화가 공유하는 부분이고,
  // 초기화는 원장을 비운 뒤 다시 스캔해야 하므로 연결을 닫을 수 없습니다.
  async #quiesce() {
    this.readyEmitThrottle.cancel();
    await this.warmupPool?.close().catch(() => {});
    this.warmupPool = null;
    this.providerRegistry.stopAll();
    await this.warmupTask?.catch(() => {});
    this.warmupTask = null;
  }

  #backupDir() {
    return path.join(this.userDataPath, 'backups');
  }

  listBackups() {
    let names = [];
    try {
      names = fs.readdirSync(this.#backupDir());
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith('.sqlite3'))
      .map((name) => {
        const full = path.join(this.#backupDir(), name);
        try {
          const stat = fs.statSync(full);
          return { name, path: full, sizeBytes: stat.size, createdAt: new Date(stat.mtimeMs).toISOString() };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  // 백업은 서비스가 만듭니다. 브라우저가 파일을 쓸 수 없고, 쓸 수 있게 하면
  // 클라이언트에 파일시스템 권한을 주는 셈이라 보안 경계가 무너집니다.
  createBackup() {
    fs.mkdirSync(this.#backupDir(), { recursive: true });
    // `VACUUM INTO` 는 이미 있는 파일에 쓰지 않고 던집니다. 초 단위 이름이면
    // 같은 초에 두 번 백업하는 것만으로 실패하고, 초기화 경로에서는 그 실패가
    // 초기화까지 막습니다(안전한 방향이지만 이유를 알 수 없는 실패입니다).
    // 그래서 밀리초까지 넣고, 그래도 겹치면 번호를 붙입니다 — 덮어쓰기는
    // 하지 않습니다. 백업을 지우는 판단은 사람이 합니다.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace(/Z$/, '');
    let name = `usage-${stamp}.sqlite3`;
    let full = path.join(this.#backupDir(), name);
    for (let suffix = 2; fs.existsSync(full); suffix += 1) {
      name = `usage-${stamp}-${suffix}.sqlite3`;
      full = path.join(this.#backupDir(), name);
    }
    this.store.backupTo(full);
    const stat = fs.statSync(full);
    return { name, path: full, sizeBytes: stat.size, createdAt: new Date(stat.mtimeMs).toISOString() };
  }

  dataStatus() {
    return {
      diagnostics: this.store.getDiagnostics(),
      backupDir: this.#backupDir(),
      backups: this.listBackups(),
      // 백업 파일에는 가리지 않은 원본 경로가 들어 있습니다. 화면이 이 사실을
      // 적어야 하므로 서버가 함께 알려 줍니다.
      backupContainsRawPaths: true,
    };
  }

  // 원장을 비우고 처음부터 다시 잽니다. 로컬 로그가 원본이므로 재측정이
  // 가능하고, 그래서 이 동작은 "데이터를 버리는" 것이 아니라 "파생값을 다시
  // 만드는" 것입니다 — 다만 로그가 이미 지워진 구간은 돌아오지 않습니다.
  async resetData({ keepAliases = true, backupFirst = true } = {}) {
    if (this.resetting) throw new Error('초기화가 이미 진행 중입니다');
    this.resetting = true;
    try {
      // 백업이 실패하면 **비우지 않습니다.** 순서가 안전성 전체입니다.
      const backup = backupFirst ? this.createBackup() : null;
      await this.#quiesce();
      const cleared = this.store.clearLedger({ keepAliases });
      this.warmup = emptyWarmupState();
      await this.providerRegistry.startAll({ backfill: false });
      this.warmupTask = this.#runWarmup();
      this.#emitUpdate({ type: 'reset' });
      return { backup, cleared, keptAliases: keepAliases, warmup: this.warmupState() };
    } finally {
      this.resetting = false;
    }
  }

  async #runWarmup() {
    const pool = new ScanPool();
    this.warmupPool = pool;
    this.warmup = {
      ...emptyWarmupState(),
      phase: 'scanning',
      startedAt: new Date().toISOString(),
      workers: pool.size,
    };
    this.#emitWarmup(true);

    try {
      // provider 끼리는 서로 독립이라 같이 돌립니다. 실제 동시 실행 수는 풀이
      // 잡아 줍니다. 한쪽이 실패해도 다른 쪽은 계속 채웁니다.
      await Promise.all(this.providerRegistry.list().map(async (adapter) => {
        try {
          await adapter.backfill('startup', {
            pool,
            onProgress: (progress) => this.#onWarmupProgress(adapter.id, progress),
          });
        } catch (error) {
          this.warmup.providers[adapter.id] = {
            ...(this.warmup.providers[adapter.id] ?? { detected: true, filesTotal: 0, filesDone: 0 }),
            error: String(error?.message ?? error),
          };
        }
      }));
      this.warmup.phase = 'ready';
    } catch (error) {
      this.warmup.phase = 'failed';
      this.warmup.error = String(error?.message ?? error);
    } finally {
      this.warmup.finishedAt = new Date().toISOString();
      this.warmupPool = null;
      await pool.close().catch(() => {});
      // 주기 reconcile 은 이제야 켭니다 — 백필과 겹치면 서로를 밀어냅니다.
      for (const adapter of this.providerRegistry.list()) adapter.startWatching?.();
      this.#emitWarmup(true);
    }
  }

  #onWarmupProgress(providerId, progress = {}) {
    this.warmup.providers[providerId] = {
      ...(this.warmup.providers[providerId] ?? {}),
      detected: Boolean(progress.detected),
      filesTotal: Number(progress.filesTotal) || 0,
      filesDone: Number(progress.filesDone) || 0,
    };
    let filesTotal = 0;
    let filesDone = 0;
    for (const entry of Object.values(this.warmup.providers)) {
      filesTotal += Number(entry.filesTotal) || 0;
      filesDone += Number(entry.filesDone) || 0;
    }
    this.warmup.filesTotal = filesTotal;
    this.warmup.filesDone = filesDone;
    this.#emitWarmup(false);
  }

  #emitWarmup(force) {
    const now = Date.now();
    if (!force && now - this.lastWarmupEmitAt < WARMUP_EMIT_INTERVAL_MS) return;
    this.lastWarmupEmitAt = now;
    this.emit('snapshot', this.snapshot(), { type: 'warmup' });
  }

  warmupState() {
    return { ...this.warmup, providers: { ...this.warmup.providers } };
  }

  async rescan() {
    await this.providerRegistry.reconcileAll('manual');
    const snapshot = this.snapshot();
    this.emit('snapshot', snapshot);
    return snapshot;
  }

  // 기간 기본값은 스냅샷과 같은 로컬 월 경계를 씁니다. REST 응답과
  // 대시보드 총합이 서로 다른 기준으로 끊기면 안 됩니다.
  defaultSince() {
    return startOfLocalMonthIso();
  }

  snapshot() {
    const since = startOfLocalMonthIso();
    const providers = this.providerRegistry.describe().map((definition) => {
      const tokenAccounting = definition.capabilities?.tokenAccounting ?? accountingOf(definition.id);
      const decorate = (totals) => ({ ...totals, promptTokens: promptSideTokens(definition.id, totals) });
      const totals = decorate(this.store.getProviderTotals(definition.id, since));
      const rateLimits = this.store.getLatestRateLimits(definition.id);
      return {
        ...definition,
        tokenAccounting,
        totals,
        allTimeTotals: decorate(this.store.getProviderTotals(definition.id)),
        // 품질은 UI 장식이 아니라 데이터입니다. 필드별 등급과 등급별 건수를
        // 함께 실어 "합계는 추정, 캐시 읽기는 로컬 관측" 같은 혼합 상태를
        // 그대로 표시할 수 있게 합니다(R2).
        quality: this.store.getProviderQuality(definition.id, since),
        rateLimits,
        quotaWindows: flattenQuotaWindows(rateLimits),
        hook: {
          socketActive: Boolean(definition.capabilities?.hooks) && Boolean(this.hookServer.server),
          lastHookAt: this.lastHookAt.get(definition.id) ?? null,
        },
        reconciliation: reconciliationSummary(this.store.getRecentReconciliation(definition.id)),
      };
    });
    const totals = sumTokenTotals(providers);
    return {
      generatedAt: new Date().toISOString(),
      period: { type: 'month', since },
      totals,
      providers,
      projects: this.store.getRecentProjectsAcrossProviders(6, since),
      diagnostics: this.store.getDiagnostics(),
      // 전량 스캔이 끝나기 전의 합계는 **부분값**입니다. 화면이 이걸 확정값
      // 처럼 보이게 하면 안 되므로 진행 상태를 스냅샷에 같이 싣습니다.
      warmup: this.warmupState(),
    };
  }

  #emitUpdate(event) {
    // 백필 중에는 파일마다 스냅샷을 만들면 집계 쿼리가 스캔을 압도합니다.
    // 진행 상황은 warmup 경로가 이미 주기적으로 내보냅니다.
    if (this.warmup.phase === 'scanning') {
      this.#emitWarmup(false);
      return;
    }
    // 초기화·오류는 사용자가 즉시 알아야 하므로 스로틀 밖입니다. rescan() 은
    // 이 경로를 거치지 않고 바로 emit 합니다 — 수동 동작이 묵살되면 안 됩니다.
    if (event?.type === 'reset' || event?.type === 'error-state') {
      this.readyEmitThrottle.cancel();
      const snapshot = this.snapshot();
      this.emit('snapshot', snapshot, event);
      return;
    }
    this.readyEmitThrottle.request(() => {
      const snapshot = this.snapshot();
      this.emit('snapshot', snapshot, event);
    });
  }
}
