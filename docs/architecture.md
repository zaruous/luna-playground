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
          v
     Usage Engine
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
- `GET /api/v1/diagnostics` — non-secret service diagnostics.
- `GET|POST|DELETE /api/v1/providers/codex/hooks` — inspect, install, or remove NyangTracker hooks.
- `GET /healthz` — minimal unauthenticated liveness check.

Every `/api/v1` request requires the process-generated access token. REST sends it in `X-Nyang-Access-Token`; browser `EventSource` sends it as the `access_token` query parameter. SSE events contain complete snapshots, so reconnecting clients do not need to replay every missed delta.

## Provider adapter contract

Each connected provider extends `UsageProviderAdapter` and is owned by `UsageProviderRegistry`. The executable lifecycle contract is:

- `start()` — detect, import history, and start incremental observation.
- `stop()` — release watchers, timers, and provider resources.
- `reconcile(reason)` — repair missed local/server observations.
- `getStatus()` — expose non-sensitive collector health.

Adapters emit `updated`, `hook`, and `error-state`. Provider-specific scanner implementations may additionally expose the following internal capabilities:

- `detect()` — determine whether the provider is installed/configured.
- `scanHistorical()` — discover and import durable historical usage.
- `scanIncremental()` — read only data appended since the last persisted offset/cursor.
- `watch()` — wake the collector when provider state changes.
- `parse()` — normalize provider-native records into common token fields.
- `reconcile()` — compare local activity with any available server-side anchor.
- `installHooks()` / `uninstallHooks()` — optional acceleration path, never a source of truth.

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
5. app focus/restart performs another reconciliation pass;
6. the engine publishes a normalized snapshot to all connected SSE clients.

This design means the tracker may be closed during an AI session and still catch up when reopened.

## Security boundary

The renderer does not receive arbitrary filesystem access.

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
- `server_usage_snapshots`
- `reconciliation_events`
- `provider_scan_state`

Usage events carry a stable `event_key` when possible. Server snapshots carry a `snapshot_key`; current display lanes are grouped by `(provider, limit_id, window_type)`, while reconciliation history also includes `window_minutes`. The legacy `scan_state` table is retained only as a migration source for existing Codex installations.

The schema is deliberately provider-neutral enough for later adapters.

## UI measurement labels

The dashboard should distinguish data provenance at the number level.

- **서버 검증됨** — reconciled against an authoritative server usage endpoint.
- **서버 관측** — server quota/usage snapshot exists, but not necessarily an exact token ledger.
- **로컬 관측** — parsed from provider-owned local logs.
- **추정** — derived from pricing/tokenizer/other estimation.
- **미확인** — no reliable source currently supports the value.
