# Provider roadmap

Implementation order agreed for NyangTracker:

1. Codex
2. Claude Code
3. Cursor
4. Gemini CLI

Codex is the reference adapter. The shared engine should not be redesigned for each later provider unless a real provider constraint requires it.

## Phase 1 — Codex Adapter v1

Status: implemented in the current branch.

### Completed

- Scan `~/.codex/sessions/**/*.jsonl` and archived sessions.
- Read session identity, cwd/project and model metadata.
- Normalize cumulative `total_token_usage` into non-negative deltas.
- Preserve input, cached input, cache-write, output, reasoning and total usage.
- Incrementally resume from persisted byte offsets.
- Watch active Codex data and periodically reconcile missed changes.
- Store `rate_limits` windows as server snapshots.
- Classify reconciliation as matched, server-only, local-only, reset or unknown.
- Push normalized snapshots to the React client over authenticated HTTP/SSE.
- Serve the built client and API from one local process, and inject the same service configuration into the Vite dev page.
- Optionally merge lifecycle command hooks into Codex configuration.
- Keep hooks non-authoritative and non-blocking for Codex work.

### Verification target

A Codex turn should normally appear in NyangTracker shortly after the durable rollout is flushed. Closing NyangTracker during a session must not cause permanent data loss; reopening it should reconcile the missing tail.

### Known limitations

- ChatGPT/Codex subscription quota percentage is not a documented token conversion and must not be reverse-engineered into fake token totals.
- Local logs cannot prove there was no activity from another device or server-side/cloud execution.
- Exact billing-equivalent cost may depend on information not preserved in local rollout records, such as service tier or future provider pricing rules.
- Hooks can vary by Codex version/configuration, so file reconciliation remains mandatory.

## Phase 2 — Claude Code Adapter

Status: implemented in the current branch.

### Completed

- Discover `${CLAUDE_CONFIG_DIR:-~/.claude}/projects` transcripts, including subagent and workflow-agent transcripts.
- Map input, cache-read, cache-creation, output and thinking usage into the common model, keeping Claude's cache-disjoint accounting distinct from Codex's cache-in-input accounting.
- Store request-scoped values directly instead of reusing the Codex cumulative-diff algorithm.
- Deduplicate globally on `claude|message.id|requestId` with last-wins upsert plus a non-regression guard, so content-block splits and resumed-session copies are counted once.
- Attribute sessions to projects from `cwd`, and subagent usage to its parent session.
- Version-gate field quality from measured evidence: `output_tokens_details.thinking_tokens` exists from 2.1.228, and `input_tokens` is trustworthy from 2.1.143.
- Install `SessionStart / Stop / StopFailure / SessionEnd / SubagentStop` hooks as optional, idempotent, reversible wake-up signals in `~/.claude/settings.json`.
- Cross-check the whole ledger against ccusage on a frozen 214-file corpus: input, cache-read, cache-creation, output and total agree exactly.

### Known limits

- Local transcripts cannot prove there was no activity from another device or from the web app.
- `output_tokens` completeness cannot be verified on logs written before 2.1.228, so those events stay `partial`.
- A message with multiple `usage.iterations` reports only the last iteration at the top level; the discrepancy is flagged rather than silently corrected.
- The OTLP telemetry lane (`claude_code.token.usage`) is designed but not implemented, so subagent usage is attributed to its parent rather than shown separately.
- JSONL is not a public API, so the parser stays defensive and fixture-driven, and every event records its `parser_version`.

## Phase 3 — Cursor Adapter

Cursor requires two modes.

### Team / Enterprise

Prefer official administrative usage events when the account exposes them. Treat server usage as the authoritative aggregate and use local workspace state only for attribution when necessary.

### Personal

Local Cursor state may support session/project attribution but should not automatically be labeled as authoritative billed token usage.

Planned work:

- discover supported Cursor local databases/state locations by platform;
- version the local parser because internal schemas are not a stable public contract;
- add an optional server adapter for supported Team/Enterprise accounts;
- clearly separate `server verified` from `local/estimated` in the UI.

Exit criterion: no personal Cursor estimate is presented as exact server billing data.

## Phase 4 — Gemini CLI Adapter

Gemini CLI local sessions already expose useful usage categories, making it a good fit for the normalized schema.

Planned mapping:

- input -> `input_tokens`
- cached -> `cached_input_tokens`
- output -> `output_tokens`
- thoughts -> `reasoning_tokens`
- tool -> `tool_tokens`
- total -> `total_tokens`

Planned work:

- scan `~/.gemini/tmp/<project_hash>/chats/`;
- recover project attribution from Gemini session metadata/project hashing;
- add incremental file scanning and reconciliation;
- add provider/server anchors only where an official source is available.

## Cross-provider follow-up

After all four adapters are available:

- model pricing registry with historical effective dates;
- daily/weekly/monthly aggregation and trend charts;
- per-project and per-model drill-down;
- source/confidence filters;
- unattributed server activity timeline;
- export/import of the local ledger;
- migration/versioning tests for the SQLite schema;
- optional privacy controls for project path redaction/aliases.

## Product rule

The tracker must prefer **an honest incomplete measurement over a precise-looking invented measurement**. Local observations, server anchors, and estimates are separate data products and stay separate in storage and UI.
