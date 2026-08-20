import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UsageStore } from './store.mjs';
import { CodexCollector } from './providers/codex/collector.mjs';
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

export class UsageEngine extends EventEmitter {
  constructor({ userDataPath, codexHome } = {}) {
    super();
    this.store = new UsageStore(path.join(userDataPath, 'usage.sqlite3'));
    this.codex = new CodexCollector({ store: this.store, codexHome });
    this.hookServer = new HookServer({ onSignal: (payload) => this.codex.handleHookSignal(payload) });
    this.started = false;
    this.lastHookAt = null;
    this.codex.on('updated', (event) => this.#emitUpdate(event));
    this.codex.on('hook', () => { this.lastHookAt = new Date().toISOString(); });
    this.codex.on('error-state', (event) => this.#emitUpdate(event));
  }

  async start() {
    if (this.started) return this.snapshot();
    await this.hookServer.start();
    await this.codex.start();
    this.started = true;
    return this.snapshot();
  }

  async stop() {
    this.codex.stop();
    await this.hookServer.stop();
    this.store.close();
    this.started = false;
  }

  async rescan() {
    await this.codex.reconcile('manual');
    const snapshot = this.snapshot();
    this.emit('snapshot', snapshot);
    return snapshot;
  }

  snapshot() {
    const since = startOfLocalMonthIso();
    const codexTotals = this.store.getProviderTotals('codex', since);
    const allTimeCodex = this.store.getProviderTotals('codex');
    const rateLimits = this.store.getLatestRateLimits('codex');
    const reconciliation = reconciliationSummary(this.store.getRecentReconciliation('codex'));
    const cacheRate = codexTotals.inputTokens > 0 ? codexTotals.cachedInputTokens / codexTotals.inputTokens : 0;
    return {
      generatedAt: new Date().toISOString(),
      period: { type: 'month', since },
      totals: {
        totalTokens: codexTotals.totalTokens,
        inputTokens: codexTotals.inputTokens,
        cachedInputTokens: codexTotals.cachedInputTokens,
        cacheWriteInputTokens: codexTotals.cacheWriteInputTokens,
        outputTokens: codexTotals.outputTokens,
        reasoningTokens: codexTotals.reasoningTokens,
        cacheRate,
      },
      providers: [{
        id: 'codex',
        name: 'Codex',
        measurement: 'local_observed',
        totals: codexTotals,
        allTimeTotals: allTimeCodex,
        rateLimits,
        collector: this.codex.getStatus(),
        hook: { socketActive: Boolean(this.hookServer.server), lastHookAt: this.lastHookAt },
        reconciliation,
      }],
      projects: this.store.getRecentProjects('codex', 6, since),
      diagnostics: this.store.getDiagnostics(),
    };
  }

  #emitUpdate(event) {
    const snapshot = this.snapshot();
    this.emit('snapshot', snapshot, event);
  }
}
