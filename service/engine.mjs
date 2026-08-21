import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UsageStore } from './store.mjs';
import { CodexCollector } from './providers/codex/collector.mjs';
import { ClaudeCollector } from './providers/claude/collector.mjs';
import { UsageProviderRegistry } from './providers/contracts.mjs';
import { HookServer } from './hook-server.mjs';
// 회계 표는 한 곳에만 둡니다 — 어댑터 capabilities·스토어 쿼리·이 집계가 같은
// 값을 봐야 합니다(service/providers/accounting.mjs).
import { accountingOf, promptSideTokens } from './providers/accounting.mjs';

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
  constructor({ userDataPath, codexHome, claudeHomes } = {}) {
    super();
    this.store = new UsageStore(path.join(userDataPath, 'usage.sqlite3'));
    this.codex = new CodexCollector({ store: this.store, codexHome });
    this.claude = new ClaudeCollector({
      store: this.store,
      ...(claudeHomes ? { claudeHomes } : {}),
    });
    this.providerRegistry = new UsageProviderRegistry({ adapters: [this.codex, this.claude] });
    this.hookServer = new HookServer({ onSignal: (payload) => this.routeHookSignal(payload) });
    this.started = false;
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

  async start() {
    if (this.started) return this.snapshot();
    await this.hookServer.start();
    await this.providerRegistry.startAll();
    this.started = true;
    return this.snapshot();
  }

  async stop() {
    this.providerRegistry.stopAll();
    await this.hookServer.stop();
    this.store.close();
    this.started = false;
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
    };
  }

  #emitUpdate(event) {
    const snapshot = this.snapshot();
    this.emit('snapshot', snapshot, event);
  }
}
