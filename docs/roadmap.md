# Provider roadmap

Implementation order as built:

1. Codex — implemented
2. Claude Code — implemented
3. Gemini CLI — implemented
4. Cursor — not started

The original order put Cursor third. Gemini was taken first because the three
file-tailing adapters share the same infrastructure, while Cursor is the only
one that needs an authenticated server API — credential storage, rate limiting,
a time-window cursor — and grouping it last keeps that infrastructure out of the
adapters that do not need it. The phase sections below keep their original
numbering; only the order of work changed.

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
- **Codex is the only adapter still writing through `INSERT OR IGNORE` instead of
  an upsert, so a row already in the ledger can never be corrected.** Measured on
  the development machine: `turn_index`, `field_quality`, `parser_version` and
  `request_id` are NULL for all 18,853 Codex rows, so the claim elsewhere in this
  document that every event records its `parser_version` does not hold for Codex.
  Worse, a NULL `turn_index` is what triggers reinterpretation, so 678 files /
  785.2 MB are re-read and re-parsed on every startup while the repair never
  lands. Claude and Gemini use the upsert path and show 0 such files. See
  `docs/dev/menus/session.md`.
- Six Codex events carry a total with an all-zero breakdown (44,006 tokens, 0.002%
  of the adapter's total). They satisfy no accounting identity, so the aggregate
  decomposition for Codex falls back to "overlap unverified" rather than claiming
  a split it cannot justify — correct behaviour, but the cause is these six rows.

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

Status: implemented in the current branch.

### Completed

- Discover `${GEMINI_DATA_DIR:-~/.gemini/tmp}/<project_dir>/chats/` — `GEMINI_DATA_DIR` replaces the `tmp` segment, not the home, so `projects.json` is still read from `~/.gemini` — in both real formats: `.json` whole-document snapshots and `.jsonl` incremental logs (header line, message lines, `$set` patch lines). `endsWith('.json')` does not match `.jsonl`, so the two extensions are listed explicitly.
- Resume `.jsonl` from a byte offset like the other file-based providers; for `.json`, decide re-parsing by mtime plus size and then by content hash, so a rewrite with unchanged content skips parsing entirely.
- Map input / cached / output / thoughts / tool / total onto the common model, keeping Gemini's own accounting distinct from both Codex and Claude.
- Deduplicate globally on `gemini|<message.id>` with request-scoped upsert, because the same message id reappears across files and lines (measured: 298 in `.json`, 636 in `.jsonl` — resumed-session copies).
- Attribute turns to human messages (`type: 'user'`), leaving usage before the first boundary in the unattributed bucket.
- Record tool names from `toolCalls[].name` and fill the Gemini tool/phase table with CLI built-ins only; MCP and project-specific names fall through to `other`.
- Resolve project directories through `~/.gemini/projects.json`, and keep unresolvable hashes distinct instead of collapsing them into one bucket.

### Measured accounting — two findings that contradicted the plan

Across the whole development-machine corpus (`.json` 419 files / 11,796 token-bearing messages, `.jsonl` 386 files / 1,519), `input + output + thoughts == total` holds with zero mismatches, and `cached <= input` always holds.

- `thoughts` sits **outside** `output`. Codex and Claude both satisfy `output ⊇ reasoning`, so a non-overlapping breakdown subtracts reasoning from output; doing that for Gemini understates output and the parts no longer sum to the total.
- `cached` sits **inside** `input`, so the accounting is `cache_in_input` like Codex — not the `cache_disjoint` the plan predicted from the guide's wording. The logs decided it.

### Known limits

- `tool` is zero across the entire corpus, so whether it belongs inside `total` is unverified. The value is stored as reported and its position is not assumed; a non-zero `tool` breaks the identity above and surfaces as a `partial` grade plus a mismatch counter rather than a silent correction.
- Of 110 hashed project directories, only 2 reverse-map to a known path via sha256, so hashed directories are treated as generally unresolvable. They keep a `gemini:<12 hex>` identifier so distinct projects stay distinct.
- No compaction marker was found in either format, so turn rows never claim compaction.
- Gemini CLI's hook contract is unverified, so `capabilities.hooks` is false rather than offering a button that cannot be wired.
- Local sessions carry no server quota, so `serverQuota` is false and there is nothing to reconcile against.

## Cross-provider follow-up

Some of this landed early, because the screens needed it before the fourth
adapter existed:

- **done** daily/weekly/monthly aggregation and trend charts (M2) — hour/day/week/month buckets, cut on local time;
- **done** per-project and per-model drill-down (M2);
- **done** optional privacy controls for project path redaction/aliases (M2) — `project_aliases`, applied server-side so a redacted path never reaches the client;
- **partly done** migration tests for the SQLite schema — opening an old DB and gaining the new columns while keeping existing rows is covered (`test/claude-store.test.mjs`, `test/codex-store.test.mjs`), but there is no test that pins a *versioned* upgrade path across more than one step.

Still open:

- model pricing registry with historical effective dates (M7);
- source/confidence filters;
- unattributed server activity timeline;
- export/import of the local ledger (M7).

## Product rule

The tracker must prefer **an honest incomplete measurement over a precise-looking invented measurement**. Local observations, server anchors, and estimates are separate data products and stay separate in storage and UI.
