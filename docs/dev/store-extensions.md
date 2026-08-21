# 스토어 확장 계획

[provider-token-api.md](./provider-token-api.md)와 메뉴 문서들이 요구하는 SQLite 변경만 모았습니다. 현재 스키마는 `service/store.mjs`의 `migrate()`가 만들고, 마이그레이션은 **`PRAGMA table_info`로 컬럼 존재를 확인한 뒤 `ALTER TABLE ... ADD COLUMN`** 하는 방식입니다(`service/store.mjs:164`). 아래 항목도 같은 방식을 씁니다 — 스키마 버전 번호를 도입하지 않습니다.

## 현재 상태 요약

| 테이블 | 용도 | 고유 키 |
|---|---|---|
| `sessions` | 세션/프로젝트/모델 메타데이터 | — |
| `usage_events` | 로컬 토큰 원장 (delta) | `UNIQUE(provider, source_path, source_offset)`, 보조 `event_key` |
| `server_usage_snapshots` | 서버 한도 snapshot (percent) | `snapshot_key` |
| `reconciliation_events` | 로컬/서버 대조 이력 | — |
| `provider_scan_state` | 파일별 byte offset + 이전 누적값 | `(provider, source_path)` |
| `scan_state` | legacy, 마이그레이션 원본으로만 유지 | — |

## 1. `usage_events` — 4개 컬럼 추가 (완료, M3)

```sql
ALTER TABLE usage_events ADD COLUMN tool_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN field_quality TEXT;      -- JSON
ALTER TABLE usage_events ADD COLUMN parser_version INTEGER;
ALTER TABLE usage_events ADD COLUMN request_id TEXT;
```

- `tool_tokens` — Gemini의 tool 토큰. `docs/architecture.md`가 예약 필드로 이미 선언해 둔 `tool_tokens`를 실제 컬럼으로 만듭니다.
- `field_quality` — 필드별 신뢰도 JSON. 예: `{"inputTokens":"unverified","outputTokens":"partial"}`. 컬럼 하나로 두는 이유는 provider마다 대상 필드가 달라서입니다.
- `parser_version` — 포맷이 진화하는 provider(Gemini) 재해석용.
- `request_id` — Claude의 `requestId`. 중복 제거 키의 절반이고, 디버깅 시 원본 대조에 필요합니다.

### `event_key` UNIQUE 승격과 UPSERT

Claude는 같은 요청의 후행 레코드가 최종값이므로 **덮어쓰기**가 필요합니다(R1: last-wins). 현재 `event_key`는 인덱스 없는 일반 컬럼입니다.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_event_key
  ON usage_events(provider, event_key) WHERE event_key IS NOT NULL;
```

부분 인덱스(`WHERE event_key IS NOT NULL`)라서 키가 없는 기존 행에는 영향이 없습니다. 신규 메서드:

```js
upsertUsageEvent(event, sourcePath, sourceOffset, observedAt)
//   1) (provider, event_key) 로 기존 행을 찾는다
//   2) 있으면: 새 total 이 더 클 때만 토큰/품질/observed_at 을 갱신 (last-wins + 역행 방지)
//   3) 없으면: INSERT ... ON CONFLICT(provider, source_path, source_offset) DO UPDATE
//      (같은 offset 에 다른 event_key 가 있으면 파일이 제자리에서 고쳐진 경우)
// → { changed, inserted, updated, reason }
```

기존 `insertUsageEvent`는 그대로 둡니다. Codex는 append-only 가정이 맞으므로 계속 insert 경로를 씁니다. **provider가 자기 저장 전략을 고르는 구조**이지, 전역 동작을 바꾸지 않습니다.

역행 방지 가드를 둔 이유는 실측입니다 — 세션을 resume하면 이전 transcript가 새 파일로 복사되는데, 그 사본의 사용량이 0으로 남는 경우가 있었습니다(1건). 한 파일 안에서 역행은 0건이므로 이 가드는 last-wins 의미를 바꾸지 않고 사본만 걸러냅니다.

주의: `UNIQUE(provider, source_path, source_offset)`가 남아 있으므로, upsert 대상 행의 offset이 바뀌면 새 행이 생깁니다. 그래서 갱신 경로는 `source_offset`을 **갱신하지 않고 최초 값을 유지**합니다.

### 배치 쓰기

첫 스캔이 수만 건을 넣으므로 `transaction(run)`을 함께 추가했습니다. 단일 SQLite 연결을 Codex 수집기와 공유하므로 중첩 `BEGIN`이 나면 안 되고, 그래서 **`await`이 없는 동기 함수만** 받습니다. 수집기는 파서 결과를 500건씩 모아 한 트랜잭션으로 넣습니다.

## 2. `provider_scan_state` — 2개 컬럼 추가

```sql
ALTER TABLE provider_scan_state ADD COLUMN content_hash TEXT;
ALTER TABLE provider_scan_state ADD COLUMN parser_version INTEGER;
```

Gemini의 `.json` 전체 스냅샷 파일은 tail이 불가능해 해시 비교로 재파싱 여부를 판단합니다.

## 3. `provider_api_cursor` — 신규

API 기반 provider(Cursor)용 시간 창 커서. 파일 커서와 의미가 달라 같은 테이블에 섞지 않습니다.

```sql
CREATE TABLE IF NOT EXISTS provider_api_cursor (
  provider TEXT NOT NULL,
  source_key TEXT NOT NULL,          -- 'filtered-usage-events' 등
  window_end TEXT,                   -- 닫힌 버킷의 끝 (ISO)
  last_event_timestamp TEXT,
  page INTEGER NOT NULL DEFAULT 0,
  requests_in_window INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, source_key)
);
```

## 4. `provider_request_events` — 신규

Cursor 요청 기반 플랜은 토큰을 주지 않습니다. 0으로 채우면 규칙 R7 위반이므로 별도 테이블에 요청 수/금액만 적습니다.

```sql
CREATE TABLE IF NOT EXISTS provider_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_timestamp TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  model TEXT,
  kind TEXT,
  request_count INTEGER NOT NULL DEFAULT 1,
  charged_cents INTEGER,
  is_chargeable INTEGER NOT NULL DEFAULT 1,
  event_key TEXT,
  UNIQUE(provider, event_key)
);
```

## 5. `provider_credentials` — 신규 (신중히)

Cursor Admin API 키를 저장해야 합니다. 원칙:

```sql
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- 'api_key'
  secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
```

- 키는 **서비스 프로세스만** 읽습니다. 스냅샷·SSE·`/api/v1/diagnostics` 어디에도 실어 보내지 않습니다.
- 클라이언트에는 `{ configured: true, lastUsedAt }`만 노출합니다. 값 회수 API를 만들지 않습니다.
- 파일 권한은 기존 SQLite 파일 권한을 따릅니다. OS 키체인 연동은 후속 과제이며, 그때까지 설정 화면에 저장 위치를 명시합니다.
- 다른 앱의 키체인·쿠키를 읽어오는 경로는 만들지 않습니다(R6).

## 6. 알림 테이블 — 신규

[menus/alert.md](./menus/alert.md)가 요구합니다.

```sql
CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,                     -- NULL이면 전체
  kind TEXT NOT NULL,                -- 'quota_percent' | 'token_budget' | 'collector_stalled' | 'cost_budget'
  threshold REAL NOT NULL,
  window_minutes INTEGER,            -- quota_percent 전용
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  provider TEXT,
  fired_at TEXT NOT NULL,
  value REAL NOT NULL,
  state TEXT NOT NULL,               -- 'fired' | 'resolved'
  detail TEXT
);
```

규칙 평가는 스냅샷 생성 직후 서비스 프로세스에서 수행합니다. 클라이언트는 평가하지 않습니다 — 창을 닫아도 알림이 동작해야 하기 때문입니다.

## 7. 프로젝트 별칭 — 신규

[menus/project.md](./menus/project.md)의 경로 가림 기능용입니다.

```sql
CREATE TABLE IF NOT EXISTS project_aliases (
  provider TEXT NOT NULL,
  project_key TEXT NOT NULL,         -- cwd 또는 Gemini project_hash
  alias TEXT NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, project_key)
);
```

`redacted = 1`이면 스냅샷의 `cwd`를 빈 값으로 바꿔 내보냅니다. 원본 경로는 로컬 DB에만 남습니다.

## 8. 집계 쿼리 추가 (완료, M2·M3)

[menus/usage.md](./menus/usage.md)의 시계열 화면에 필요합니다.

```js
getUsageTimeseries({ provider, model, bucket, since, until })
// bucket: 'hour' | 'day' | 'week' | 'month'
// SQLite strftime으로 버킷 키를 만들고 GROUP BY

getModelBreakdown({ provider, since, until })
getProjectBreakdown({ provider, since, until, limit })
getQuotaHistory({ provider, limitId, windowMinutes, since })

// M3 추가 — 품질 배지용. field_quality 는 provider 당 가짓수가 적어 그룹해서
// 꺼내고 JS 에서 병합합니다(매 행 JSON.parse 를 피하려고).
getProviderQuality(provider, since)
//   → { overall, eventCount, byQuality, sources,
//       fields: { [field]: { worst, counts: { [grade]: eventCount } } },
//       reportedFields }
```

`fields`가 최저 등급만이 아니라 **등급별 건수**를 함께 내는 이유는, 이벤트 한 건 때문에 필드 전체가 "추정"으로 보이면 UI가 거짓말을 하기 때문입니다. 실측 예: 캐시 읽기는 13,755건이 `local_exact`이고 2건만 `partial`입니다.

사전 집계 테이블은 만들지 않습니다. 현재 데이터 규모(수천 이벤트/월)에서 `usage_events` 인덱스로 충분하고, 이중 원장은 정합성 위험만 늘립니다. 규모가 커지면 그때 `(provider, model, bucket_start)` 버킷 테이블을 도입합니다 — 조사에서 본 Token Tracker의 30분 버킷 방식이 참고 대상입니다.

## 10. 세션 흐름 계층 — 완료 (M8)

[menus/session.md](./menus/session.md)가 요구합니다. "어떤 절차로 얼마를 썼나"를 대화 본문 없이 보여주기 위한 계층입니다.

### 요청 행에 붙는 구조 메타 3개

```sql
ALTER TABLE usage_events ADD COLUMN turn_index INTEGER;    -- 이 요청이 속한 턴 (NULL/0 = 경계 미확인)
ALTER TABLE usage_events ADD COLUMN tool_counts TEXT;      -- JSON {"Bash":2,"Edit":1} — 이름만
ALTER TABLE usage_events ADD COLUMN touched_paths TEXT;    -- JSON {"docs/a.md":1} — 경로 접미만
```

### 턴 경계 테이블

```sql
CREATE TABLE IF NOT EXISTS turns (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  started_at TEXT,                  -- 사람 프롬프트 시각 (본문 없음)
  compacted INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, session_id, turn_index)
);
```

### 왜 턴 테이블에 토큰을 두지 않는가

처음 설계는 `turns`에 턴별 토큰 합계를, `session_activity`에 세션 롤업을 두는 것이었습니다. **둘 다 버렸습니다.** 합계를 별 테이블에 누적하면 두 곳에서 깨집니다.

- 증분 tail이 턴 중간을 가르면 부분 합계가 두 번 들어와 누적해야 하는데, 절단 후 전체 재스캔에서 그 누적이 두 배가 됩니다
- 세션을 resume하면 같은 턴이 다른 파일에서 다시 관측되어 또 두 배가 됩니다

`usage_events`는 이미 `event_key`로 중복 제거되므로, **요청 행에 턴 번호를 달고 집계를 SQL로 뽑으면 멱등성을 공짜로 물려받습니다.** `session_activity`도 만들지 않았습니다 — 메인 transcript 경로·재독 배수·컨텍스트 최고점·도구/파일 카운트가 전부 `usage_events`에서 유도되고, 이중 원장은 정합성 위험만 늘립니다(§8과 같은 판단).

### `provider_scan_state` 두 컬럼 (§2 예정 항목 중 하나 사용)

```sql
ALTER TABLE provider_scan_state ADD COLUMN parser_version INTEGER;  -- M8에서 사용
ALTER TABLE provider_scan_state ADD COLUMN content_hash TEXT;       -- Gemini(M5) 예정
```

`parser_version`은 **파서가 버전업되면 이전 버전으로 읽은 파일을 한 번 다시 해석**하는 판정 기준입니다. 턴 계층이 없던 v1으로 파일 끝까지 읽어 둔 상태에서는 offset이 EOF라 아무것도 재해석되지 않기 때문입니다.

다만 버전 도장만으로는 자기 치유가 안 되는 함정이 있습니다 — 결함 있는 중간 버전이 **버전만 올려놓고 메타는 못 쓰면** 이후 조건이 걸리지 않아 영구히 비어 있습니다(실제로 이 마일스톤에서 겪었습니다). 그래서 재해석 조건은 두 개를 OR 합니다.

```js
staleParser  = (scanState.parserVersion ?? 0) < PARSER_VERSION
missingTurns = store.hasUnattributedTurns(provider, sourcePath)  // turn_index IS NULL 인 행이 있는지
```

`missingTurns`는 **원장 상태**를 보므로 버전 기록이 어떻게 꼬여도 스스로 복구합니다. 재해석 뒤에는 모든 요청이 정수 `turn_index`(경계 미확인은 0)를 갖게 되어 조건이 풀리고, 루프가 생기지 않습니다.

### 신규 쿼리

```js
getSessionRanking({ provider, since, until, limit })
getSessionFlow({ provider, sessionId, curvePoints })
upsertTurn({ provider, sessionId, turnIndex, startedAt, compacted, parserVersion })
resetTurns(provider, sessionId)
getLastTurnIndex(provider, sessionId)
hasUnattributedTurns(provider, sourcePath)
```

`getSessionRanking`/`getSessionFlow`의 프롬프트 토큰은 **provider 회계에 따라 다르게 더합니다** — `service/providers/accounting.mjs`의 표를 봅니다. Codex는 `cached ⊆ input`이라 그대로 더하면 캐시 읽기를 두 번 셉니다.

## 9. 마이그레이션 테스트

`test/codex-store.test.mjs`에 이미 legacy 스키마 업그레이드 테스트가 있습니다. 신규 항목마다 같은 형태로 추가합니다.

1. 컬럼 없는 기존 DB를 열어 `migrate()`가 컬럼을 추가하는지
2. 기존 행이 보존되는지
3. `event_key` 부분 UNIQUE 인덱스가 기존 NULL 행과 충돌하지 않는지
4. upsert가 같은 `(provider, event_key)`에 대해 행을 늘리지 않고 값만 갱신하는지
