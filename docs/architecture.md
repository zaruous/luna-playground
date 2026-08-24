# NyangTracker architecture

NyangTracker is a local-first usage service with a React client. Development mode and standalone mode start the same HTTP/SSE service; only the way the client is served differs.

## Design goals

1. Keep raw local observations and server observations separate.
2. Never invent token counts to force local data to match a server quota percentage.
3. Make provider-specific collectors replaceable behind a common adapter contract.
4. Keep filesystem, SQLite, hooks, and provider credentials in the service process.
5. Let clients consume only normalized snapshots and narrow commands through authenticated HTTP/SSE.
6. Recover from missed realtime events by replaying durable provider logs.

## Runtime layers

```text
Provider files / APIs / hooks
          |
          v
  Provider Adapter
  - detect
  - historical scan
  - incremental scan
  - parse / normalize
  - reconcile trigger
          |
          +--> Scan Pool (worker_threads)
          |    - read + parse only, never the store
          |    - strategy chosen per FILE, keyed provider:strategy
          |    - streams batches back mid-file
          v
     Usage Engine   <-- the only SQLite writer
          |
    +-----+----------------+
    |                      |
    v                      v
Local Usage Ledger   Server Snapshots
    |                      |
    +----------+-----------+
               v
        Reconciliation
               |
               v
          Aggregation
               |
               v
       HTTP API + SSE
               |
               v
        React dashboard
        - Vite dev server (development)
        - service-served build (standalone)
```

## Client transport contract

REST handles request/response operations and SSE carries server-to-client updates:

- `GET /api/v1/snapshot` — current normalized snapshot.
- `GET /api/v1/events` — `snapshot` SSE events, including an immediate full snapshot and heartbeat comments.
- `POST /api/v1/rescan` — request provider reconciliation.
- `GET /api/v1/diagnostics` — SQLite path and store row counters; no provider content.
- `GET /api/v1/sessions` — session ranking for the selected period.
- `GET /api/v1/sessions/:sessionId/flow` — one session's turn ledger, phase split and context curve.
- `GET /api/v1/usage/timeseries` — token categories per time bucket and provider.
- `GET /api/v1/usage/models` — per-model totals and share.
- `GET /api/v1/projects` — project breakdown.
- `GET /api/v1/projects/:projectKey` — one project's sessions and totals.
- `PUT /api/v1/projects/:projectKey/alias` — display alias and path redaction.
- `GET /api/v1/quota/history` — server quota snapshots over time; percent only.
- `GET|POST|DELETE /api/v1/providers/:provider/hooks` — inspect, install, or remove NyangTracker hooks for one provider.
- `GET /healthz` — minimal unauthenticated liveness check.

### Period parameters

Every route that takes a period resolves it through one helper, so the default
and the escape hatch cannot drift apart per route:

- `since` — ISO instant. Omitting it means **the current local month**, not all
  time. That default is a guard: it stops a client from sweeping the whole
  ledger by accident.
- `all=1` — explicit all-time flag. It wins over any `since` sent with it.

The flag exists because omitting `since` cannot express all time. The transport
drops `null` query parameters, so a client asking for all time by sending
`since: null` sent no period at all and the server answered with its month
default — the screen said "all time" and showed one month.
`test/period-all-time.test.mjs` pins the server default, the flag and the
transport's parameter handling together, because fixing one layer alone lets
them diverge again.

Every `/api/v1` request requires the process-generated access token. REST sends it in `X-Nyang-Access-Token`; browser `EventSource` sends it as the `access_token` query parameter. SSE events contain complete snapshots, so reconnecting clients do not need to replay every missed delta.

## Single service instance

The hook bridge listens on a fixed per-user socket — `\\.\pipe\nyangtracker-usage-hook` on Windows, `<tmpdir>/nyangtracker-<uid>-usage-hook.sock` elsewhere (`service/hook-server.mjs`), so only one usage service can run at a time. A second instance fails fast with a readable message instead of competing for the same SQLite file and hook signals.

## Provider adapter contract

Each connected provider extends `UsageProviderAdapter` and is owned by `UsageProviderRegistry`. The executable lifecycle contract is:

- `start()` — detect, import history, and start incremental observation.
- `stop()` — release watchers, timers, and provider resources.
- `reconcile(reason)` — repair missed local/server observations.
- `getStatus()` — expose non-sensitive collector health.

Adapters emit `updated`, `hook`, and `error-state`. Beyond that contract each collector is free to name its internals; the Codex adapter covers these roles as follows:

- installed/configured detection — `detect()`.
- historical import and incremental tailing — `discoverFiles()` plus `scanFile()`, which resumes from the persisted byte offset instead of re-reading a rollout.
- change wake-up — `refreshWatchers()` for filesystem events and `handleHookSignal()` for hook pings.
- normalization — `parseCodexRolloutLine()` in the provider's own parser module, not on the adapter.
- server-anchor comparison — `reconcile(reason)`.
- health reporting — `getStatus()`.

Hook installation lives outside the adapter in `CodexHookInstaller` (`install()` / `uninstall()` / `status()`), because it edits user configuration rather than collecting usage. Hooks stay an acceleration path, never a source of truth.

## Normalized token fields

The common model preserves provider detail instead of collapsing everything into one total.

- `input_tokens`
- `cached_input_tokens`
- `cache_write_input_tokens`
- `output_tokens`
- `reasoning_tokens`
- `tool_tokens` (reserved for providers such as Gemini)
- `total_tokens`

A provider may leave unsupported fields at zero/null. Provider-specific confidence should be surfaced rather than hidden.

## Trust model

NyangTracker distinguishes three concepts:

### Local observation

Usage directly observed in durable local provider logs. This is suitable for session/project/model attribution but may not represent every server-side activity source.

### Server observation

Quota, usage, or billing data returned by the provider. A percentage quota snapshot is not converted to tokens unless the provider explicitly defines that conversion.

### Reconciliation

The engine correlates local and server movement while preserving unexplained differences. Server-only changes remain unattributed instead of modifying historical local token counts.

## Collection and delivery realtime model

Realtime responsiveness is intentionally redundant:

1. durable provider log is the source of truth;
2. filesystem watch is the fast path;
3. lifecycle hook is an optional wake-up signal;
4. periodic reconcile repairs missed notifications;
5. browser focus/visibility change or a client reload performs another reconciliation pass;
6. the engine publishes a normalized snapshot to all connected SSE clients.

This design means the tracker may be closed during an AI session and still catch up when reopened.

## Security boundary

The browser client does not receive arbitrary filesystem access.

```text
React/browser client
  X fs
  X child_process
  X direct ~/.codex access

HTTP/SSE client
  authenticated snapshot and command contract

usage service process
  filesystem watcher
  provider parsers
  SQLite
  hook management
```

The service binds to `127.0.0.1` by default, checks browser origins, and requires a random capability token. The client receives only the local service URL and the per-process token, injected into the served HTML: standalone mode injects it while serving `dist/index.html`, development mode injects the same configuration through a Vite `transformIndexHtml` hook. The client gets no filesystem access. Provider auth material should never be copied into client state or analytics.

## Persistence

Codex v1 stores data in SQLite under the application user-data directory. The service resolves the platform data directory (`%APPDATA%`, `~/Library/Application Support`, or `$XDG_DATA_HOME`) unless `NYANG_USER_DATA` overrides it.

Current tables:

- `sessions`
- `usage_events`
- `turns` — turn boundaries only, carrying no tokens
- `server_usage_snapshots`
- `reconciliation_events`
- `provider_scan_state`
- `project_aliases` — display alias and path-redaction flag

Usage events carry a stable `event_key` when possible. Server snapshots carry a `snapshot_key`; current display lanes are grouped by `(provider, limit_id, window_type)`, while reconciliation history also includes `window_minutes`. The legacy `scan_state` table is retained only as a migration source for existing Codex installations.

The schema is deliberately provider-neutral enough for later adapters.

### Indexes follow the query, not the column

Aggregation orders and filters on `COALESCE(event_timestamp, observed_at)`, and
deduplication looks up `(provider, source_path, turn_index)`. An index on the
bare columns serves neither, so those are **expression indexes** built over the
same expression the query uses.

The reason is not tidiness. The first scan writes into the table it is also
reading for deduplication, so a dedup lookup that cannot use an index makes the
backfill quadratic: measured 6.345 ms per insert at 18k rows, and a cold start
that spent 35.4 minutes before the port was even bound. With the indexes in
place the same dedup costs 0.128 ms. Deduplication also avoids `OR` in `WHERE` —
SQLite will not use an index for an `OR` spanning different columns, so the two
cases are two indexed statements instead of one convenient query.

## Startup order

The service binds its port **before** the historical scan finishes. A cold start
over a large corpus takes tens of seconds even after the index fix, and a window
that never opens is indistinguishable from a program that failed to start.

`UsageEngine.start({ warmup })` has two modes. `blocking` waits for the whole
scan, which is what tests and one-shot CLI runs want. `background` returns as
soon as the incremental watch is armed and runs the backfill behind it; the web
entrypoints use it.

Progress is part of the snapshot rather than a log line. `snapshot.warmup`
carries `phase` (`idle` / `scanning` / `ready` / `failed`), `filesTotal`,
`filesDone` and per-provider counts, and the engine re-emits it on a throttle
while scanning. The client needs it to tell "nothing has arrived yet" apart from
"measured zero" — see the table at the end of this document.

Parsing runs in a `worker_threads` pool (`service/scan-pool.mjs`), but **the
store stays single-writer on the main thread.** Splitting writes across threads
would let turn numbering and cumulative-diff accounting overwrite each other, so
only the expensive half — reading and JSON parsing — moves off-thread. Because
the writer is the floor, extra producers stop helping quickly: measured over 899
files, one worker took 20.0 s, two 17.2 s, four 17.5 s. The default is two, and
`NYANG_SCAN_WORKERS` raises it for corpora where parsing costs more.

The parse strategy is chosen per **file**, not per provider, because Gemini
writes two formats: `.jsonl` resumes from a byte offset while `.json` is a
whole-document snapshot judged by content hash. A failed worker is discarded
rather than returned to the pool — it may have been mid-file, and its leftover
batches would land in the next job.

## UI measurement labels

The dashboard distinguishes data provenance at the number level. All three
implemented adapters report `local_observed`; the last two labels are reserved
for the server-verified lane and the pricing registry.

- **로컬 관측** — parsed from provider-owned local logs. Implemented.
- **서버 관측** — server quota/usage snapshot exists, but not necessarily an exact token ledger. Implemented.
- **미확인** — no reliable source currently supports the value. Implemented.
- **서버 검증됨** — reconciled against an authoritative server usage endpoint. Reserved.
- **추정** — derived from pricing/tokenizer/other estimation. Reserved.

Provenance is one axis. A number's **absence** is another, and it has three
causes that get three different glyphs, because collapsing them makes the screen
state something it never measured:

| Situation | Shown |
|---|---|
| the value has not arrived from the service yet | `로딩중..` |
| never observed | `—` |
| observed, and the value is zero | `0` |

Writing the first case as the third is the worst of the three: during the
opening scan, "0 tokens this month" reads as the user's own usage.
`measurementPending` in `src/shared.js` decides it from `snapshot.warmup.phase`
plus whether any event has arrived, so a partial total is labelled partial
rather than pending.
