# AI 사용량 (`usage`)

**현재 상태: 구현됨 (M2).** 화면은 `src/views/UsageView.jsx` 입니다. 아래 계획 중
**상세 표(버킷 × provider × 모델, 페이지네이션)와 `GET /api/v1/usage/events` 는
들어가지 않았습니다** — 그 자리에는 provider별 한 줄 요약 표가 있습니다.

대시보드가 "지금 상태"를 보여주는 화면이라면, 이 화면은 **기간 · provider · 모델 · 토큰 종류로 쪼개 보는** 화면입니다.

## 화면 미리보기

![AI 사용량 와이어프레임](../assets/usage.svg)

## 화면 요소

| 영역 | 내용 |
|---|---|
| 필터 바 | **구현됨** 기간(7/30일 · 이번 달 · **전체 기간**), provider, 버킷(시간/일/주/월). 모델 필터와 사용자 지정 기간은 미구현 |
| 추이 차트 | **구현됨** 버킷별 토큰 종류 누적 막대 — 입력 / 캐시 읽기 / 캐시 쓰기 / 출력 / 추론 / 도구 |
| 모델별 비중 | **구현됨** 기간 내 모델별 합계와 비율 |
| 기간 합계 | **구현됨** 차트에 그려진 버킷의 합. 종류별 다섯 조각 — 아래 [TODO T1](#todo) 참조 |
| 상세 표 | **미구현** 계획은 버킷 × provider × 모델 행 + 페이지네이션이었고, 들어간 것은 **provider별 한 줄** 표(정렬 가능, 품질 열 포함)입니다 |
| 내보내기 | **미구현** 현재 필터 결과를 CSV로 (M7) |
| Cursor — 컨텍스트 구성 | **구현됨(T2)** 위 추이 차트와 완전히 다른 계약(요청 델타가 아니라 컨텍스트 스냅샷) — 별도 패널·별도 엔드포인트 |

토큰 종류를 6개로 쪼개는 이유는 provider마다 제공 범주가 달라서입니다 — Codex에는 도구 토큰이 없고, Gemini에는 캐시 쓰기가 없습니다. 하나로 합치면 "왜 provider마다 합이 다르게 보이는가"를 설명할 수 없습니다.

## API

```
GET /api/v1/usage/timeseries?bucket=day&since=&all=&provider=      구현됨
  → { bucket, series: [{ bucketStart, provider, tokens: {...} }] }
     계획에 있던 model·quality 는 응답에 없습니다 — 버킷은 provider 단위로만
     묶습니다. 모델까지 쪼개면 버킷 수가 모델 수만큼 늘고, 화면에서 모델을
     보는 곳은 아래 models 응답입니다.

GET /api/v1/usage/models?since=&all=&provider=                     구현됨
  → { models: [{ model, provider, tokens: {...}, share }] }

GET /api/v1/usage/events?...&page=&pageSize=                       미구현
  → { rows: [...], page, pageSize, total }     // 상세 표 (페이지네이션)

GET /api/v1/cursor/context?since=&until=&all=                      구현됨(T2)
  → { composers: [{ composerId, surface, projectName, cwd, redacted,
                     observedAt, totalTokens, windowTokens, breakdown }],
      ideExcluded }
     위 timeseries/models 와 계약이 다릅니다 — tokens:{...}(요청 델타)가 아니라
     컴포저(대화)별 "마지막 관측" breakdown 나열입니다. surface==='ide' 인
     컴포저는 blob 을 컴포저에 귀속시킬 근거가 없어(파서 스코프 결정) 절대
     토큰이 없고, 이 응답에는 아예 안 나타납니다 — 그 개수만 ideExcluded 로
     드러냅니다. bucket/provider/model 파라미터는 없습니다.
```

`until` 은 만들지 않았습니다. 화면이 요구한 것은 "오늘까지 거슬러 N일" 과 "전체"
둘뿐이어서 상한이 필요한 자리가 없었고, 쓰지 않는 파라미터를 받으면 서버가 검증할
표면만 늘어납니다. 사용자 지정 기간이 들어오는 순간 함께 넣습니다.

`all` 은 **전체 기간을 뜻하는 명시 플래그**입니다. `since` 를 생략하는 것으로
전체를 뜻하게 두면 안 됩니다 — 서버 기본값이 이번 달이고 전송 계층이 `null`
파라미터를 지우기 때문에, 뷰가 "전체"를 보내도 조용히 이번 달이 됩니다. 세 층이
각자 다른 가정을 했던 실제 결함이고 `test/period-all-time.test.mjs` 가 세 층을
함께 못박습니다.

**설계 결정 — 시계열은 스냅샷에 싣지 않습니다.** SSE 스냅샷은 현재 상태 전량을 매 갱신마다 브로드캐스트하는 구조입니다. 여기에 기간 시계열까지 넣으면 갱신마다 전 구간을 재집계하게 되고, 클라이언트마다 다른 필터를 서버가 기억해야 합니다. 시계열은 필터 변경 시 REST로만 당깁니다. 대신 SSE `snapshot` 이벤트가 오면 화면은 **현재 필터를 유지한 채 재요청**합니다.

## 스토어 쿼리

[store-extensions.md §8](../store-extensions.md)의 신규 메서드를 씁니다.

```js
getUsageTimeseries({ provider, model, bucket, since, until })
getModelBreakdown({ provider, since, until })
getCursorContextBreakdown({ since, until })   // (신규) T2 — cursor_local_activity 전용
```

버킷 키는 SQLite `strftime`으로 만들고, **로컬 시간대 기준**으로 끊습니다. 엔진이 이미 `startOfLocalMonthIso()`로 로컬 월 경계를 쓰므로 기준을 통일해야 합니다. UTC로 끊으면 대시보드 월 합계와 이 화면의 월 합계가 어긋납니다.

인덱스는 기존 `idx_usage_events_provider_time`(provider, observed_at)이 대부분 커버합니다. 모델 필터가 느려지면 `(provider, model, observed_at)` 인덱스를 추가합니다 — 사전 집계 테이블은 만들지 않습니다.

## 상태 처리

| 상황 | 표시 |
|---|---|
| 기간 내 데이터 없음 | 차트 영역에 빈 상태 + 수집 상태 확인 링크 |
| 단일 provider만 연결 | provider 필터는 표시하되 연결된 것만 선택 가능 |
| 품질이 낮은 provider 포함 | 차트 위에 "일부 값은 미확인" 주석 + 해당 시리즈에 사선 패턴 |
| 도구/추론 토큰 미제공 provider | 범례에서 회색 처리, 0으로 채우지 않음 |

## 완료 기준

- [ ] 토큰 종류별 합이 provider 총합과, provider 총합이 대시보드 총합과 일치 — **미달**, 아래 [T1](#todo)
- [x] 버킷 경계가 로컬 시간대 기준 — `service/store.mjs` 의 `getUsageTimeseries` 가 `strftime` 에 `'localtime'` 을 붙이고, `test/usage-aggregation.test.mjs` 가 월 경계를 못박습니다
- [x] 필터 변경이 REST 재요청만 유발하고 SSE 구독은 유지 — 필터는 `useEffect` 의 의존성이고 SSE 구독은 `App.jsx` 가 소유합니다. 렌더 테스트 인프라가 없어 코드 대조로만 확인했습니다
- [x] 미제공 범주가 0이 아니라 미표시로 구분됨 — `src/shared.js` 의 `tokensOrDash` 가 값 0 을 `—` 로 적고, 아직 값이 오지 않은 자리는 `로딩중..` 으로 갈라 적습니다(`measurementPending`). `test/shared-helpers.test.mjs`
- [ ] 상세 표 페이지네이션이 1000행 이상에서 동작 — **미구현**(상세 표 자체가 없음)
- [x] 기간을 전체로 넓히면 이번 달 이전 기록이 실제로 나온다 — `test/period-all-time.test.mjs`
- [x] Cursor 컨텍스트 구성이 `usage_events` 계약을 흉내 내지 않고 별도 패널·별도 엔드포인트로 나온다 —
  아래 [T2](#t2-cursor-컨텍스트-구성-반영--완료), `test/cursor-collector.test.mjs`의
  `GET /api/v1/cursor/context 가 인증을 요구하고 breakdown 을 내려주며 본문은 안 싣는다`

## TODO

### T1. "기간 합계" 다섯 조각이 합계와 안 맞습니다 — 미해결

`기간 합계` 패널은 입력·캐시읽기·캐시쓰기·출력·추론을 **provider 합산으로** 한 줄에
적습니다. Codex·Gemini 의 `input` 은 캐시 읽기를 포함하고 Claude 의 `input` 은
포함하지 않으므로, 세 provider 를 더한 다섯 조각은 어느 회계로도 참이 아니고 합이
총합과 어긋납니다(R4).

대시보드는 이미 같은 결함을 고쳤습니다 — provider마다 자기 항등식으로 쪼개고 회계
이름을 옆에 적는 방식입니다(`src/shared.js` 의 `decomposeTokens`,
[dashboard.md](./dashboard.md) 의 T1). 이 패널도 같은 방식으로 가면 되고, 새 헬퍼는
필요 없습니다.

지금 화면이 그럴듯한 숫자를 보여주고 있어서 **틀린 것을 알아채기 어려운 쪽**이라,
남은 것 중 우선순위가 높습니다.

### T2. Cursor 컨텍스트 구성 반영 — 완료

`docs/dev/cursor/기능적용가능성.md`에서 이 화면에 별도 O 항목으로 분리해뒀던
"Cursor — 컨텍스트 구성" 패널과 `GET /api/v1/cursor/context`를 구현했습니다.

**왜 위 추이 차트에 못 얹는가.** 위 차트/기간 합계/모델별 비중은 전부
`usage_events`(요청 단위 입력/출력 델타)가 소스입니다. Cursor 로컬 활동은
[Decision 4](../cursor/decisions.md)에 따라 `usage_events`에 안 들어가고 별도
`cursor_local_activity`(컨텍스트 스냅샷) 테이블에 있습니다 — "그 컴포저(대화)를
마지막으로 관측했을 때 컨텍스트 창이 어떻게 구성돼 있었는가"이지 "이번 요청에
토큰이 얼마나 오갔는가"가 아닙니다. 같은 차트에 억지로 얹으면 두 회계를
섞게 되므로(R4), 계약이 다른 새 패널·새 엔드포인트로 분리했습니다.

**구현.** `service/store.mjs`의 `getCursorContextBreakdown({since, until})`이
`context_breakdown IS NOT NULL`인 (CLI 표면) 행을 관측 시각 순으로 모으고,
`context_breakdown IS NULL`인 (IDE 표면) 행 수를 `ideExcluded`로 따로 셉니다 —
IDE는 blob 을 컴포저에 귀속시킬 근거가 없어(Phase 0b 결정) 애초에 절대 토큰이
없기 때문입니다(위 [API](#api) 절 참고). `UsageView.jsx`는 컴포저별 가로 스택
막대(카테고리별 세그먼트, `cx-*` 팔레트)를 최신 20개까지 그리고, 잘린 개수와
`ideExcluded` 개수를 각각 안내 문구로 답니다 — 조용히 자르지 않습니다.

**팔레트.** 기존 `tk-*`(토큰 종류) 5색과 별도로 `cx-*`(Cursor 카테고리) 8색을
`dataviz` 스킬의 `scripts/validate_palette.js`로 검증해 `src/styles.css`에
추가했습니다(코드 주석에 수치 인용).

**제외한 것.** 모델 분포·세션/턴 표는 이 T2 범위가 아닙니다 — 기능적용가능성.md의
해당 행은 원래 X(불가) 판정이었고 이번 패스도 그 판정을 바꾸지 않습니다
(파싱 결정상 Cursor는 모델명·턴 경계를 노출하지 않습니다).

## 하지 않는 것

- 캐시 읽기 토큰을 입력 토큰에 합산 (이중 계상, 규칙 R4)
- 없는 범주를 0으로 채워 총합을 그럴듯하게 만들기 (규칙 R7)
