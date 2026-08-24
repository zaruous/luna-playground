# Claude Code Adapter v1

Status: **implemented**. Code lives in `service/providers/claude/{detector,parser,collector,hooks}.mjs`; tests in `test/claude-*.test.mjs` and `test/ccusage-claude-crosscheck.test.mjs`.

Last research check: 2026-08-20. Validated against real local logs (Claude Code 2.1.143~2.1.232, 214 transcripts, 30,753 assistant records) on 2026-08-21.

This document is the implementation contract for Phase 2. The goal was to add Claude Code without weakening the provider-neutral ledger, trust model, or realtime guarantees established by the Codex adapter.

## 0. What the real logs changed

Four things in the original plan did not survive contact with the installed version. They are corrected in place below; this list exists so a reader knows which assumptions moved.

| Planned assumption | What the logs show |
| --- | --- |
| local logs have no thinking-token field | `usage.output_tokens_details.thinking_tokens` exists from 2.1.228 (absent in every earlier version), so `reasoningTokens` is measured, not missing |
| `output_tokens` is undercounted because thinking is excluded | thinking is *inside* `output_tokens` (thinking ≤ output in 9,176/9,176 records). Only pre-2.1.228 logs stay `partial`, because there the inclusion cannot be proven |
| `input_tokens` is a placeholder in ~75% of entries | `input ≤ 1` in 8.9% of records, and 98.8% of those are requests whose prompt was almost entirely served from cache. The value never changes across a request's records, so it is not a streaming placeholder |
| dedupe by message/request identity is enough | the key must also be **global across files** — resuming a session copies the previous transcript, and per-file dedupe inflated output by 8.37% |

Two further findings had no counterpart in the plan: `usage.iterations[]` reports only the last iteration at the top level, and `cache_creation_input_tokens` can disagree with the `cache_creation.ephemeral_*` breakdown. Both are flagged rather than silently corrected.

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

The primary local source is:

```text
${CLAUDE_CONFIG_DIR:-~/.claude}/projects/
```

`CLAUDE_CONFIG_DIR` may list several roots separated by commas. With it unset, both `~/.claude` and `~/.config/claude` are checked — the same range ccusage reads, which keeps the cross-check meaningful.

Sessions are JSONL transcripts below project-specific directories. Three layouts carry usage:

```text
<project>/<conversation-id>.jsonl                       main conversation
<project>/<conversation-id>/subagents/agent-*.jsonl     subagent
<project>/<conversation-id>/subagents/workflows/<run>/*.jsonl   workflow agent
```

Discovery therefore walks every `.jsonl` under `projects/` rather than matching a fixed shape, and skips `tool-results/` outright — it holds tool output bodies, carries no usage, and there is no reason to read it.

The local transcript format is useful but should be treated as a versioned implementation detail rather than a permanently stable public schema. The parser is therefore defensive and fixture-driven, and every event records its `parser_version`.

### 3.2 Usage record shape

For an `assistant` record, the first-pass fields of interest are:

```text
message.id
message.model
message.usage.input_tokens
message.usage.output_tokens
message.usage.cache_creation_input_tokens
message.usage.cache_read_input_tokens
message.usage.output_tokens_details.thinking_tokens   from 2.1.228
message.usage.cache_creation.ephemeral_*_input_tokens
message.usage.iterations[]                            per-API-call breakdown
requestId / request_id
sessionId / session_id
cwd, version, gitBranch, entrypoint
isSidechain, agentId                                  subagent records
isApiErrorMessage, apiErrorStatus                     local error placeholders
```

In the measured corpus `requestId` was present on 30,741 of 30,753 records and `message.id` on all of them, so the dedupe key is effectively always available.

Do not persist message content simply because it is available in the same record. Records whose model is `<synthetic>` or which carry `isApiErrorMessage` are locally generated error placeholders with zero usage — they are counted in the collector status, not in the ledger.

### 3.3 Subagents

Recent Claude Code session layouts can contain subagent transcripts beneath a session-specific directory, for example:

```text
<session>/subagents/agent-*.jsonl
```

Subagent support is part of v1, and the implementation stays tolerant of layout changes.

Correlation turned out to be free: a subagent transcript's `sessionId` **is the parent session id**, and its `cwd` is the parent `cwd`. So subagent usage rolls up to the parent session and project without any extra join, which also matches how ccusage attributes it.

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
| `output_tokens_details.thinking_tokens` | `reasoning_tokens` | Present from 2.1.228. A subset of `output_tokens`, so it is never added to the total again. Absent in earlier versions — left out of `field_quality` rather than stored as a measured zero. |
| `cache_creation.ephemeral_*_input_tokens` | `cache_write_input_tokens` | Summed and compared against the top-level field; the larger value wins and the field is downgraded to `partial` when they disagree. |
| `message.model` | `model` | Preserve the provider-reported model string. |

For a normalized observed total, v1 should use the sum of token categories actually present in the record rather than inventing a provider quota conversion:

```text
observed_total =
    input_tokens
  + cache_read_input_tokens
  + cache_creation_input_tokens
  + output_tokens
```

Note that this differs from Codex, where `input_tokens` already contains the cache-read tokens and cache creation sits outside the total. The adapter therefore declares `capabilities.tokenAccounting = 'cache_disjoint'` so that derived values (cache hit rate, stacked bars) are computed from a non-overlapping prompt-side denominator instead of assuming one accounting model for every provider.

If future Claude logs expose a distinct authoritative `total_tokens`, preserve both the provider total and the category sum so discrepancies can be detected instead of silently overwritten. The same rule already applies to two observed disagreements: a multi-iteration `usage.iterations[]` whose sum exceeds the top-level usage, and a `cache_creation_input_tokens` that disagrees with its TTL breakdown. Both downgrade the affected fields and increment a collector counter; neither rewrites history silently.

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

The stream-start placeholder is still observable in current logs, but as a *separate record of the same request* rather than as a wrong final value: one request is written as several lines, one per content block, and the first line carries a partial output count. Global last-wins dedupe resolves it. Measured on the local corpus: 927 of 9,830 multi-record requests had differing output counts, and in all 927 the last record held the maximum.

Implementation requirements:

- detect the Claude Code version when it can be obtained reliably;
- maintain a compatibility table for known-bad or known-good ranges only when backed by fixtures/evidence;
- add output-token sanity checks that can downgrade quality but never silently rewrite the raw observed value;
- retain the original observed `output_tokens` in the ledger;
- mark the affected field/session `partial` when exactness cannot be established.

Measured compatibility table (the only ranges backed by fixtures):

```text
2.1.228 and newer     input exact   cache read exact   cache write exact   output exact   reasoning exact
2.1.143 .. 2.1.227    input exact   cache read exact   cache write exact   output partial reasoning not reported
below 2.1.143 / unknown  input unverified  cache read exact  cache write exact  output partial  reasoning not reported
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

All twelve hold as of 2026-08-21. The test that pins each one is named in parentheses.

1. Existing Claude history imports without manual path selection (`claude-collector`: 여러 프로젝트 디렉터리).
2. Re-running the historical scan produces no duplicate usage (`claude-collector`: 과거 스캔은 멱등).
3. A new Claude turn appears shortly after its transcript is durably written — watcher/hook wake-up plus a 5s reconcile floor (`claude-collector`: 증분 tail, hook 신호).
4. Closing NyangTracker mid-session and reopening recovers missed usage (`claude-collector`: 저장된 offset 에서 재시작).
5. Cache read, cache creation, input and output are displayed separately (`usage-aggregation`: 누적 막대 분해).
6. Logs whose output accounting cannot be verified are labelled partial instead of silently corrected (`claude-parser`: thinking_tokens 가 없는 옛 버전 로그).
7. Subagent usage is counted once and attributed to its parent/project (`claude-collector`: 서브에이전트 사용량).
8. Hook installation is optional, non-blocking, idempotent and reversible (`claude-hooks`).
9. No conversation content reaches the usage database or any served payload (`claude-privacy`).
10. The dashboard renders Claude from the same normalized snapshot contract as Codex — no provider-id branching in components (`usage-aggregation`: 회계가 다른 provider 를 섞어도).
11. Existing Codex tests remain green (`codex-*`).
12. Claude parser/collector/hook/privacy/real-shape tests are green, and the ccusage cross-check agrees on all shared fields (`ccusage-claude-crosscheck`).

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

## 20.1 Follow-up shipped: turn ledger (M8)

Adapter v1 recorded *how many* tokens each request used. A follow-up milestone added *which step of the work* used them, without weakening §17.

What the Claude adapter contributes:

| Signal | Source | Stored as |
| --- | --- | --- |
| Turn boundary | `type:'user'` record with no `toolUseResult` and a text block | `turns.started_at` — the timestamp only, never the prompt |
| Tool activity | `message.content[].tool_use.name` | `usage_events.tool_counts` JSON — names only, never `input` |
| Touched files | `tool_use.input.file_path` / `.path` / `.notebook_path` | `usage_events.touched_paths` — last segment + parent only |
| Compaction | `type:'system'`, `subtype:'compact_boundary'` | `turns.compacted` — the fact, never the summary text |

Reading `tool_use.name` while never reading `tool_use.input` is the whole trick: the name is structure, the input is payload. `test/session-flow.test.mjs` asserts that `Bash` reaches SQLite and `SENTINEL-TOOL-INPUT` does not.

Two Claude-specific consequences:

- **Subagent requests land in turn 0** ("boundary unknown"). A subagent transcript shares the parent `sessionId` but cannot tell which parent turn launched it, and attaching it to whichever turn the scanner happened to be on would be a lie. Correlating through `agentId` is the follow-up.
- **The parser version had to be bumped** (1 → 2). Files already read to EOF by v1 have their cursor at the end, so nothing would be re-interpreted. `provider_scan_state.parser_version` triggers a one-time re-read — plus a ledger-state check (`turn_index IS NULL`), because a defective intermediate version can stamp the version without writing the metadata.

Design and screen: [dev/menus/session.md](./dev/menus/session.md).

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
