# NyangTracker

NyangTracker is a cat-themed local web app for observing local AI coding usage. A Node service collects usage on the machine and a React client reads it over an authenticated loopback HTTP/SSE API.

## Current scope: Codex, Claude Code and Gemini CLI adapters

The Codex adapter below is the reference implementation. Claude Code and Gemini CLI reuse the same engine, store and scan pipeline; what differs per provider is the token accounting and the cursor rule, both of which are established by measuring real logs rather than by reading a guide (see `docs/dev/provider-token-api.md`).

The service opens its port before the historical scan finishes and reports scan
progress inside the snapshot, so the window appears immediately and the client
can tell "nothing has arrived yet" apart from "measured zero". Parsing runs in a
small worker pool while SQLite stays single-writer.

### Codex adapter

- Scans `~/.codex/sessions/**/*.jsonl` and archived sessions.
- Reads Codex session metadata such as cwd, model and session identity.
- Converts cumulative `token_count.total_token_usage` values into deduplicated deltas.
- Stores input, cached input, cache-write, output, reasoning and total token usage in SQLite.
- Stores server-provided rate-limit snapshots separately from local token observations.
- Reconciles local activity and server quota movement without inventing a conversion between them.
- Watches active rollout files incrementally and periodically reconciles missed file events.
- Optionally installs non-blocking Codex lifecycle hooks as wake-up signals.
- Streams aggregated usage snapshots to the React client over authenticated loopback HTTP/SSE.

## Local commands

```bash
npm install
npm test
npm run dev
```

`npm run dev` starts the usage service on a loopback port plus a Vite dev server at `http://127.0.0.1:5173`, injecting the service URL and per-process token into the page. `npm run start:web` builds the client and serves it with the API from one process at `http://127.0.0.1:47831`. The collector always runs in the service process; the browser client never reads `~/.codex` directly.

## Documentation

Start at `docs/README.md`, which indexes everything. The load-bearing ones:

- `docs/architecture.md` — layers, trust model, startup order, persistence and the security boundary.
- `docs/provider-adapter-contract.md` — the lifecycle, normalized event shapes, cursor kinds and snapshot contract every adapter writes to.
- `docs/codex-usage.md` — Codex measurement and reconciliation, plus a known ledger defect in that adapter.
- `docs/claude-code-adapter.md` — the Claude adapter as implemented, cross-checked against ccusage.
- `docs/dev/gemini/` — the Gemini adapter's measured record, including two places where the plan's prediction was the opposite of what the logs said.
- `docs/roadmap.md` — per-adapter status, exit criteria and measured limits.
- `docs/dev/` — what is *not* built yet: milestones, per-screen plans, and the open defects each screen still carries.
