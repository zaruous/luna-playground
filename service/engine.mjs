import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UsageStore } from './store.mjs';
import { CodexCollector } from './providers/codex/collector.mjs';
import { UsageProviderRegistry } from './providers/contracts.mjs';
import { HookServer } from './hook-server.mjs';

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
    eventCount: 0,
  };
  for (const provider of providerSnapshots) {
    for (const key of Object.keys(totals)) totals[key] += Number(provider.totals?.[key]) || 0;
  }
  totals.cacheRate = totals.inputTokens > 0 ? totals.cachedInputTokens / totals.inputTokens : 0;
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
  constructor({ userDataPath, codexHome } = {}) {
    super();
    this.store = new UsageStore(path.join(userDataPath, 'usage.sqlite3'));
    this.codex = new CodexCollector({ store: this.store, codexHome });
    this.providerRegistry = new UsageProviderRegistry({ adapters: [this.codex] });
    this.hookServer = new HookServer({ onSignal: (payload) => this.codex.handleHookSignal(payload) });
    this.started = false;
    this.lastHookAt = new Map();
    this.providerRegistry.on('updated', (event) => this.#emitUpdate(event));
    this.providerRegistry.on('hook', (event) => {
      this.lastHookAt.set(event.provider, new Date().toISOString());
    });
    this.providerRegistry.on('error-state', (event) => this.#emitUpdate(event));
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
      const totals = this.store.getProviderTotals(definition.id, since);
      const rateLimits = this.store.getLatestRateLimits(definition.id);
      return {
        ...definition,
        totals,
        allTimeTotals: this.store.getProviderTotals(definition.id),
        rateLimits,
        quotaWindows: flattenQuotaWindows(rateLimits),
        hook: {
          socketActive: definition.id === 'codex' && Boolean(this.hookServer.server),
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
