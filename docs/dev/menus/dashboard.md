# 대시보드 (`dashboard`)

**현재 상태: 구현됨.** 이 문서는 확장 항목만 다룹니다.

대시보드 JSX는 M1에서 `src/views/DashboardView.jsx`로 **동작 변화 없이** 옮겼습니다. `src/App.jsx`는 스냅샷·클라이언트·테마를 계속 소유한 채 props로만 내려줍니다(`src/App.jsx:128`).

## 화면 미리보기

![대시보드 와이어프레임](../assets/dashboard.svg)

## 화면 요소

| 영역 | 현재 | 확장 |
|---|---|---|
| 요약 카드 4장 | 총 토큰 / 캐시 적중 / 서버 한도 / 수집 중 AI | 카드마다 최근 7구간 스파크라인 추가 |
| 기간 선택 | 없음 (월 고정) | 헤더에 `이번 달 / 최근 7일 / 최근 30일` — 스냅샷 `period`를 쿼리로 전환 |
| provider별 사용량 | 4행 막대 (catalog 전체, planned 포함) | 행마다 **측정 품질 배지**. Claude처럼 신뢰도가 낮은 값은 `미확인` |
| 서버 한도 | `quotaWindows` 게이지 | 창별 리셋 잔여 시간 표시, 창이 여러 개인 provider 대응 |
| 미확인 서버 사용량 | 코멘트 문구로만 암시 | 건수 + [동기화 화면](./budget.md)으로 가는 링크 |
| 프로젝트 | 최근 6개 요약 | [프로젝트 화면](./project.md)으로 가는 링크 |
| 고양이 코멘트 | reconciliation 상태별 문구 | 유지 |

## 데이터 소스

추가 API 없이 **기존 스냅샷만으로 대부분 가능**합니다. 스냅샷에는 이미 `totals`, `providers[].quotaWindows`, `providers[].reconciliation`, `projects`가 들어 있습니다.

새로 필요한 것 둘:

```
GET /api/v1/usage/timeseries?bucket=day&limit=7      // 카드 스파크라인
GET /api/v1/snapshot?period=7d|30d|month             // 기간 전환
```

기간 파라미터는 엔진 `snapshot()`이 `startOfLocalMonthIso()`를 고정으로 쓰는 부분을 인자화해야 합니다. SSE 브로드캐스트는 계속 월 기준 기본값을 보내고, 기간을 바꾼 클라이언트는 REST로 다시 당깁니다 — 클라이언트별 기간을 서버가 기억하지 않습니다.

## 품질 배지 규칙

[provider-token-api.md §4](../provider-token-api.md)의 등급을 그대로 표시합니다.

| 등급 | 배지 | 예 |
|---|---|---|
| `server_verified` | 서버 검증됨 | Cursor `chargedCents` |
| `local_exact` | 로컬 관측 | Codex 전체, Gemini 전체 |
| `partial` | 추정 | Claude `output_tokens` (thinking 누락) |
| `unverified` | 미확인 | Claude `input_tokens` (플레이스홀더) |

provider 총합의 배지는 **구성 필드 중 최저 등급**입니다. 총합이 `미확인`이어도 캐시 항목은 `로컬 관측`일 수 있으므로, 카드 툴팁에서 필드별 등급을 보여줍니다.

## 상태 처리

| 상황 | 표시 |
|---|---|
| 수집기 미발견 | `WAITING CODEX` 필 유지, 칩은 `미발견` |
| provider 미연결 (`planned`) | 행은 보이되 값은 `—`, 배지 `미연결` |
| 서버 한도 snapshot 없음 | 게이지 `—`, `snapshot 대기` |
| SQLite 비어 있음 | 카드 0, 프로젝트 영역에 첫 수집 안내 |

## TODO — 확정된 개선 항목

아래는 실제 화면을 보고 확정한 항목입니다. 설계 의도가 아니라 **화면이 틀리게 보이는 것**을 고치는 작업이었고, T1·T2 는 M9 에서, 그때 잔여로 남겼던 둘은 이어진 결함 수정 라운드에서 닫혔습니다. 무엇이 왜 틀렸는지는 되돌릴 때 필요하므로 남겨 둡니다. 아직 열린 것은 **T3** 에 모읍니다.

### T1. 요약 카드 3장을 provider별로 쪼갠다 — 완료 (M9)

`캐시 적중` · `서버 주간 한도` · `Codex 서버 동기화` 세 항목이 **M9 이전에는** 사실과 다르게 보였습니다. 아래 표의 "지금" 칸은 그때 상태입니다.

| 항목 | 지금 | 문제 | 되어야 하는 것 |
|---|---|---|---|
| 캐시 적중 | provider **합산** 하나 (`totals.cacheRate`) | Codex와 Claude는 캐시 회계가 서로 달라(§`accounting.mjs`) 합산 비율의 의미가 흐려집니다. Codex 5.6만 토큰과 Claude 23억 토큰을 한 비율로 뭉개면 사실상 Claude 값만 보이는 것과 같습니다 | **provider별 캐시 적중률**. 합산값을 보여주려면 분모(`promptTokens`)를 함께 적어 근거를 드러냅니다 |
| 서버 주간 한도 | Codex `quotaWindows`만 | 카드 제목이 "서버 주간 한도"인데 실제로는 **Codex 전용**입니다. Claude는 로컬 로그에 한도가 없어 값이 없는데, 카드만 보면 전체 한도처럼 읽힙니다 | provider별 한도 게이지. 한도를 주지 않는 provider는 **"한도 미제공"**으로 표기 (0%로 채우지 않음, R7) |
| Codex 서버 동기화 패널 | 제목·내용 모두 Codex 고정 | provider가 늘어도 이 패널은 Codex만 봅니다. Claude는 `reconciliation`이 항상 비어 있는데 그 사실이 화면에 없습니다 | provider별 카드로 분리. 서버 관측이 없는 provider는 "서버 원장 없음 — 로컬 관측만"으로 명시 |

핵심 규칙은 이미 문서에 있는 것과 같습니다 — **provider마다 측정 근거가 다르면 화면에서도 갈라 보여야 합니다.** 한 숫자로 합치는 순간 "어느 provider의 사실인지" 알 수 없게 됩니다.

구현 메모:

- 캐시 적중률의 분모는 `provider.totals.promptTokens`(회계 반영됨)를 씁니다. `cachedInputTokens / inputTokens`를 다시 쓰면 Claude에서 수천 %가 됩니다
- 한도는 `provider.capabilities.serverQuota`로 "미제공"을 판단합니다. Claude는 `false`
- 카드 자리가 부족하면 요약 카드는 합산 + 툴팁에 provider별 내역, 상세는 [동기화 화면](./budget.md)에 provider별 카드로 두는 분담도 가능합니다

들어간 것은 그 마지막 분담안입니다.

- 요약 카드는 합산값을 그대로 두고 그 아래 provider별 한 줄을 깝니다. 회계 이름(`캐시 input 포함` / `캐시 input 분리`)은 툴팁이 아니라 **화면에 직접** 적습니다 — 터치에는 hover 가 없고 보조기술도 `title` 을 읽어 준다는 보장이 없어, 툴팁에만 두면 76% 와 95% 만 남아 두 수가 같은 종류로 읽힙니다. 분모는 툴팁에 덤으로 붙습니다(`src/views/DashboardView.jsx` 의 `cacheBreakdown`, `src/shared.js` 의 `accountingLabels`)
- 서버 동기화 패널은 provider별 블록으로 갈라졌고 제목에서 `Codex` 가 빠졌습니다(`DashboardView.jsx` 의 `quotaStates` 렌더 블록)
- 한도·대조 분기는 provider id 가 아니라 `capabilities` 를 봅니다. `serverQuotaState()` 가 `미연결`/`한도 미제공`/`snapshot 대기`/관측됨 네 갈래를 냅니다(`src/shared.js`) — `reconciliation.status` 로 가르지 않는 이유는 snapshot 이 아직 없는 Codex 와 서버 원장 자체가 없는 Claude 가 둘 다 `NO_SERVER_DATA` 이기 때문입니다
- 한도 카드의 큰 숫자는 여전히 provider 하나의 값입니다. 서로 다른 구독의 percent 에는 공통 분모가 없어 평균내지 않고(R5), 사용률이 가장 높은 provider 를 세운 뒤 **카드 제목에 그 이름을 적습니다**

잔여로 남겼던 둘도 결함 수정 라운드에서 닫았습니다:

- 수집 상태 칩의 `Hook` 이 provider별로 갈렸습니다. `src/App.jsx` 는 `hookStatuses` 맵을 통째로 내려주고, 대시보드는 `capabilities.hooks` 인 provider마다 칩 문구와 버튼을 하나씩 만듭니다(`DashboardView.jsx` 의 `hookRows`). 상태를 아직 못 읽었거나 읽기에 실패한 provider는 `미설치` 가 아니라 `미확인` 이고, 기대 이벤트가 일부만 걸린 설정은 `일부 설치` 입니다 — `installed` 는 전부 걸렸을 때만 `true` 라(`providers/*/hooks.mjs`) 이 둘을 `미설치` 로 접으면 이미 들어 있는 hook 을 없다고 말하게 됩니다(R7)
- `AI별 사용량` 패널 아래 토큰 분해 줄이 provider별 한 줄로 갈렸습니다(`DashboardView.jsx` 의 `tokenSplits`, `src/shared.js` 의 `decomposeTokens`). `Input` 은 Codex에서 캐시 읽기를 포함하고 Claude에서는 포함하지 않으므로([토큰 사용량 측정](../../토큰%20사용량%20측정.md)) 합산 한 줄은 어느 회계로도 참이 아니었습니다(R4). 이제 provider마다 자기 항등식으로 분해하고 회계 이름을 옆에 적으며, 어느 항등식도 성립하지 않으면 분해를 포기하고 원본 범주에 `겹침 미확인` 을 붙입니다 — `test/shared-helpers.test.mjs` 가 두 회계와 fallback 을 함께 못박습니다

### T2. 최근 프로젝트 발자국을 마지막 활동 순으로 — 완료 (M9)

"최근 프로젝트 발자국"인데 정렬이 **토큰 순**이었습니다. 그래서 오늘 만진 프로젝트가 목록에 없고, 몇 주 전의 큰 프로젝트가 계속 위에 남았습니다.

```sql
-- M9 이전
ORDER BY total_tokens DESC
-- 지금 (service/store.mjs 의 getRecentProjects · getRecentProjectsAcrossProviders)
ORDER BY last_activity DESC, project_name ASC                 -- provider 단위
ORDER BY last_activity DESC, provider ASC, project_name ASC   -- provider 통합
```

- 패널 제목이 "최근"이므로 **마지막 활동이 가장 최신인 것이 항상 맨 위**여야 합니다
- 토큰 순 목록이 필요하면 [프로젝트 화면](./project.md)이 이미 그 역할입니다 — 두 화면의 정렬 기준을 다르게 두는 것이 의도입니다
- `getRecentProjects`(provider 단위)도 같은 문제였고 함께 고쳤습니다
- 정렬만 바꿨으므로 API·스냅샷 모양 변화는 없습니다. `test/usage-aggregation.test.mjs` 에 "최신 활동이 먼저 온다" 단정을 추가했고, 같은 픽스처로 프로젝트 화면이 여전히 토큰 순인 것도 함께 못박습니다
- 마지막 활동이 같은 초인 동률은 그룹 키 순으로 갈립니다(위 SQL). 동률을 `GROUP BY` 임시 b-tree 가 내주는 순서에 맡기면 같은 데이터인데도 새로고침마다 목록이 뒤바뀌고, 보조 키를 토큰으로 두면 T2 가 걷어낸 토큰 순위가 슬쩍 되살아납니다 — `test/usage-aggregation.test.mjs` 의 "마지막 활동이 동률이면 토큰이 아니라 그룹 키 순으로 갈린다"

### T3. 아직 열린 항목 — 미해결

M9·M10 과 그 결함 수정 라운드가 닫지 않은 것들입니다. 지금 화면이 틀린 말을 하고 있지는 않지만, 다음 provider 가 붙거나 이 화면을 다시 손댈 때 걸립니다.

- **JSX 안의 R7 분기에는 테스트가 없습니다.** 판단이 헬퍼가 아니라 컴포넌트 안에 있는 것이 셋입니다 — `reconcileCounts`(대조 행이 없으면 0 세 개 대신 "아직 대조한 구간이 없습니다"), `hookRows`(상태를 못 읽으면 `미확인`), `serverLedgerCopy`(관측 / 대기 / 한도 미제공 / 한도 미확인 네 문구, "모른다"가 "없다"를 이김). 렌더 테스트 인프라가 저장소에 아직 없어 코드 대조로만 확인했습니다 — 인프라를 들이면 이 셋이 첫 대상입니다
- **hook provider 목록이 두 곳입니다.** 대시보드·동기화 화면은 `capabilities.hooks` 로 고르는데 초기 상태를 당기는 목록은 아직 id 배열입니다(`HOOK_PROVIDERS`, `src/App.jsx`). 세 번째 hook provider 가 붙으면 칩에 이름은 뜨지만 상태를 영영 못 받아 `미확인` 으로 남습니다 — 거짓말은 아니지만 고칠 곳은 [동기화 화면](./budget.md#완료-기준) 의 같은 항목과 한 곳입니다
- ~~**"최근 프로젝트 발자국" 부제가 Codex 전용 문구입니다.**~~ **닫힘.** 부제가 `provider별 세션 메타데이터의 cwd 기준 자동 분류` 로 바뀌었고, 정렬 기준과 `이번 달` 범위도 부제와 배지에 함께 적힙니다(`src/views/DashboardView.jsx`)
- **토큰 분해의 `—` 가 두 뜻을 겹쳐 씁니다.** 조각 값이 0 이면 `—` 로 적는데, 이것이 "provider 가 그 항목을 주지 않음"(Claude 의 추론 토큰)과 "재서 0"을 같은 글자로 만듭니다. 지금은 안전한 쪽(모름)으로 기울여 뒀습니다. M10 이 **"아직 안 왔다"** 를 여기서 떼어내 `로딩중..` 으로 갈랐으므로 남은 것은 이 둘뿐입니다. Claude 는 필드 키의 유무로 이미 둘을 구분하므로(`quality.fields`, `parser.mjs` 의 "reasoningTokens 키를 넣지 않는 것이 미제공 표시") 그걸 읽으면 갈라 적을 수 있고, Codex 는 필드 근거 자체를 안 남기므로 그쪽부터 채워야 합니다

## 완료 기준

- [x] 뷰 분리 후 렌더 결과·SSE 갱신·focus reconcile 동작이 이전과 동일 — M1. 렌더 테스트 인프라가 없어 이동 전후의 `.stat-card` 텍스트와 provider 행 수를 브라우저에서 비교해 확인했습니다
- [x] 기간 전환 시 카드/차트/프로젝트가 같은 기간을 사용 — M10. 대시보드에 기간 칩이 붙고 요약 카드·provider 막대·그 아래 분해가 함께 따라갑니다. **서버 한도·동기화 패널·최근 프로젝트는 의도적으로 이번 달에 고정**하고 그 사실을 각자 라벨에 적습니다 — 한도 snapshot 은 기간 개념이 없고(지금 값이거나 없음), "최근" 목록에 전체 기간을 적용하면 목록의 뜻이 바뀝니다
- [x] planned provider가 0이 아니라 `—`로 표시됨 — M10. `src/shared.js` 의 `tokensOrDash`. 여기에 세 번째 상태가 더 있습니다: 아직 값이 안 온 자리는 `0` 도 `—` 도 아니라 `로딩중..` 입니다
- [x] 품질 배지가 provider별로 다르게 표시됨 — 다만 **괄호 안의 예시가 틀렸습니다.** Claude 는 `추정` 이 아니라 Codex·Gemini 와 같은 `local_observed` 입니다(`service/providers/*/collector.mjs`). 셋 다 로컬 로그를 직접 읽으므로 provenance 는 같고, provider별로 갈리는 것은 **필드 등급**입니다 — Claude 만 `field_quality` 를 남겨 `exact`/`partial` 을 섞어 보여줍니다. `추정` 라벨은 가격 레지스트리(M7)를 위해 예약된 자리입니다
- [x] (T1) 캐시 적중·서버 한도·서버 동기화가 provider별로 갈라져 보이고, 한도를 주지 않는 provider는 0%가 아니라 "한도 미제공"으로 표시됨 — 판단 헬퍼는 `test/shared-helpers.test.mjs` 가 못박습니다(`serverQuotaState` 네 상태, `cacheHitPercent` 의 null, `featuredQuotaWindow`, `decomposeTokens`, `reconcileCopy`). JSX 를 렌더링하는 테스트는 아직 없어 화면 쪽 분기는 코드 대조로 확인했습니다(위 T3)
- [x] (T2) 최근 프로젝트 발자국의 첫 행이 항상 마지막 활동이 가장 최신인 프로젝트임 — `test/usage-aggregation.test.mjs` 의 "'최근' 프로젝트 목록은 토큰이 아니라 마지막 활동 순이다"

## 하지 않는 것

- 백분율 한도를 토큰으로 환산해 카드에 합산하기
- 추정 비용을 총 토큰 카드에 섞기 (비용은 M7, 별도 라벨)
