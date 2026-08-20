# Codex usage collection — v1

냥토큰 트래커의 Codex 수집기는 **로컬 토큰 관측값과 서버 한도 snapshot을 서로 다른 원본으로 보존**합니다. 서버 사용률에 맞추기 위해 로컬 토큰 수를 보정하지 않습니다.

## Sources

### Local usage ledger

- Default root: `~/.codex/sessions/**/*.jsonl`
- Archive root: `~/.codex/archived_sessions/**/*.jsonl`
- Session metadata: `session_meta`
- Model/cwd metadata: `turn_context`
- Usage: `event_msg.payload.type === "token_count"`
- Stored usage fields:
  - input
  - cached input
  - cache-write input
  - output
  - reasoning output
  - total

`total_token_usage` is a mutable cumulative snapshot and `last_token_usage` is the preferred per-turn increment. NyangTracker uses both:

1. unchanged cumulative totals suppress rate-limit-only replays of stale `last_token_usage`;
2. monotonic totals use `last_token_usage`, with cumulative delta as a fallback;
3. small regressions are treated as out-of-order/stale snapshots;
4. a genuine large reset counts only `last_token_usage`, never the full reset total;
5. stable event identity prevents active and archived copies from being counted twice.

### Server anchor

When the same `token_count` event includes `rate_limits`, NyangTracker stores each `(limit_id, primary/secondary)` window separately:

- `used_percent`
- `window_minutes`
- `resets_at`
- `limit_id` / `limit_name`

`primary` and `secondary` are server lane names. Product labels such as 5-hour and weekly are derived from `window_minutes`, and multiple model-specific `limit_id` values never share one gauge. These are **server-observed quota snapshots**, not token counts. No conversion from percent to tokens is attempted.

## Reconciliation

Consecutive server snapshots are compared with local token activity in the same event-time interval.

- `MATCHED_ACTIVITY`: server usage rose and local tokens were observed.
- `SERVER_ONLY_CHANGE`: server usage rose with no corresponding local tokens.
- `LOCAL_ONLY_ACTIVITY`: local tokens rose while server percentage did not change.
- `RESET`: quota reset time changed or server percentage dropped.
- `UNKNOWN`: no meaningful movement.

A server-only interval is preserved as unattributed server activity. It is never folded into local tokens.

## Realtime strategy

Reliability order:

1. JSONL incremental scan — source of truth.
2. Filesystem watch — fast wake-up.
3. Codex lifecycle Hook — optional fast wake-up after prompt/stop/session events.
4. Periodic reconcile — repairs missed watcher/hook events.
5. Window focus reconcile — catches sleep/resume and long idle periods.
6. SSE snapshot broadcast — delivers the normalized result to every connected UI client.

Hooks are optional. If NyangTracker is closed or a hook fails, Codex work must continue normally. The next reconcile replays any missing JSONL tail. Hook input is reduced to event/session/turn/transcript/cwd/model metadata before it is sent to the app; prompt contents are not stored by the hook bridge.

## Hook installation

The UI can merge NyangTracker command hooks into `~/.codex/hooks.json` for:

- `SessionStart`
- `UserPromptSubmit`
- `Stop`
- `SessionEnd`

Existing hook groups are preserved. Uninstall removes only handlers containing `--nyangtracker-hook`. The first pre-existing hooks file is copied to `hooks.json.nyangtracker.bak` before modification.

Codex may apply its own hook trust/approval policy. NyangTracker treats hooks as an acceleration path, never as the authoritative usage source.

## SQLite

Stored under the application user-data directory as `usage.sqlite3`.

Tables:

- `sessions`
- `usage_events`
- `server_usage_snapshots`
- `reconciliation_events`
- `provider_scan_state`

`provider_scan_state` retains provider-scoped byte offsets and cumulative token state for each rollout file, allowing tail-only rescans even for very large sessions. Legacy `scan_state` remains only as a migration source.

## Measurement labels

- **로컬 관측**: parsed from Codex rollout logs.
- **서버 관측**: parsed from Codex server rate-limit snapshots.
- Future API-based authoritative usage should be stored as a separate server ledger rather than overwriting either source.
