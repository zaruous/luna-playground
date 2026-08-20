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

`total_token_usage` is cumulative. NyangTracker stores only a non-negative delta from the previously observed cumulative value. Repeated cumulative events therefore do not double count.

### Server anchor

When the same `token_count` event includes `rate_limits`, NyangTracker stores primary/secondary windows separately:

- `used_percent`
- `window_minutes`
- `resets_at`
- `limit_id` / `limit_name`

These are **server-observed quota snapshots**, not token counts. No conversion from percent to tokens is attempted.

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

Stored under Electron `userData/usage.sqlite3`.

Tables:

- `sessions`
- `usage_events`
- `server_usage_snapshots`
- `reconciliation_events`
- `scan_state`

`scan_state` retains the byte offset and last cumulative token totals for each rollout file, allowing tail-only rescans even for very large sessions.

## Measurement labels

- **로컬 관측**: parsed from Codex rollout logs.
- **서버 관측**: parsed from Codex server rate-limit snapshots.
- Future API-based authoritative usage should be stored as a separate server ledger rather than overwriting either source.
