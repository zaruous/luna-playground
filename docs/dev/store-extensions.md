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

## 1. `usage_events` — 4개 컬럼 추가

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
upsertUsageEvent(event)   // ON CONFLICT(provider, event_key) DO UPDATE SET 토큰/품질/observed_at
```

기존 `insertUsageEvent`는 그대로 둡니다. Codex는 append-only 가정이 맞으므로 계속 insert 경로를 씁니다. **provider가 자기 저장 전략을 고르는 구조**이지, 전역 동작을 바꾸지 않습니다.

주의: `UNIQUE(provider, source_path, source_offset)`가 남아 있으므로, upsert 대상 행의 offset이 바뀌면 새 행이 생깁니다. Claude 어댑터는 upsert 시 `source_offset`을 **갱신하지 않고 최초 값을 유지**해야 합니다.

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

## 8. 집계 쿼리 추가

[menus/usage.md](./menus/usage.md)의 시계열 화면에 필요합니다.

```js
getUsageTimeseries({ provider, model, bucket, since, until })
// bucket: 'hour' | 'day' | 'week' | 'month'
// SQLite strftime으로 버킷 키를 만들고 GROUP BY

getModelBreakdown({ provider, since, until })
getProjectBreakdown({ provider, since, until, limit })
getQuotaHistory({ provider, limitId, windowMinutes, since })
```

사전 집계 테이블은 만들지 않습니다. 현재 데이터 규모(수천 이벤트/월)에서 `usage_events` 인덱스로 충분하고, 이중 원장은 정합성 위험만 늘립니다. 규모가 커지면 그때 `(provider, model, bucket_start)` 버킷 테이블을 도입합니다 — 조사에서 본 Token Tracker의 30분 버킷 방식이 참고 대상입니다.

## 9. 마이그레이션 테스트

`test/codex-store.test.mjs`에 이미 legacy 스키마 업그레이드 테스트가 있습니다. 신규 항목마다 같은 형태로 추가합니다.

1. 컬럼 없는 기존 DB를 열어 `migrate()`가 컬럼을 추가하는지
2. 기존 행이 보존되는지
3. `event_key` 부분 UNIQUE 인덱스가 기존 NULL 행과 충돌하지 않는지
4. upsert가 같은 `(provider, event_key)`에 대해 행을 늘리지 않고 값만 갱신하는지
