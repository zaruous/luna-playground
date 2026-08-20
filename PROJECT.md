# NyangTracker

NyangTracker is a cat-themed Electron desktop app for observing local AI coding usage.

## Current scope: Codex Adapter v1

- Scans `~/.codex/sessions/**/*.jsonl` and archived sessions.
- Reads Codex session metadata such as cwd, model and session identity.
- Converts cumulative `token_count.total_token_usage` values into deduplicated deltas.
- Stores input, cached input, cache-write, output, reasoning and total token usage in SQLite.
- Stores server-provided rate-limit snapshots separately from local token observations.
- Reconciles local activity and server quota movement without inventing a conversion between them.
- Watches active rollout files incrementally and periodically reconciles missed file events.
- Optionally installs non-blocking Codex lifecycle hooks as wake-up signals.
- Streams aggregated usage snapshots to the React renderer through Electron IPC.

## Local commands

```bash
npm install
npm test
npm run dev
```

`npm run dev` starts Vite and Electron together. The collector runs in the Electron main process; the renderer never reads `~/.codex` directly.

## Documentation

- `docs/architecture.md` — architecture, trust model, realtime strategy and security boundary.
- `docs/codex-usage.md` — Codex v1 measurement and reconciliation details.
- `docs/roadmap.md` — Claude Code, Cursor and Gemini CLI adapter roadmap.
