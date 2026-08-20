# NyangTracker architecture

NyangTracker is a local-first Electron application that normalizes AI coding-agent usage into a provider-neutral ledger.

## Design goals

1. Keep raw local observations and server observations separate.
2. Never invent token counts to force local data to match a server quota percentage.
3. Make provider-specific collectors replaceable behind a common adapter contract.
4. Keep filesystem, SQLite, hooks, and credentials in the Electron main process.
5. Let the React renderer consume only normalized snapshots through the preload IPC bridge.
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
        Electron IPC
               |
               v
        React dashboard
```

## Provider adapter contract

Each provider should ultimately expose the same logical capabilities even if some implementations are partial.

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

## Realtime model

Realtime responsiveness is intentionally redundant:

1. durable provider log is the source of truth;
2. filesystem watch is the fast path;
3. lifecycle hook is an optional wake-up signal;
4. periodic reconcile repairs missed notifications;
5. app focus/restart performs another reconciliation pass.

This design means the tracker may be closed during an AI session and still catch up when reopened.

## Security boundary

The renderer does not receive arbitrary filesystem access.

```text
React renderer
  X fs
  X child_process
  X direct ~/.codex access

preload
  narrow IPC surface

Electron main
  filesystem watcher
  provider parsers
  SQLite
  hook management
```

Provider auth material should never be copied into renderer state or analytics.

## Persistence

Codex v1 stores data in SQLite under Electron `userData`.

Current tables:

- `sessions`
- `usage_events`
- `server_usage_snapshots`
- `reconciliation_events`
- `scan_state`

The schema is deliberately provider-neutral enough for later adapters.

## UI measurement labels

The dashboard should distinguish data provenance at the number level.

- **서버 검증됨** — reconciled against an authoritative server usage endpoint.
- **서버 관측** — server quota/usage snapshot exists, but not necessarily an exact token ledger.
- **로컬 관측** — parsed from provider-owned local logs.
- **추정** — derived from pricing/tokenizer/other estimation.
- **미확인** — no reliable source currently supports the value.
