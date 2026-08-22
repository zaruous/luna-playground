# Provider adapter contract

NyangTracker keeps provider-native parsing outside the shared aggregation and client layers. Every connected AI tool is registered through `UsageProviderRegistry` and writes the same normalized event shapes to `UsageStore`.

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
    toolTokens: 0,
    totalTokens: 0
  },
  eventKey: 'codex|<session>|<timestamp>|<model>|<identity token fields>',
  cumulative: { totalTokens: 0 },
  cumulativeReset: false,
  incrementSource: 'last_token_usage',
  measurementSource: 'local_log',
  measurementQuality: 'local_exact',

  // structural metadata (M8) — which turn this request belongs to, and which
  // tools the turn called before it. Tool names only; never their arguments.
  turnIndex: 0,
  toolCounts: { read_file: 2 },
  touchedPaths: ['service/store.mjs'],

  // provenance of the record itself
  fieldQuality: { outputTokens: 'exact', reasoningTokens: 'missing' },
  parserVersion: 2,
  requestId: null
}
```

`turnIndex` 0 is the **unattributed bucket**, not "the first turn": usage seen
before any turn boundary stays there instead of being folded into a neighbouring
turn. `toolCounts` and `touchedPaths` carry names and the last two path segments
only — enough to classify a phase, not enough to reconstruct the work.

`fieldQuality` grades fields individually rather than grading the record, so a
record with a trustworthy total and an unverifiable `reasoningTokens` reports
exactly that. A field the provider does not supply is **absent from the map**,
which is how the client tells "not provided" from "measured zero".

`parserVersion` records which parser wrote the row, so a later format change can
select what to re-read. Reinterpretation triggers on the version **or** on ledger
state (`hasUnattributedTurns`): a defective interim version that stamped the
version but failed to write the metadata would otherwise stay empty forever.

### Turn boundary event

Boundaries are a separate event type, because a boundary is a fact about the
conversation's shape while usage is a fact about a request:

```js
{
  type: 'turn',
  provider: 'codex',
  sessionId: '...',
  turnIndex: 1,
  startedAt: '2026-08-20T10:00:00.000Z',
  compacted: false,
  parserVersion: 2
}
```

The `turns` table stores boundaries and **no tokens.** Per-turn totals are
derived by grouping `usage_events` on `turn_index`, so an incremental tail that
splits a turn, or a resumed session that replays it, cannot double-count — the
ledger's own deduplication is the only thing that has to be right. `compacted`
is set only where the log actually marks compaction; Gemini's formats carry no
such marker, so its turn rows never claim it.

`incrementSource` records how the delta was derived — `last_token_usage`, `cumulative_delta` or `initial_cumulative` for Codex — and `cumulativeReset` marks a counter reset so downstream code never books a full reset total as usage. A fork keeps its parent session identity in `eventKey` so the same turn is not counted twice. Parsers may carry extra provider context on the event — Codex adds `contextWindow` — which the store currently ignores rather than persisting.

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

A cursor is one of two kinds, and the kind belongs to the **file** rather than
the provider — Gemini writes both:

| Kind | Resume rule | Cursor field |
|---|---|---|
| append-only log | read on from the stored byte offset | `byteOffset` |
| whole-document snapshot | `mtime` + size first, then compare the content hash | `contentHash` |

For a snapshot file `byteOffset` holds the file size — it marks "read this far",
not a place to resume from; the hash is what decides. An unchanged rewrite skips
`JSON.parse` entirely, which is the expensive step for that format.

## Snapshot contract

The engine emits one entry per catalog provider, connected or planned:

```js
{
  id,
  name,
  order,
  integration,
  measurement,
  capabilities,
  totals,
  allTimeTotals,
  rateLimits,
  quotaWindows,
  collector,
  hook,
  reconciliation
}
```

`order` fixes the catalog display sequence and `hook` reports bridge liveness (`socketActive`, `lastHookAt`) rather than usage. Planned providers appear with `integration: 'planned'`, `measurement: null` and zeroed totals so the client needs no separate catalog.

The snapshot envelope wraps those entries:

```js
{
  generatedAt,
  period: { type: 'month', since },
  warmup: { phase, filesTotal, filesDone, providers, startedAt, finishedAt, error },
  totals,
  providers,
  projects,
  diagnostics
}
```

`warmup.phase` is `idle` / `scanning` / `ready` / `failed`. It is in the snapshot
rather than a log line because the client cannot otherwise tell an empty ledger
from one that has not been read yet, and printing 0 for the month during the
first scan reads as the user's own usage.

`totals` is the sum of every provider entry for the current local month, `projects` carries the six most recent cross-provider projects, and `diagnostics` exposes the SQLite path plus row counters (sessions, usage events, rate snapshots, scanned files, cumulative resets). The client renders these snapshots without provider-specific token calculations.

## Adapter order

1. Codex rollout JSONL and server quota snapshots. **Implemented.**
2. Claude Code transcript usage with stable message/request dedupe. **Implemented.**
3. Gemini CLI session usage including thoughts/reasoning categories. **Implemented.**
4. Cursor local attribution plus official organization usage where available.

Gemini moved ahead of Cursor during implementation. The three file-tailing
adapters share the same infrastructure, whereas Cursor is the only one needing
an authenticated server API — credential storage, rate limiting and a
time-window cursor — so grouping it last kept that new infrastructure out of the
three adapters that did not need it.

Private web scraping and undocumented quota-to-token conversion are outside this contract.
