# 프로젝트 (`project`)

**현재 상태: 구현됨 (M2).** 화면은 `src/views/ProjectView.jsx` 이고, 목록·상세·별칭·경로
가림·세션 화면과의 양방향 이동이 들어갔습니다. 대시보드의 최근 6개 요약
(`snapshot.projects`)은 그대로 요약으로 남습니다.

기간은 `이번 달` / `전체 기간` 두 갈래이고 목록과 상세가 같은 기간을 씁니다. 전체
기간일 때 목록 상한은 500 개입니다.

**세션 화면에서 넘어온 프로젝트 키가 목록에 없으면 대신 다른 프로젝트를 열지
않습니다.** 세션 목록은 전체 기간을 볼 수 있고 프로젝트 목록은 이번 달만 볼 수
있어서, 조용히 대체하면 별칭 저장과 경로 가림 버튼이 **엉뚱한 프로젝트에** 걸립니다
— 라벨만 틀리는 것이 아니라 잘못된 쓰기입니다. 그래서 안내를 띄우고 기간을 넓히도록
유도합니다(`selectionMissing` / `focusMissing`).

**넘어온 프로젝트로 선택을 잠그지는 않습니다.** 예전에는 넘어온 키를 그대로
`activeKey` 로 못 박아, 왼쪽 목록에서 다른 프로젝트를 눌러도 화면이 바뀌지
않았습니다 — 세션 화면을 거쳐 들어오면 프로젝트 화면이 한 프로젝트에 갇혔습니다.
지금은 넘어온 키를 **선택의 초기값**으로만 쓰고, 대신 그 프로젝트 **이름을 검색
필터에** 걸어 목록을 좁힙니다. 이름은 세션 화면이 넘겨 준 값이 아니라 목록이
도착한 뒤 그 목록에서 읽습니다 — 별칭·가림·`(미분류)` 때문에 두 화면의 이름이
갈릴 수 있고, 안 맞는 이름을 걸면 목록이 텅 빕니다. 검색어를 지우면(`검색 지우기`)
전체 목록으로 돌아갑니다.

무엇을 열지 정하는 규칙은 `src/project-focus.js` 에 있습니다. 화면과 갈라 둔 이유는
이 규칙이 표시가 아니라 **쓰기 대상**을 정하기 때문입니다. 계약은 둘입니다 —
(1) 고른 프로젝트가 목록에 있으면 **검색어에 가려져도** 그것을 연다(검색은 목록을
좁히는 손잡이이고 선택을 옮기는 손잡이가 아니다), (2) 목록에 아예 없으면 아무것도
열지 않고 그렇게 적는다.

프로젝트 귀속은 provider마다 근거가 다릅니다. Codex는 세션의 `cwd`, Claude는 대화 파일이 놓인 프로젝트 디렉터리, Gemini는 **경로를 해시한 `<project_hash>`** 입니다. 이 화면은 그 차이를 감추지 않고 드러내야 합니다.

## 화면 미리보기

![프로젝트 와이어프레임](../assets/project.svg)

## 화면 요소

| 영역 | 내용 |
|---|---|
| 좌측 목록 | 프로젝트 검색(+`검색 지우기`), 토큰 순 정렬, provider 표시. 가림된 항목은 별칭/해시로 표시 |
| 상세 헤더 | 프로젝트명, 실제 경로, 가림 토글 |
| 요약 4칸 | 총 토큰 / 세션 수 / 사용 모델 수 / 최근 활동 |
| 모델 분포 | 해당 프로젝트 내 모델별 비중 |
| 세션 표 | 세션 id, 모델, 토큰, 시각, 상세 (최근 N개) |
| 세션 턴 분석 | 세션 표의 한 줄을 누르면 **그 줄 바로 아래로** 펼쳐지는 비싼 턴 표와 턴 상세 (아래 절) |

## 세션 표 → 비싼 턴 → 턴 상세

"이 프로젝트가 얼마를 썼나" 다음 질문은 늘 "어느 세션의 어느 턴이 비쌌고, 그 턴이
무엇에 썼나" 입니다. 그걸 보려고 세션 흐름 화면으로 옮겨 가서 그 세션을 다시 찾게
하지 않습니다 — 세션 표의 한 줄을 누르면 세션 흐름 화면과 **같은** 비싼 턴 표와
같은 턴 상세가 그 자리에서 펼쳐집니다(`src/views/SessionTurns.jsx`).

- 컴포넌트가 한 개이므로 컬럼·정렬·상세 펼침이 두 화면에서 갈라지지 않습니다.
- 흐름 조회(`/sessions/:id/flow`)는 줄을 펼쳤을 때만, 턴 상세(원본 파일 재독)는 그
  안에서 턴을 펼쳤을 때만 부릅니다. 그래서 세션이 여러 개인 프로젝트를 열어도
  목록을 그리는 값에는 무거운 호출이 없습니다.
- 한 번에 한 세션만 펼칩니다. 여러 개를 동시에 열면 같은 원본 파일을 그만큼 다시
  읽습니다.
- 프로젝트는 provider 단위로 갈리므로, 이 표의 세션 provider 는 프로젝트의
  provider 입니다 — 세션 표에 provider 칸을 따로 두지 않는 이유입니다.
- 원장에 `session_id` 가 없는 묶음은 흐름을 찾을 수 없으므로 손잡이를 잠급니다.
  눌러서 404 를 보게 하지 않습니다.
- 곡선과 단계별 배분은 세션 흐름 화면에 남깁니다. 여기서 위로 올라가려면
  펼친 블록의 `세션 흐름 →` 로 갑니다.

## 귀속 규칙

| provider | 귀속 근거 | 실패 시 |
|---|---|---|
| Codex | 세션 `turn_context.cwd` | `(미분류)` 버킷 |
| Claude | `~/.claude/projects/<dir>` 이름 | 디렉터리명 그대로 |
| Gemini | `<project_hash>` — **역매핑 불가** | 해시 앞 4자리 표시, 세션 메타의 경로가 있으면 우선 |
| Cursor | CLI `meta.json.cwd` / IDE `composerHeaders.value.workspaceIdentifier`·`trackedGitRepos` | `(미분류)` 버킷(다른 provider와 동일) |

**Cursor는 이제 이 화면에 나타납니다(T3 참고).** Admin API가 아니라 로컬 로그(CLI+IDE)에서
cwd를 직접 읽으므로, 이전 문서의 "Admin API가 프로젝트 정보를 주지 않아 나타나지 않는다"는
서술은 더는 사실이 아닙니다 — `cursor_local_activity` 테이블에서 프로젝트별로 묶어 옵니다.
다만 요청 단위 토큰이 없어(결정 4) 총 토큰/모델 수/세션 표는 채우지 못하고 "—" 또는 빈
상태로 남습니다.

## 경로 가림

프로젝트 경로에는 고객사명·사내 코드명이 들어갑니다. 스크린샷 공유나 화면 공유 상황을 위해 가림이 필요합니다.

```sql
-- store-extensions.md §7
project_aliases(provider, project_key, alias, redacted, updated_at)
```

- `redacted = 1`이면 **서비스가 스냅샷을 만들 때** `cwd`를 빈 값으로 치환하고 별칭만 내보냅니다. 클라이언트에서 CSS로 가리는 방식이 아닙니다 — 그러면 HTTP 응답에 원본이 남습니다.
- 원본 경로는 로컬 SQLite에만 남습니다.
- 별칭은 목록·상세·시계열·CSV 내보내기 전부에 일관 적용합니다.

## API

```
GET  /api/v1/projects?since=&until=&provider=&limit=
       → { projects: [{ key, provider, alias, redacted, tokens, sessionCount, lastActivityAt }] }
GET  /api/v1/projects/:key?since=&until=
       → { project, tokens, models: [...], sessions: [...] }
PUT  /api/v1/projects/:key/alias   { alias, redacted }
```

`:key`는 경로 그대로가 아니라 **해시**를 씁니다. 원본 경로를 URL에 넣으면 서버 로그·브라우저 히스토리에 남습니다.

**Cursor 행의 응답 모양은 다릅니다(T3).** `project.totalTokens`/`project.modelCount`는
`null`(0이 아님 — 있지도 않은 델타를 지어내지 않습니다, R7)이고, `project.sessionCount`는
세션이 아니라 **컴포저(대화) 수**입니다. `getProjectDetail`의 `models`/`sessions`는 항상
빈 배열이고, 대신 `cursorActivity: { composerCount, requestCount, linesAdded, linesRemoved,
lastObserved }`가 붙습니다.

## 스토어 쿼리

```js
getProjectBreakdown({ provider, since, until, limit })
getProjectDetail({ projectKey, since, until })
getProjectSessions({ projectKey, limit })
getCursorProjectActivity({ projectName, since, until })   // (신규) T3
```

기존 `getRecentProjectsAcrossProviders(6, since)`는 대시보드 요약 전용으로 남기고, 이 화면은 정렬·필터·페이지네이션이 가능한 신규 쿼리를 씁니다.

`getProjectBreakdown`은 `provider`가 없거나 `'cursor'`면 `cursor_local_activity`를 별도
쿼리(`#getCursorProjectBreakdown`)로 모아 배열 **뒤에 이어 붙입니다** — 앞쪽 usage_events
결과의 `ORDER BY total_tokens DESC` 순위 안에 섞지 않습니다. Cursor에는 비교 가능한 토큰
총량이 없어(R7) 0으로 채워 그 순위에 끼워 넣으면 실제로 활발한 프로젝트가 조용히 맨
뒤로 밀리고 `LIMIT`에 잘려 나갈 수 있기 때문입니다 — 대신 자기 그룹 안에서만 최근
관측(`last_updated_at`) 순으로 정렬합니다. `#resolveProjectKey`도 `usage_events`뿐
아니라 `cursor_local_activity`의 프로젝트 이름을 함께 봅니다 — 안 그러면 대시보드/상세
내역 화면이 이미 내려주는 Cursor `projectKey`를 눌러도 이 화면에서 항상 404가 납니다.

## 상태 처리

| 상황 | 표시 |
|---|---|
| 프로젝트 0개 | 첫 수집 안내 |
| `cwd` 없는 세션 | `(미분류)` 프로젝트로 묶고 이유 표기 |
| Gemini 해시만 있음 | `(가림) project_hash a1b2` 형태, 별칭 지정 유도 |
| 가림된 프로젝트 | 목록·상세·내보내기 모두 별칭 |

## TODO — 확정된 개선 항목

### T3. Cursor 프로젝트 반영 — 완료

Cursor는 `getProjectBreakdown`/`getProjectDetail`이 `usage_events`만 보고 있어 이
화면에 전혀 나타나지 않았습니다(`ProjectView.jsx:219`의 안내 문구, 위 귀속 규칙 표
참고 — 둘 다 "Admin API가 프로젝트 정보를 주지 않는다"고 적혀 있었는데, 이 트랙
자체가 Admin API를 안 쓰는 로컬 트랙(M6a)이라 애초에 틀린 이유였습니다).

- **목록**: `getProjectBreakdown`이 `cursor_local_activity`를 별도로 모아
  usage_events 결과 뒤에 붙입니다(위 "스토어 쿼리" 절 — 토큰 순위엔 안 섞음).
  `#resolveProjectKey`도 두 테이블을 함께 봅니다.
- **상세 카드**: 총 토큰·모델 수는 `null`("—"), 세션 자리는 "대화" 라벨로 컴포저
  수를 보여줍니다.
- **별칭·경로 가림**: 별도 구현이 없습니다 — `#applyProjectPrivacy`가
  `(provider, name)` 쌍만 보므로 Cursor 행이 화면에 뜨는 순간 공짜로 적용됩니다.
- **모델 분포·세션 표**: 여전히 X입니다(요청 단위 개념이 없음, 세션 흐름 화면과
  같은 이유) — 빈 배열 + 이유를 설명하는 문구로 남깁니다. 세션 표를 지어내지
  않는 이유는 [docs/dev/cursor/decisions.md](../cursor/decisions.md) 결정 4·Phase 0b
  참고.
- **(신규) "Cursor 활동" 카드**: `getCursorProjectActivity`가 요청 수·변경
  라인·마지막 관측 컨텍스트를 합산해 줍니다 — 위 "△" 카드가 못 채우는 자리를
  대신 채웁니다.

자세한 판정 표는 [기능적용가능성.md](../cursor/기능적용가능성.md#프로젝트-projectviewjsx)
와 [project-coverage.svg](../cursor/project-coverage.svg)를 참고하세요.

이번 패스가 다루지 않은 것: 모델 분포·세션 표(요청 단위 턴 경계가 없어 Phase 0b
전까지는 배제).

### T4. Cursor "(미분류)" 버킷 정합성 — 완료

T3를 검증하려고 돌린 적대적 리뷰(Workflow, 3차원 review→verify)가 cwd 없는
Cursor 컴포저(project_name이 빈 문자열이 아니라 SQL `NULL`인 경우)에서 실제
결함 둘을 찾았습니다 — 둘 다 재현·수정·회귀 테스트까지 마쳤습니다.

- **"(미분류)" 상세 카드가 항상 0으로 나옴.** `getCursorProjectActivity`가
  `WHERE project_name = ?`을 빈 문자열에 바인딩했는데, cwd 없는 컴포저는
  실제 컬럼값이 `NULL`이라 SQLite에서 `NULL = ''`은 매칭되지 않습니다. 그
  결과 프로젝트 목록의 "대화" 수(`sessionCount`, 예: 2)와 바로 아래 "Cursor
  활동" 카드(요청 수·변경 라인·컨텍스트)가 항상 0/—으로 서로 모순됐습니다 —
  화면 하나 안에서 두 숫자가 어긋나는, R7이 원래 막으려던 모양의 결함이 회귀로
  들어온 경우입니다. `#getCursorProjectBreakdown`/`#resolveProjectKey`가 이미
  쓰던 `COALESCE(NULLIF(project_name,''), '(미분류)')` 비교로 맞췄습니다
  (`service/store.mjs`의 `getCursorProjectActivity`, `getProjectDetail`).
- **"최근 프로젝트"와 프로젝트 화면이 같은 (미분류) 버킷을 다른 키로 가리킴.**
  `getRecentProjectsAcrossProviders`(대시보드·상세 내역이 쓰는, 이번 트랙에서
  손대지 않은 기존 쿼리)는 cwd 없는 Cursor 행을 `'unknown-project'`로,
  `#getCursorProjectBreakdown`/`#resolveProjectKey`(이번 트랙에서 새로 만든
  쿼리)는 `'(미분류)'`로 접었습니다. 이름이 다르면 `projectKeyOf`가 다른
  해시를 내므로, 대시보드에서 이 버킷을 클릭하면 프로젝트 화면이 "찾지
  못했어요"를 띄웠습니다 — 바로 이 T3가 막으려 했던 404 패턴이 이름 없는
  버킷 하나에서만 다시 새어 나온 것입니다. `getRecentProjectsAcrossProviders`의
  Cursor UNION 몫만 `'(미분류)'`로 맞췄습니다(다른 provider가 쓰는
  `'unknown-project'` 분기는 그대로 둠 — 그건 실제로 빈 문자열이 저장되는
  경로가 없어 이 결함과 무관합니다).
- **다루지 않은 것(경미·의도된 트레이드오프로 문서화만 함):** `getProjectBreakdown(provider=null)`이
  `usage_events` 상위 `limit`개 + Cursor 상위 `limit`개를 이어 붙이는 구조라
  `provider` 무필터일 때 응답이 최대 2×`limit`행일 수 있습니다 — 토큰 순위
  상위 항목이 잘리지는 않으므로(그게 "붙이고 안 섞기" 설계의 목적입니다) 지금은
  손대지 않았습니다. `src/views/UsageView.jsx`의 컨텍스트 구성 막대도, CLI
  blob에 창 크기(필드 5.2) 없이 총 토큰(5.1)만 있는 드문 경우엔 분모가 총
  토큰으로 대체된다는 사실을 그 행에 "창 크기 미상(막대는 합계 기준)" 문구로
  드러내는 선에서 처리했습니다(막대 자체를 다시 설계하지 않음).

## 완료 기준

- [ ] 가림 켠 프로젝트의 원본 경로가 HTTP 응답 어디에도 없음 (테스트로 확인)
- [ ] 프로젝트 토큰 합이 provider 총합 이하이고, `(미분류)` 포함 시 정확히 일치
- [ ] URL에 원본 경로가 노출되지 않음
- [ ] 별칭이 CSV 내보내기까지 반영
- [x] 세션 화면에서 넘어와도 왼쪽 목록에서 다른 프로젝트를 고를 수 있고, 목록에 없는
      키는 다른 프로젝트로 대체되지 않음 (`test/session-turns.test.mjs`)
- [x] 세션 표에서 펼친 비싼 턴 목록이 세션 흐름 화면과 같은 규칙으로 뽑힘
      (`test/session-turns.test.mjs`)
- [x] (T3) Cursor 프로젝트가 목록·상세·별칭·가림에 나타나고, 요청 단위 개념(총
      토큰·모델 수·모델 분포·세션 표)은 지어내지 않고 "—"/빈 상태로 남음 —
      `test/usage-aggregation.test.mjs`의 "getProjectBreakdown 은 Cursor 를 토큰
      순위에 안 섞고 뒤에 별도로 붙인다" · "getProjectDetail 은 Cursor projectKey
      도 찾아 다른 모양의 상세를 준다" · "Cursor 프로젝트도 별칭·경로 가림이
      별도 구현 없이 자동 적용된다"
- [x] (T4) cwd 없는 Cursor 컴포저("(미분류)" 버킷)도 상세 카드가 실제 값을
      보여주고, "최근 프로젝트"와 프로젝트 화면이 같은 키로 그 버킷을 가리킴 —
      `test/usage-aggregation.test.mjs`의 "cwd 없는 Cursor 컴포저도 \"(미분류)\"
      프로젝트 상세에서 0으로 안 보인다" · "cwd 없는 Cursor 프로젝트는 \"최근
      프로젝트\" 목록과 프로젝트 화면이 같은 키를 가리킨다"

## 하지 않는 것

- Gemini 해시를 역산하려고 시도하기 (사전 공격식 추정)
- 프로젝트 경로에서 사용자명을 자동 추출해 표시하기
