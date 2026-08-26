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

## 결정 1: 있는 신호(컨텍스트 구성 breakdown)는 쓰고, 없는 신호(요청 단위 입출력)는 지어내지 않는다

**정정 (2026-08-25).** 처음엔 "로컬에 토큰 수 필드가 없다"고 결론 냈다가, 표본을
이진 blob 전체로 넓히자 뒤집혔습니다 — [measurements.md](./measurements.md#확인된-것-2차-조사--컨텍스트-구성-breakdown-진짜-토큰-수-필드)에
`5.1`/`5.2`/`5.3.3[]` 컨텍스트 구성 breakdown이 실측돼 있고, 카테고리별 토큰 합이
1,818개 표본 전부(CLI+IDE)에서 선언된 총합과 정확히 일치합니다. 그래서 이 결정은 "토큰 수가
없다"가 아니라 **"있는 종류의 신호와 없는 종류의 신호를 가른다"**로 다시 씁니다.

**있음 — 쓸 수 있는 것:**

- **컨텍스트 구성 breakdown**(`5.1` 총 토큰, `5.2` 창 크기, `5.3.3[]` 카테고리별
  토큰) — 실측 항등식 100% 일치. 단, 이건 "이 요청이 입력/출력 몇 개 썼나"가 아니라
  **"그 시점 컨텍스트 창에 무엇이 얼마나 들어있나"**입니다. `conversation` 카테고리의
  스냅샷 간 증가량으로 턴 사이 델타를 볼 수는 있지만, 사용자 메시지와 어시스턴트
  응답이 그 델타 안에서 안 갈립니다.
- **컨텍스트 점유율**(`composerHeaders.contextUsagePercent`) — 위 breakdown과 같은
  종류(백분율)이고 이제 `5.1/5.2`로 절대값까지 교차 검증됩니다.
- **요청/컴포저 수** — blob 개수·role 카운트·`composerHeaders` 행 수.
- **변경 라인 수**(`totalLinesAdded`/`totalLinesRemoved`) — 코드 diff.
- **프로젝트/시각 귀속**(`cwd`, `createdAt`, `trackedGitRepos`).

**없음(미확인) — 지어내지 않는 것:**

- provider별 **요청 단위** input/output/cache 토큰 델타(Codex/Claude/Gemini가 주는
  것과 같은 모양). breakdown은 스냅샷이라 이 모양이 아닙니다.
- 입력과 출력을 가른 값 — `conversation` 카테고리 하나에 섞여 있습니다.

R7("로그가 제공하지 않는 값은 비워 둔다")과 제품 원칙("정직한 불완전 측정")은
그대로 적용되고, 적용 대상만 "토큰 전부"에서 "요청 단위 입출력 분리"로 좁혀졌습니다.
**프롬프트 글자 수나 blob 바이트 크기로부터 토큰 수를 역산하지 않습니다** — 이제는
`5.3.3.3`(토큰)과 `5.3.3.4`(문자)가 나란히 있어 그럴 필요도 없어졌습니다. Cursor가
다른 provider와 완전히 같은 모양의 "토큰량" 열(입력/출력/캐시 델타)에 나타나는 일은
**당분간 없지만**, 컨텍스트 구성이라는 다른 모양의 실측값은 화면에 낼 수 있습니다
(아래 [README.md](./README.md)의 메뉴별 계획을 갱신했습니다).

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
  context_usage_percent REAL,         -- composerHeaders 관측값(있으면). 백분율
  context_total_tokens INTEGER,       -- 5.1 마지막 관측값 — 스냅샷, 요청 델타 아님
  context_window_tokens INTEGER,      -- 5.2 (관측: 200000 · 256000)
  context_breakdown TEXT,             -- 5.3.3[] 을 JSON으로: {"system_prompt":617,"tools":8460,...}
  parser_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
```

`context_total_tokens`/`context_breakdown`은 실측 항등식(Σbreakdown == total, 1,818/1,818
일치)이 뒷받침하는 값이라 "지어낸 것"이 아니지만, **요청 단위 원장이 아니라 스냅샷**
이라는 성격은 컬럼 이름에도 남깁니다(`context_` 접두사) — `usage_events`의
`total_tokens`와 같은 이름을 쓰면 같은 종류로 오해됩니다. `usage_events`와 나란히
존재하고, 엔진 집계·스냅샷 어디에서도 provider 합계 `totalTokens`에 더해지지
않습니다. 화면은 이 테이블을 **별도 패널**로 그립니다(아래 메뉴별 계획).

## 결정 5: capabilities에 `tokenLedger` 축을 새로 둔다 — 값은 `true`이지만 Codex/Claude/Gemini와 다른 모양

지금 capabilities는 `localLedger`(로컬 원장이 있는가)가 곧 "토큰을 잴 수 있는가"를
의미했습니다 — Codex/Claude/Gemini는 둘이 항상 같았기 때문입니다. Cursor는 **로컬
원장은 있고 토큰도 있지만, 그 토큰이 요청 단위 입출력 델타가 아니라 컨텍스트 구성
스냅샷인** 첫 사례라 그 둘을 갈라야 합니다. (정정 전에는 `tokenLedger: false`로
적었습니다 — [measurements.md](./measurements.md)의 2차 조사로 뒤집혔습니다.)

```js
// cursor capabilities (제안)
localLedger: true,          // cursor_local_activity 는 실측 원장입니다
tokenLedger: 'context_snapshot',  // 있지만 요청 단위 델타가 아니라 시점별 컨텍스트 구성입니다.
                                   // true/false 두 값으로는 이 차이를 못 담아 문자열로 둡니다 —
                                   // 화면 분기는 이 값이 'context_snapshot'이면 usage 시계열·
                                   // 캐시 적중률처럼 "요청 델타"를 전제한 계산에서 빠집니다.
serverQuota: false,         // 이 트랙은 Admin API를 호출하지 않습니다
turnLedger: false,          // 대화 구조는 있지만(role 나열) 턴 경계·도구 이름 매핑은 미확인
hooks: false,               // Cursor CLI hook 계약 미확인
credentials: 'none',        // 이 트랙은 자격증명을 저장하지 않습니다
accounting: 'context_only', // usage_events 의 input/output/cache 회계가 아니라
                             // cursor_local_activity 의 breakdown 회계 — accounting.mjs 조회 시
                             // 요청 단위 분해(decomposeTokens)로 넘기지 않고 얼리 리턴
```

`src/shared.js`에 `cursorSourceState()`를 추가해 `geminiSourceState()`/
`agy-unmeasured`와 같은 모양의 상태를 돌립니다. 다만 agy와 완전히 같은 문구는 아닙니다
— agy는 "신호 자체가 없다"였고 Cursor는 "신호는 있는데 모양이 다르다"입니다.

```js
{
  kind: 'context-snapshot-only',
  label: '로컬 감지 · 컨텍스트 구성만 (요청 단위 아님)',
  detail: 'Cursor 로컬 저장소는 시점별 컨텍스트 구성(시스템 프롬프트/도구/규칙/대화 등 ' +
          '카테고리별 토큰)은 주지만, 요청 단위 입력/출력 델타는 주지 않습니다. ' +
          '서버 사용량(Admin API)은 이 화면에서 다루지 않습니다.',
}
```

`providerUnavailable()`은 그대로 둡니다 — Cursor는 이제 `integration: 'connected'`가
되지만 `allTimeTotals.eventCount`(토큰 원장 이벤트 수)는 계속 0이므로, 기존 분기가
자동으로 "감지됐지만 토큰 없음" 경로를 타게 됩니다. 다만 그 안내 문구가 지금은
Gemini 전용 톤이라 Cursor 케이스를 추가해야 합니다.

## Phase 0 — 구현 전 조사 스파이크 — 완료 (2026-08-25, CLI+IDE 재확인까지 끝남)

**결과: CLI·IDE 양쪽에서 확인됨.** `scripts/probe-cursor.mjs`(`scripts/probe-antigravity.mjs`와
같은 모양, `antigravity-protobuf.mjs`의 `scanProtobuf` 재사용)로 CLI(`~/.cursor/chats`)와
IDE(`state.vscdb`의 `cursorDiskKV`) 양쪽의 이진 blob **95,722개**를 스캔해 `5.1`/`5.2`/
`5.3.3[]` 컨텍스트 구성 breakdown을 찾았고, breakdown이 있는 **1,818개 전부**에서
카테고리별 합이 총합과 정확히 일치했습니다(불일치 0).

**IDE 쪽 첫 실행이 6행만 본 이유는 잠금이 아니라 이 스크립트의 버그였습니다** —
`scanProtobuf`가 protobuf 아닌 바이트에 물리면 예외를 던지는데, 그 예외를 파일/소스
단위로 감싸서 잡고 있어 첫 예외 이후 149,692행이 조용히 버려졌습니다. 행 단위로
고쳐 재실행하자 149,698행 전체가 스캔됐습니다. 상세는
[measurements.md](./measurements.md#확인된-것-2차-조사--컨텍스트-구성-breakdown-진짜-토큰-수-필드).

**아직 안 한 것 (후속 조사, Phase 0b로 이름 유지):**

1. ~~IDE 쪽도 같은 breakdown을 주는지~~ — **완료.** IDE 쪽도 확인됨(위), 게다가
   CLI에는 없던 창 크기(272000·300000)가 IDE 쪽에서 추가로 나왔습니다.
2. `conversation` 카테고리의 스냅샷 간 증가량이 실제로 "그 턴에 추가된 토큰"과
   일치하는지, 사용자 메시지 쪽과 어시스턴트 응답 쪽을 가를 수 있는 별도 필드가
   있는지는 아직 못 봤습니다. 있다면 턴 단위 입/출력 분리가 가능해지고, 없다면
   결정 1의 "요청 단위로는 못 가른다"가 그대로 유지됩니다.
3. 같은 블롭이 반복 관측된 이유(같은 `conversation` 값이 두 blob에 연속으로
   나타남)를 밝혀야 재집계(멱등) 규칙을 안전하게 정할 수 있습니다 — 지금은
   "최신 관측값 승리"로 가정하고 있습니다.

1번이 끝났어도 2·3번을 마치기 전에는 파서를 커밋하지 않습니다 — 항등식은 확인했지만
델타·중복 규칙은 아직 확정이 아니기 때문입니다.

## 로드맵 재편

```text
M6a  Cursor 로컬 트랙 (이 문서)      — 원격 없음, 이번에 하는 것
M6b  Cursor Admin API (Team/Enterprise) — 기존 §5.3 그대로, 계정 확보 후 별도 착수
```

M6a는 M6b의 전제 조건이 아니고 M6b도 M6a의 전제 조건이 아닙니다 — 서로 다른 데이터
소스(로컬 파일 vs 인증된 API)라 한쪽이 없어도 다른 쪽이 동작합니다. 다만 화면에
같이 나타날 때는 [product rule](../../roadmap.md#product-rule)대로 라벨을 분리합니다
(`local · 미확립` vs `server_verified`).

### M6b 실측 (2026-08-26) — 실제 계정 키로 재확인, Cursor API는 두 종류였다

로컬을 3차까지 훑고 나서 "그럼 남은 건 Cursor가 주는 API"라는 질문에, 문서만 읽지
않고 실제 이 머신 Windows 환경변수에 있던 `CURSOR_API_KEY`로 직접 호출해
검증했습니다. 결과: **Cursor의 "API"는 하나가 아니라 서로 다른 두 표면**이고, 이
계정으로 열리는 쪽은 필요한 신호를 안 줍니다.

| API 표면 | 실측 결과 | 판정 |
|---|---|---|
| **Admin API** (`/teams/*`, §5.3의 그것) | `GET /teams/members` → **401 Unauthorized** | `admin:*` scope 없음 — 이 계정(Team, Admin 아님)으론 지금 못 씀. M6b는 그대로 대기 |
| **Cloud Agents API** (User API 키) | `GET /v1/me` → **200**, `{"apiKeyName":"COMP","userId":318580350,"userEmail":"kyjun.kim@miracom-inc.com",...}` | 유효한 User API 키가 맞음(admin 아님, 문서와 일치) |

Cloud Agents API 쪽은 인증은 되지만 **관측 대상이 다릅니다** — 공식 엔드포인트 목록
(`POST/GET /v1/agents`, `/v1/agents/{id}/runs`, `/v1/agents/{id}/usage` 등)을 확인한
결과, 토큰 사용량을 주는 유일한 엔드포인트는 `GET /v1/agents/{id}/usage`인데 이건
**`POST /v1/agents`로 API를 통해 새로 띄운 agent에만** 값이 생깁니다
(`totalUsage.{inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,totalTokens}`,
런 단위까지 나옴 — 어댑터 필드 이름과도 그대로 맞습니다). 지금까지 IDE(Composer)나
CLI(`cursor-agent`)로 쌓은 **기존** 대화 이력을 조회하는 GET은 이 API 표면 어디에도
없습니다 — "내 계정 전체 사용량"이 아니라 "내가 이 API로 새로 시킨 일"만 봅니다.

**결론**: Admin API는 등급 문제(admin scope 없음)로 막혀 있고, User API(Cloud Agents
API)는 등급 문제가 아니라 **관측 범위가 애초에 다릅니다**(신규 실행분만, 기존 이력
불가) — 둘 다 요청 단위 토큰 델타(rows 10/11이 필요로 하는 신호)를 못 줍니다. 이
표는 문서를 다시 읽어서가 아니라 실제 키로 두 엔드포인트를 호출해 나온 결과라
[measurements.md 3차 조사](./measurements.md#확인된-것-3차-조사--다른-db-파일에-있는-건-아닌가-재확인-나머지-표면-전부-스캔)와
같은 무게로 취급합니다 — M6a·M6b 둘 다 지금 이 계정으로는 rows 10/11을 채울 방법이
없다는 뜻입니다.

## 하지 않는 것

- Admin API 호출, API 키 입력 UI, `provider_credentials`/`provider_api_cursor` 테이블
- 레이트리밋 가드(`p-throttle`) — 호출할 원격이 없으므로 불필요
- 프롬프트 글자 수·blob 바이트 크기로부터 토큰 수 역산
- 대화 `content`, 시스템 프롬프트, 도구 입출력 본문을 원장·응답에 싣기
- `cursorAuth/*`, `secret://*` 등 시크릿 키를 읽거나 나열하기
- 세션 흐름/상세 화면에 Cursor를 턴 단위로 편입하기 — breakdown은 스냅샷이라 턴
  경계·입출력 분리가 아직 없습니다(위 Phase 0 후속 조사 2·3이 끝나기 전까지)
- `conversation` 카테고리의 스냅샷 증가량을 검증 없이 "이 턴이 쓴 토큰"이라고 표시하기
- Cursor 행을 `usage_events`에 0 또는 NULL 토큰으로 넣기 — breakdown은 별도
  `cursor_local_activity`로만 들어가고 요청 단위 원장에는 안 들어갑니다
