# HTTP/SSE transport

NyangTracker separates the usage service from its React client. Development mode starts the service on an ephemeral loopback port and injects its connection metadata into the Vite dev page. Standalone mode serves the built React client and API from one process.

## Implementation plan

1. **Transport boundary** — keep the provider registry, engine, and SQLite unchanged; replace renderer-specific IPC calls with a `UsageClient` contract. Completed.
2. **Local service** — expose snapshot/query commands through authenticated REST and engine updates through SSE. Completed.
3. **Development mode** — start the loopback service, inject only its process-scoped connection capability into the Vite dev page, and keep HMR on the shared React client. Completed.
4. **Standalone browser mode** — serve the built client and API from one Node process. Completed.
5. **Remote/multi-device mode** — future work; introduce a workstation collector agent, TLS termination, durable user/device authentication, and server-side tenancy before accepting non-loopback traffic.

## Run modes

```bash
# Loopback usage service + Vite client with HMR
npm run dev

# Build and start the standalone browser service
npm run start:web
```

Standalone defaults to `http://127.0.0.1:47831`. Configuration:

- `NYANG_PORT` — standalone listen port.
- `NYANG_HOST` — listen address; defaults to `127.0.0.1`.
- `NYANG_USER_DATA` — SQLite/user-data directory.
- `NYANG_SCAN_WORKERS` — parse worker count for the historical scan. Unset means
  `min(2, cores - 1)`. The pool floor is 1, so `0` and an empty string both give
  one worker rather than disabling the pool; an explicit value above 2 is honoured
  (the 2 ceiling applies only to the automatic default). Two is the measured knee
  because SQLite stays single-writer and the writer is the floor: over 899 files,
  one worker took 20.0 s, two 17.2 s, four 17.5 s. Raise it only where parsing
  costs more than writing.
- `NYANG_ALLOW_REMOTE=1` — explicit acknowledgement required before binding to a non-loopback address.

`NYANG_ALLOW_REMOTE` is not transport security. Remote deployment additionally requires TLS, an authenticated reverse proxy, restricted origins, and a device/tenant authorization policy.

Only one usage service may run per user: the hook bridge binds a fixed socket, so a second `npm run dev` or `npm run server` exits with a message naming the socket instead of racing the first process for SQLite and hook signals.

## SSE event

```text
id: 12
event: snapshot
data: {"snapshot":{...},"reason":{"type":"manual"}}
```

The server sends:

- `retry: 3000` reconnect guidance;
- one full `snapshot` immediately after connection;
- a new full `snapshot` whenever `UsageEngine` emits an update;
- a heartbeat comment every 20 seconds.

Snapshots are intentionally self-contained. The `id` is a monotonic per-process revision for diagnostics only: the server keeps no event backlog and ignores `Last-Event-ID`, because a reconnecting client immediately receives a full snapshot.

## Security

- `/healthz` exposes liveness only and requires no token.
- `/api/v1/*` requires a random per-process token.
- REST uses `X-Nyang-Access-Token`.
- SSE uses an `access_token` query parameter because the browser `EventSource` API cannot set a custom authorization header.
- Cross-origin access is limited to the Vite development origin (`http://127.0.0.1:5173`, `http://localhost:5173`) and the service's own origin.
- SQLite and provider logs remain inaccessible to the client.

Tokens are process-scoped connection capabilities, not long-lived user credentials. Do not put them in logs or persist them in browser storage.

**Known consequence — restarting the service breaks an open tab.** The token is
generated per process, so a tab holding the old one starts getting 401s and its
numbers simply stop moving; nothing on the page says why. Reloading fixes it
because the page is served with a freshly injected token. This is a real defect
rather than a design choice: the client should surface an auth failure as "the
service restarted — reload" instead of going quiet. It is recorded here so the
symptom is not diagnosed as a collection stall.
