# Claude Code Adapter v1 implementation plan

Status: next implementation target after Codex Adapter v1.

Last research check: 2026-08-20.

This document turns the Phase 2 roadmap item into an implementation contract. The goal is to add Claude Code without weakening the provider-neutral ledger, trust model, or realtime guarantees established by the Codex adapter.

## 1. Goals

Claude Code Adapter v1 should:

- discover local Claude Code session data without requiring the user to select folders manually;
- import historical token usage into the existing SQLite ledger;
- incrementally ingest new usage while Claude Code is running;
- attribute usage to provider, model, session, project and timestamp;
- distinguish cache reads, cache creation, uncached input and output;
- count subagent usage exactly once when local evidence is available;
- use Claude lifecycle hooks only as realtime wake-up signals, never as the usage source of truth;
- recover missed activity after NyangTracker restarts or was closed;
- preserve field-level measurement quality when an older Claude Code log cannot support an exact value;
- expose Claude through the existing HTTP/SSE snapshot and dashboard aggregation path without Claude-specific client logic.

## 2. Non-goals

Claude Adapter v1 will not:

- infer Claude subscription quota consumption from local token totals;
- claim local transcript totals are identical to Anthropic billing or plan limits;
- store prompt text, assistant text, tool inputs or tool outputs for analytics;
- estimate missing output tokens from character counts and label the result exact;
- depend on hooks for data durability;
- scrape browser/account pages to obtain server usage;
- redesign the shared schema only to mirror Claude-specific transcript fields.

## 3. Local source model

### 3.1 Primary transcript root

The primary local source is expected under:

```text
~/.claude/projects/
```

Sessions are represented as JSONL transcripts below project-specific directories. Current observed records include `assistant` entries with model and usage information.

The local transcript format is useful but should be treated as a versioned implementation detail rather than a permanently stable public schema. The parser must therefore be defensive and fixture-driven.

### 3.2 Usage record shape

For an `assistant` record, the first-pass fields of interest are:

```text
message.id
message.model
message.usage.input_tokens
message.usage.output_tokens
message.usage.cache_creation_input_tokens
message.usage.cache_read_input_tokens
requestId / request_id, when present
sessionId / session_id, when present
cwd, when present
```

Do not persist message content simply because it is available in the same record.

### 3.3 Subagents

Recent Claude Code session layouts can contain subagent transcripts beneath a session-specific directory, for example:

```text
<session>/subagents/agent-*.jsonl
```

Subagent support is part of v1, but the implementation must remain tolerant of layout changes.

Important accounting rule:

- count actual assistant usage records from the subagent transcript;
- do not additionally count a parent `toolUseResult` summary/rollup as token usage;
- correlate the subagent to its parent session when stable metadata is available;
- if correlation metadata is absent, preserve the usage as Claude usage with reduced attribution confidence rather than dropping it.

## 4. Key difference from Codex

Codex rollout `total_token_usage` is cumulative, so the Codex adapter converts cumulative snapshots into deltas.

Claude Code local transcripts are different: usage is attached to individual assistant/request records. Therefore Claude must **not** reuse the Codex cumulative subtraction algorithm.

Claude ingestion is:

```text
assistant usage record
        |
        v
stable event identity
        |
        v
deduplicate
        |
        v
store the usage values directly
```

This distinction should be explicit in the provider adapter API so a later provider cannot accidentally apply the wrong accounting model.

## 5. Normalized token mapping

Initial mapping into the common ledger:

| Claude field | NyangTracker field | Notes |
| --- | --- | --- |
| `input_tokens` | `input_tokens` | Observed uncached input category. |
| `cache_read_input_tokens` | `cached_input_tokens` | Cache hits/read tokens. |
| `cache_creation_input_tokens` | `cache_write_input_tokens` | Cache creation/write tokens. |
| `output_tokens` | `output_tokens` | Subject to version/sanity validation described below. |
| `message.model` | `model` | Preserve the provider-reported model string. |

For a normalized observed total, v1 should use the sum of token categories actually present in the record rather than inventing a provider quota conversion:

```text
observed_total =
    input_tokens
  + cache_read_input_tokens
  + cache_creation_input_tokens
  + output_tokens
```

If future Claude logs expose a distinct authoritative `total_tokens`, preserve both the provider total and the category sum so discrepancies can be detected instead of silently overwritten.

Claude-specific cache TTL breakdowns may be stored later as provider metadata. They should not force new top-level common columns until the product needs cross-provider semantics for them.

## 6. Event identity and deduplication

Claude usage must be idempotent across:

- historical rescans;
- file watcher duplicates;
- app restarts;
- hook-triggered forced reconciliations;
- transcript rewrites/flush behavior.

Preferred identity order:

1. stable `message.id` plus session identity;
2. stable request ID plus session identity;
3. deterministic fallback fingerprint built from session, model, usage tuple and durable record metadata.

The database should enforce uniqueness on the normalized provider event key.

Do not deduplicate merely because two adjacent usage tuples are numerically identical. Two legitimate requests can consume the same token counts.

## 7. Output-token reliability and historical logs

A historical Claude Code issue documented local JSONL records where `output_tokens` contained a small stream-start placeholder while the completed stream result had the real output count. That issue was version-specific and has since been closed, but NyangTracker must be able to ingest historical logs created by affected versions.

Implementation requirements:

- detect the Claude Code version when it can be obtained reliably;
- maintain a compatibility table for known-bad or known-good ranges only when backed by fixtures/evidence;
- add output-token sanity checks that can downgrade quality but never silently rewrite the raw observed value;
- retain the original observed `output_tokens` in the ledger;
- mark the affected field/session `partial` when exactness cannot be established.

Example:

```text
input        exact
cache read   exact
cache write  exact
output       partial
session      partial
```

Do not estimate output from visible response characters and present it as measured usage.

## 8. Measurement quality

Claude should use the same product rule as Codex: source quality is data, not UI decoration.

Recommended levels:

```text
server_verified
local_exact
local_partial
estimated
unknown
```

For v1, most Claude Code data will normally be `local_exact` or `local_partial`.

The provider-level card must not say `server verified` unless a future official server usage integration has actually reconciled that interval.

## 9. Historical scanner

Suggested provider layout:

```text
service/providers/claude/
  detector.mjs
  parser.mjs
  collector.mjs
  hooks.mjs
```

Historical scan algorithm:

1. resolve the user home directory;
2. locate supported Claude project roots;
3. recursively enumerate session JSONL files and supported subagent files;
4. process files as streams/lines rather than loading entire transcripts into memory;
5. extract only metadata and usage fields required by NyangTracker;
6. deduplicate by event identity;
7. write normalized events in bounded transactions;
8. persist scan state and file offsets;
9. aggregate through the existing store/engine APIs.

The first scan must be restart-safe. If the app exits halfway through, a later run should continue without double counting completed events.

## 10. Incremental scanner and file watching

Realtime file ingestion remains the primary local truth path.

For every tracked JSONL file, persist enough state to resume safely:

```text
path
file identity when available
last byte offset
last complete line boundary
last observed mtime/size
```

Rules:

- read only appended bytes during normal operation;
- keep an incomplete trailing JSON line buffered until the next append;
- detect truncation/replacement and fall back to a safe rescan;
- watcher events are hints, not durability guarantees;
- periodically reconcile file size/offset state even if no watcher event fired.

## 11. Hook strategy

Claude Code exposes lifecycle hooks including `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`, and subagent events.

NyangTracker should use hooks as acceleration only.

### Recommended v1 hooks

`Stop`
: Primary wake-up signal after a successful main-agent turn. Trigger an immediate reconcile of the supplied transcript path/session.

`StopFailure`
: Reconcile because a failed turn can still have durable usage.

`SessionStart`
: Register/refresh an active session and reconcile it on resume.

`SessionEnd`
: Run a final reconcile and mark the session inactive.

`SubagentStop`
: Optional acceleration for supported subagent transcript layouts.

`UserPromptSubmit` is not required for token correctness. It may later be used only to show an ephemeral `working` state. If enabled, NyangTracker must not retain the prompt field.

### Hook safety rules

- hooks must return success and never block Claude work;
- do not return hook decisions such as `block`;
- do not parse or transmit prompt/assistant content unless a future explicit user feature requires it;
- use `session_id`, `transcript_path`, `cwd`, hook event name and other non-content metadata only;
- the collector must still be correct when every hook is disabled or missed;
- if NyangTracker is closed, the hook helper should exit cleanly and Claude should continue unaffected.

A command hook that signals the existing local NyangTracker runtime transport is preferred for parity with Codex. HTTP hooks may be evaluated later if the desktop app has a stable authenticated loopback endpoint.

## 12. Hook installation behavior

Hook installation is opt-in from NyangTracker settings.

Requirements:

- discover the current Claude settings source before editing;
- preserve all unrelated user hooks/settings;
- insert only clearly identifiable NyangTracker entries;
- make installation idempotent;
- support clean removal of only NyangTracker-managed entries;
- show `installed`, `not installed`, `unsupported`, or `conflict` state in the UI;
- never overwrite the user's settings file wholesale.

Because hook configuration evolves, fixture tests should cover the currently supported settings shape and migration behavior.

## 13. Reconciliation model

Claude local reconciliation is primarily about local durability rather than matching a subscription quota.

Signals:

```text
file watcher -> fast hint
hook event   -> fast hint
periodic scan -> recovery
focus/resume  -> recovery
startup scan  -> recovery
```

After any hint, the source of truth remains the durable JSONL transcript.

If future official server usage is connected, add it as a separate server ledger/anchor. Do not mutate historical local events merely to force totals to match a server aggregate.

## 14. Project attribution

Preferred attribution order:

1. explicit `cwd`/project metadata in the record/session;
2. project directory metadata encoded by Claude Code's local storage layout, after validation;
3. parent session metadata for subagents;
4. unknown project with retained session usage.

Never drop token usage solely because the project cannot be identified.

Project paths are potentially sensitive local metadata. Continue to store them only locally and support aliases/redaction as described in the cross-provider roadmap.

## 15. Store/API changes

The existing common store should remain provider-neutral.

Expected changes are limited to capabilities that Claude genuinely requires, such as:

- provider event identity/dedupe keys;
- field/session measurement quality;
- optional provider metadata JSON;
- parent session/subagent relationship if not already represented;
- direct-event accounting mode in the provider adapter.

Do not add Claude-named columns to shared tables.

## 16. Service and client flow

Target flow:

```text
Claude transcript
      |
      v
Claude Adapter
      |
      v
Normalized usage events
      |
      v
SQLite Usage Store
      |
      v
Aggregator
      |
      v
HTTP API + SSE
      |
      v
React dashboard
```

The client should receive normalized provider snapshots and render Claude using the same components used for Codex.

Provider-specific details should be presented as metadata/badges, not branching business logic inside dashboard components.

## 17. Privacy boundary

The Claude transcript can contain the complete conversation, tool calls and local file information. NyangTracker only needs a narrow subset.

Parser output allowed into the usage store:

- session/provider IDs;
- timestamps;
- model;
- project/cwd attribution;
- token usage categories;
- local source path/offset required for incremental scanning;
- measurement quality;
- non-content hook metadata.

Do not store:

- user prompts;
- assistant response text;
- thinking text;
- tool input/output payloads;
- file contents found in the conversation.

Tests should include a fixture containing sentinel prompt/assistant text and assert that the text never appears in SQLite or in snapshots served over HTTP/SSE.

## 18. Testing plan

### Parser tests

- normal assistant usage record;
- missing optional fields;
- malformed JSON line;
- incomplete trailing line;
- historical output-token anomaly fixture;
- model changes within a session;
- duplicate record with the same stable identity;
- two legitimate records with equal numeric usage but different IDs.

### Collector tests

- historical scan is idempotent;
- incremental scan after append equals a clean full scan;
- restart from persisted offset does not double count;
- truncation/replacement recovery;
- multiple project directories;
- subagent ingestion without parent rollup double counting.

### Hook tests

- install into an empty configuration;
- merge into an existing configuration;
- repeated install is idempotent;
- uninstall preserves unrelated hooks;
- missing NyangTracker runtime never causes a blocking/failing hook result;
- hook signal causes reconcile but contributes zero tokens by itself.

### Privacy tests

- prompt/assistant sentinel strings never reach SQLite;
- hook `prompt` and `last_assistant_message` fields are discarded;
- client snapshots expose usage metadata only.

## 19. Acceptance criteria

Claude Adapter v1 is complete when all of the following are true:

1. Existing Claude history can be imported without manual path selection on supported platforms.
2. Re-running the historical scan produces no duplicate usage.
3. A new Claude turn normally appears shortly after its transcript is durably written.
4. Closing NyangTracker during Claude work and reopening it recovers missed usage.
5. Cache read, cache creation, input and output are displayed separately.
6. Historical logs with suspect output accounting are labeled partial instead of silently corrected.
7. Subagent usage is counted once and attributable to a parent/project when evidence permits.
8. Hook installation is optional, non-blocking, idempotent and reversible.
9. No conversation content is stored in the usage database.
10. The dashboard renders Claude from the same normalized provider snapshot contract as Codex.
11. Existing Codex tests remain green.
12. New Claude parser/collector/hook/privacy tests are green.

## 20. Suggested implementation sequence

### CLC-1 — Detector and fixtures

- add Claude provider directory;
- add anonymized transcript fixtures;
- implement supported-root discovery;
- establish parser compatibility metadata.

### CLC-2 — Parser and dedupe

- parse assistant usage;
- normalize token categories;
- implement stable event identities;
- add output quality detection;
- add privacy assertions.

### CLC-3 — Historical collection

- recursive session/subagent discovery;
- streaming import;
- SQLite integration;
- project/model/session aggregation.

### CLC-4 — Incremental collection

- offsets and partial-line handling;
- file watching;
- periodic reconciliation;
- app resume/focus reconciliation.

### CLC-5 — Lifecycle hooks

- settings discovery;
- opt-in merge/unmerge;
- Stop/StopFailure/SessionStart/SessionEnd wake-up signals;
- optional SubagentStop acceleration.

### CLC-6 — UI integration

- Claude provider card/bar;
- cache read/write breakdown;
- measurement-quality badges;
- active/reconciled status.

### CLC-7 — End-to-end verification

- historical fixture import;
- simulated append/restart;
- hook/no-hook parity;
- Codex regression suite;
- client build/CI.

## 21. Server-side reconciliation follow-up

Claude Adapter v1 intentionally treats local transcript usage as local observation.

A later server adapter can be added for environments that expose an official authoritative source, such as an organization API, gateway, Bedrock/Vertex accounting source, or other documented provider mechanism.

That server source must be modeled separately:

```text
Local Ledger = session/project attribution
Server Ledger = authoritative aggregate when available
Reconciliation = comparison, never destructive correction
```

No server integration should be implemented by scraping private web pages or reverse-engineering subscription quota math.

## 22. Risks to watch during implementation

- local JSONL schema is not a guaranteed stable public API;
- historical Claude Code versions can differ in persisted usage correctness;
- one session can use multiple models;
- subagent layouts/metadata can change;
- duplicated/replayed transcript records can inflate totals without stable dedupe;
- cache categories can dominate token counts and must not be hidden inside plain `input`;
- hook behavior can differ by configuration/version, so hooks cannot replace reconciliation;
- local observations cannot see another device or server-only activity.

## 23. Product rule

The Claude adapter follows the same rule as the rest of NyangTracker:

> Prefer an honest incomplete measurement over a precise-looking invented measurement.

If input/cache values are exact and output is uncertain, display exactly that state. Do not downgrade the whole product into an estimate, and do not upgrade an uncertain field into a fake exact number.

## References checked for this plan

- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Claude Code hooks guide: https://code.claude.com/docs/en/hooks-guide
- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Historical JSONL output token issue: https://github.com/anthropics/claude-code/issues/25941
- Per-message session usage discussion: https://github.com/anthropics/claude-code/issues/24348
- Local transcript schema stability request: https://github.com/anthropics/claude-code/issues/49400

These references describe the evidence available at the research date. The implementation should validate against real local fixtures from the installed Claude Code version before promoting any field from `partial` to `local_exact`.
