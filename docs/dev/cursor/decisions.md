# 설계 결정 — 로컬 전용 Cursor 트랙

이 문서는 [measurements.md](./measurements.md)의 실측 결과 위에서 내린 결정과, 그
결정이 기존 계획([provider-token-api.md §5.3](../provider-token-api.md),
[roadmap.md Phase 3](../../roadmap.md), [implementation-plan.md
M6](../implementation-plan.md#m6--cursor-어댑터))과 갈라지는 지점을 적습니다.

## 결정 0: 이 트랙은 원격 사용량을 다루지 않는다

기존 M6은 Admin API(서버 사용량)를 1차, 로컬을 "개인 계정 보조"로 뒀습니다. 이 트랙은
반대로 **로컬만** 다루고 Admin API·자격증명 저장·레이트리밋 인프라를 이번 범위에서
아예 만들지 않습니다. 이유는 세 가지입니다.

1. 요청받은 범위가 그렇습니다 — 원격 사용량 배제, 로컬 토큰량 측정 기준.
2. `provider_credentials`/`provider_api_cursor`/`p-throttle` 세 가지 새 인프라가
   전부 원격 경로 전용이었습니다([store-extensions.md §3~§5](../store-extensions.md)).
   로컬만 하면 그 셋이 전부 필요 없어져 이번 트랙의 구현 표면이 크게 줄어듭니다.
3. 기존 M6이 이미 "Personal: 로컬 상태는 귀속에 쓸 수 있어도 과금 근거로 자동
   승격하지 않는다"([roadmap.md](../../roadmap.md))고 적어 뒀던 방향과 정확히
   같은 결론입니다 — 이번 실측이 그 방향의 실행 계획입니다.

기존 M6 문서는 지우지 않습니다. Admin API 경로는 Team/Enterprise 계정에서만 의미가
있고 계정이 있어야 검증할 수 있는 별도 작업이라 **M6b로 미룹니다**(아래
[로드맵 재편](#로드맵-재편)). 이 문서가 다루는 것은 M6a입니다.

## 결정 1: 토큰 수를 지어내지 않는다

[measurements.md](./measurements.md)가 실측한 대로, 로컬 저장소 어디에도 input/output/
cache 토큰 수 필드가 없습니다(평문 JSON blob 3,629개 전수 검사 0건). 있는 것은:

- **컨텍스트 점유율**(`composerHeaders.contextUsagePercent`) — 백분율, 토큰 아님
- **요청/컴포저 수** — blob 개수·role 카운트·`composerHeaders` 행 수로 셀 수 있음
- **변경 라인 수**(`totalLinesAdded`/`totalLinesRemoved`) — 코드 diff, 토큰 아님
- **프로젝트/시각 귀속**(`cwd`, `createdAt`, `trackedGitRepos`)

R7("로그가 제공하지 않는 값은 비워 둔다")과 제품 원칙("정직한 불완전 측정")을
그대로 따릅니다. **프롬프트 글자 수나 blob 바이트 크기로부터 토큰 수를
역산하지 않습니다** — 어림값을 정밀한 값처럼 보이게 만드는 것은 이 프로젝트가
피하는 바로 그것입니다(Codex 백분율 한도를 토큰으로 환산하지 않는 것과 같은 R5의
연장). Cursor가 다른 provider들과 같은 "토큰량" 열에 나타나는 일은 **당분간 없습니다.**

## 결정 2: 대화 blob은 구조만 취하고 본문은 절대 읽지 않는다

평문 JSON blob은 파싱해도 `role` 필드만 취하고 `content`는 버립니다. 이진 blob은
protobuf wire-scanner로 필드 **번호**만 보고, 문자열로 디코드되는 하위 필드 중
경로·시각·클라이언트타입처럼 구조로 분류된 것만 취합니다 — 애매하면(사람이 쓴
문장처럼 보이면) 버립니다. `cursorAuth/*`, `secret://*` 키는 파서가 절대 열지
않습니다(경로 목록에도 올리지 않습니다).

이건 기존 규칙의 재확인이 아니라 **더 엄격한 적용**입니다 — Claude/Codex/Gemini는
로그 한 줄(JSON 레코드)에서 토큰 필드와 본문 필드가 나란히 있어 필드명으로
가르면 됐습니다. Cursor는 대화 저장소 자체가 내용 주소화 blob store라서, 실수로
`SELECT data FROM blobs`를 그대로 원장에 넣으면 **원장이 대화 아카이브의 사본이
됩니다.** 그래서 파서 계약에 "본문에 닿는 코드 경로가 있는가"를 코드 리뷰
체크리스트 항목으로 명시합니다.

## 결정 3: SQLite는 tail이 아니라 content-hash 스냅샷으로 읽는다

Codex/Claude는 append-only JSONL이라 byte offset tail이 맞습니다. Cursor의
`store.db`/`state.vscdb`는 **WAL로 재작성되는 SQLite**이고, blob은 내용 주소화라
같은 내용이 다시 안 나오지만 새 blob이 파일 어디에 붙는지는 SQLite 내부 구현에
맡겨져 있어 byte offset 기준이 성립하지 않습니다. Gemini의 `.json` 전체 스냅샷
전략(M5, mtime+size → content hash로 재파싱 여부 결정)과 같은 이유로 같은 전략을
씁니다 — `provider:strategy` 디스패치에 `cursor:sqlite-snapshot`을 추가합니다
([implementation-plan.md M5](../implementation-plan.md#m5--gemini-cli-어댑터--완료)의
전략 확장을 그대로 재사용).

스캔 단위는 파일별 `mtime+size`로 1차 필터하고, 바뀌었으면 그 파일의
`composerId`/`chatId` 집합과 각 행의 `content_hash`(JSON 직렬화 후 sha256)를 이전
스캔과 비교해 **새로 생기거나 갱신된 컴포저/채팅만** 재해석합니다. Composer는
`lastUpdatedAt`이 있어 이 필드로 먼저 좁힐 수 있습니다.

## 결정 4: 새 테이블, `usage_events`에 얹지 않는다

Cursor 행을 `usage_events`에 0 토큰으로 넣으면 R7 위반이고("미확인"과 "0"이 같은
글자가 됩니다), NULL로 넣으면 기존 집계 SQL(`SUM(...)`, `total_tokens DESC` 정렬)이
Cursor를 항상 꼴찌 또는 예외로 다뤄야 합니다. `provider_request_events`
([store-extensions.md §4](../store-extensions.md))도 안 맞습니다 — 그건 Admin API의
요청 기반 플랜(과금 단위 = 요청 1건)을 위해 만든 것이고 `charged_cents`가 핵심인데
로컬에는 금액이 없습니다.

새 테이블 `cursor_local_activity`를 제안합니다(§11로
[store-extensions.md](../store-extensions.md)에 추가 예정).

```sql
CREATE TABLE IF NOT EXISTS cursor_local_activity (
  composer_id TEXT PRIMARY KEY,       -- IDE: composerHeaders.composerId / CLI: chatId
  surface TEXT NOT NULL,              -- 'ide' | 'cli'
  workspace_id TEXT,
  cwd TEXT,
  project_name TEXT,
  created_at TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,   -- role='user' blob 개수
  lines_added INTEGER,
  lines_removed INTEGER,
  context_usage_percent REAL,         -- 마지막 관측값. 토큰 아님 — 이름에 그대로 남김
  parser_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
```

`usage_events`와 나란히 존재하고, 엔진 집계·스냅샷 어디에서도 `totalTokens`에
더해지지 않습니다. 화면은 이 테이블을 **별도 패널**로 그립니다(아래 메뉴별 계획).

## 결정 5: capabilities에 `tokenLedger` 축을 새로 둔다

지금 capabilities는 `localLedger`(로컬 원장이 있는가)가 곧 "토큰을 잴 수 있는가"를
의미했습니다 — Codex/Claude/Gemini는 둘이 항상 같았기 때문입니다. Cursor는 **로컬
원장은 있는데 토큰은 없는** 첫 사례라 그 둘을 갈라야 합니다.

```js
// cursor capabilities (제안)
localLedger: true,          // cursor_local_activity 는 실측 원장입니다
tokenLedger: false,         // 위 테이블에 input/output/cache 토큰이 없습니다
serverQuota: false,         // 이 트랙은 Admin API를 호출하지 않습니다
turnLedger: false,          // 대화 구조는 있지만(role 나열) 턴 경계·도구 이름 매핑은 미확인(Phase 0 이후 재검토)
hooks: false,               // Cursor CLI hook 계약 미확인
credentials: 'none',        // 이 트랙은 자격증명을 저장하지 않습니다
accounting: 'none',         // 토큰 회계 자체가 없음 — accounting.mjs 조회 시 얼리 리턴
```

`src/shared.js`에 `cursorSourceState()`를 추가해 `geminiSourceState()`/
`agy-unmeasured`와 같은 모양의 상태를 돌립니다 — 실제로 이 상황은 agy 케이스와
구조적으로 같습니다("감지는 됐는데 이 신호는 못 잰다").

```js
{
  kind: 'local-unmeasured',
  label: '로컬 감지 · 토큰 회계 없음',
  detail: 'Cursor 로컬 저장소에 대화·요청 수는 있지만 토큰 수 필드가 없습니다. ' +
          '서버 사용량(Admin API)은 이 화면에서 다루지 않습니다.',
}
```

`providerUnavailable()`은 그대로 둡니다 — Cursor는 이제 `integration: 'connected'`가
되지만 `allTimeTotals.eventCount`(토큰 원장 이벤트 수)는 계속 0이므로, 기존 분기가
자동으로 "감지됐지만 토큰 없음" 경로를 타게 됩니다. 다만 그 안내 문구가 지금은
Gemini 전용 톤이라 Cursor 케이스를 추가해야 합니다.

## Phase 0 — 구현 전 조사 스파이크 (착수 전 필수)

[measurements.md](./measurements.md#이진-blob의-필드-의미--1차-스캔표본-12개에서-후보-없음-확정-아님)가
표본 12개로 남긴 열린 질문입니다. 이진 blob에 토큰 수가 정말 없는지, 표본을 늘려
확정하기 전에는 파서를 쓰지 않습니다 — agy 조사에서 "grep으로 없다고 봤다가
틀렸다"를 반복하지 않기 위해서입니다.

**산출물**: `scripts/probe-cursor.mjs`. `scripts/probe-antigravity.mjs`와 같은 모양 —
`service/providers/gemini/antigravity-protobuf.mjs`의 `scanProtobuf`/`toBytes`를
그대로 재사용(protobuf wire format은 provider 중립)해서:

1. `~/.cursor/chats/**/store.db`(blobs)와 `state.vscdb`의 `cursorDiskKV`
   (`agentKv:blob:%`) 양쪽을 대상으로,
2. 첫 바이트가 `{`/`[`인 blob(평문 JSON)은 **건드리지 않고 건너뛰고**,
3. 나머지 이진 blob만 재귀 스캔해 필드 경로별 count/min/max/단조성/조각-합 후보를
   낸다(`candidateIdentities()` 그대로 재사용).

**판단 기준**: 필드 경로 후보가 나오면 그 필드가 (a) 한 컴포저 안에서 단조 증가하고
(b) `composerHeaders.contextUsagePercent`가 크게 뛰는 시점과 같이 움직이는지 대조합니다
— 그러면 컨텍스트/토큰류 신호일 가능성이 있습니다. 후보가 없으면(1차 표본과 같은
결과) **토큰 필드는 없다고 결론**하고 결정 1~5로 진행합니다. 어느 쪽이든 결과를
`measurements.md`에 추가해 남깁니다.

## 로드맵 재편

```text
M6a  Cursor 로컬 트랙 (이 문서)      — 원격 없음, 이번에 하는 것
M6b  Cursor Admin API (Team/Enterprise) — 기존 §5.3 그대로, 계정 확보 후 별도 착수
```

M6a는 M6b의 전제 조건이 아니고 M6b도 M6a의 전제 조건이 아닙니다 — 서로 다른 데이터
소스(로컬 파일 vs 인증된 API)라 한쪽이 없어도 다른 쪽이 동작합니다. 다만 화면에
같이 나타날 때는 [product rule](../../roadmap.md#product-rule)대로 라벨을 분리합니다
(`local · 미확립` vs `server_verified`).

## 하지 않는 것

- Admin API 호출, API 키 입력 UI, `provider_credentials`/`provider_api_cursor` 테이블
- 레이트리밋 가드(`p-throttle`) — 호출할 원격이 없으므로 불필요
- 프롬프트 글자 수·blob 바이트 크기로부터 토큰 수 역산
- 대화 `content`, 시스템 프롬프트, 도구 입출력 본문을 원장·응답에 싣기
- `cursorAuth/*`, `secret://*` 등 시크릿 키를 읽거나 나열하기
- 세션 흐름/상세 화면에 Cursor를 턴 단위로 편입하기(Phase 0 결과가 나오기 전까지)
- Cursor 행을 `usage_events`에 0 또는 NULL 토큰으로 넣기
