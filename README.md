# NyangTracker 🐈‍⬛

A local-first AI usage tracker with cat skins, built with React + Vite on a local Node service.

The current implementation covers **Codex**, **Claude Code**, and **Gemini CLI** adapters. It reads Codex rollout logs, Claude Code transcripts, and Gemini CLI session files, stores token usage in SQLite, observes server rate-limit snapshots when available, and updates the dashboard in near real time. Each provider keeps its own token accounting — cache placement and whether reasoning sits inside output differ per provider, and mixing them silently corrupts derived numbers.

## Measurement model

NyangTracker deliberately keeps three concepts separate:

- **Local observed tokens** — derived from Codex rollout `token_count` records, Claude Code `message.usage` records, and Gemini CLI session `tokens` objects.
- **Server observed quota** — rate-limit snapshots reported by Codex when available. Claude Code transcripts and Gemini CLI session files carry no quota data.
- **Estimated cost** — an API-equivalent estimate, never presented as subscription billing truth.

Local token totals are not force-adjusted to match server quota movement. Unmatched server movement is kept as an attribution signal instead.

## Features

- Historical Codex, Claude Code and Gemini CLI session scan
- Incremental JSONL tailing with saved byte offsets
- Input / cached / cache-write / output / reasoning / total token tracking
- Per-field measurement quality, so an uncertain field is labelled instead of averaged away
- Turn-level attribution: which prompt, and which kind of work (explore / implement / verify), spent the tokens — derived from tool **names** only, never from conversation content
- Project attribution from session cwd
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
