# Provider adapter contract

NyangTracker keeps provider-native parsing outside the shared aggregation and renderer layers. Every connected AI tool is registered through `UsageProviderRegistry` and writes the same normalized event shapes to `UsageStore`.

## Runtime adapter

An adapter extends `UsageProviderAdapter` and provides:

```js
class ProviderAdapter extends UsageProviderAdapter {
  async start() {}
  stop() {}
  async reconcile(reason) {}
  getStatus() {}
}
```

The base metadata declares:

- stable `id` and display `name`;
- measurement provenance such as `local_observed`;
- capabilities for local ledger, server quota, and optional hooks.

Adapters emit only `updated`, `hook`, and `error-state` lifecycle events. The registry forwards them with the provider ID, owns start/stop/reconcile fan-out, and supplies connected/planned provider metadata to the engine.

## Normalized local usage event

```js
{
  type: 'usage',
  provider: 'codex',
  eventTimestamp: '2026-08-20T10:00:00.000Z',
  session: {
    provider: 'codex',
    sessionId: '...',
    cwd: '...',
    projectName: '...',
    model: '...'
  },
  delta: {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  },
  measurementSource: 'local_log',
  measurementQuality: 'local_exact'
}
```

Provider parsers decide whether their native source is cumulative or already per-request. The store receives deltas only. Unsupported token categories remain zero; uncertain fields lower `measurementQuality` instead of being invented.

## Normalized server quota event

```js
{
  type: 'rate_limits',
  provider: 'codex',
  rateLimits: {
    limitId: 'codex',
    limitName: 'Codex',
    primary: { usedPercent: 20, windowMinutes: 300, resetsAt: 0 },
    secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: 0 }
  }
}
```

The durable history identity is `(provider, limit_id, window_type, window_minutes)`. `primary` and `secondary` are transport lane names, not product labels. The latest display lane is selected per `(provider, limit_id, window_type)`, while reconciliation never compares different window lengths. UI labels are derived from `windowMinutes`, so a 10080-minute primary lane is displayed as weekly rather than five-hour usage.

Quota percentages remain a server ledger. They are never converted into token totals.

## Deduplication

Each local event has a stable provider event key when the source supplies enough identity. The shared store also checks the normalized session/timestamp/model/token tuple so an active log copied into an archive path is not counted twice.

Provider scan cursors are keyed by `(provider, source_path)`. A later adapter can therefore reuse a path without colliding with another provider.

## Snapshot contract

The engine emits one entry per catalog provider, connected or planned:

```js
{
  id,
  name,
  integration,
  measurement,
  capabilities,
  totals,
  allTimeTotals,
  rateLimits,
  quotaWindows,
  collector,
  reconciliation
}
```

Top-level monthly totals are the sum of every provider entry. The renderer renders these snapshots without provider-specific token calculations.

## Adapter order

1. Codex rollout JSONL and server quota snapshots.
2. Claude Code transcript usage with stable message/request dedupe.
3. Cursor local attribution plus official organization usage where available.
4. Gemini CLI session usage including thoughts/reasoning categories.

Private web scraping and undocumented quota-to-token conversion are outside this contract.
