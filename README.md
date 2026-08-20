# NyangTracker 🐈‍⬛

A local-first AI usage tracker with cat skins, built with Electron + React + Vite.

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
- Electron IPC live updates
- Black, white, gray, orange and calico cat themes

## Development

Requires Node.js 24+.

```bash
npm install
npm test
npm run dev
```

Build the renderer with:

```bash
npm run build
```

More implementation details are in [`docs/codex-usage.md`](docs/codex-usage.md).
