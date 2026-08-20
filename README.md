# NyangTracker 🐈‍⬛

A local-first AI usage tracker with cat skins, built with React + Vite on a local Node service.

The current implementation focuses on **Codex Adapter v1**. It reads Codex rollout logs, stores token deltas in SQLite, observes server rate-limit snapshots when available, and updates the dashboard in near real time.

## Measurement model

NyangTracker deliberately keeps three concepts separate:

- **Local observed tokens** — derived from Codex rollout `token_count` records.
- **Server observed quota** — rate-limit snapshots reported by Codex when available.
- **Estimated cost** — an API-equivalent estimate, never presented as subscription billing truth.

Local token totals are not force-adjusted to match server quota movement. Unmatched server movement is kept as an attribution signal instead.

## Features

- Historical Codex session scan
- Incremental JSONL tailing with saved byte offsets
- Input / cached / cache-write / output / reasoning / total token tracking
- Project attribution from Codex session cwd
- 5-hour and weekly rate-limit snapshots
- Local/server reconciliation states
- Optional lifecycle hook integration
- Authenticated local HTTP API with SSE live updates
- Black, white, gray, orange and calico cat themes

## Development

Requires Node.js 24+.

```bash
npm install
npm test
npm run dev
```

`npm run dev` starts the usage service on a loopback port and a Vite dev server at `http://127.0.0.1:5173` with the service connection injected into the page.

Build the client with:

```bash
npm run build
```

Serve the built client and API from one process:

```bash
npm run start:web
# http://127.0.0.1:47831
```

More implementation details are in [`docs/codex-usage.md`](docs/codex-usage.md).
