# 구현 플랜

현재 위치: Codex 어댑터 1종 + 대시보드 1화면. 목표: 메뉴 6종 완성 + provider 4종(Codex/Claude/Cursor/Gemini).

순서를 정한 근거는 두 가지입니다. **(1) 화면 골격이 먼저 있어야** provider를 추가할 때 표시할 곳이 생깁니다. **(2) 같은 수집 방식끼리 묶어야** 인프라를 재사용합니다 — Claude·Gemini는 Codex와 같은 "로컬 파일 tail"이고, Cursor만 "인증된 서버 API"라 새 인프라(자격증명 저장, 레이트리밋, 시간 창 커서)를 요구하므로 마지막입니다.

```text
M1 메뉴 라우팅 골격 ──┬─> M2 사용량/프로젝트 화면 ──┐
                      │                              ├─> M6 Cursor 어댑터
                      └─> M4 동기화/알림 ────────────┤
M3 Claude 어댑터 ─────────> M5 Gemini 어댑터 ────────┘
      └────────> M8 세션 흐름 (턴 계층 · 새 탭)
                                                      └─> M7 비용·내보내기
```

M1은 모든 화면 작업의 선행 조건이고, M3는 M1과 독립적으로 병행 가능했습니다(수집 계층만 건드림). M1~M3는 완료 상태입니다.

---

## M1 — 메뉴 라우팅 골격

지금 `navItems`를 클릭하면 `activeNav`만 바뀌고 화면은 그대로입니다(`src/App.jsx:200`). 대시보드 JSX가 `App()` 안에 인라인으로 들어 있어 화면을 늘릴 수 없는 구조라, 먼저 이걸 쪼갭니다.

**산출물**

- `src/views/` — 메뉴별 컴포넌트 6개. 대시보드는 기존 JSX를 그대로 옮기는 것부터 시작(동작 변화 0)
- `src/App.jsx` — 스냅샷/클라이언트/테마는 App이 계속 소유하고, 각 view에 props로 내려줌
- 미구현 메뉴는 "준비 중" 자리표시자 + 그 메뉴가 무엇을 보여줄지 한 줄 설명

**완료 기준**

- 메뉴 6개 클릭 시 각각 다른 화면이 뜬다
- 대시보드의 렌더 결과와 동작(스냅샷 갱신, SSE 펄스, 스킨, focus reconcile)이 이전과 동일하다
- `npm run build` 번들 크기 증가가 유의미하지 않다

**위험**: 대시보드 JSX 이동 중 회귀. 이동 전후로 `.stat-card` 텍스트와 provider 행 수를 브라우저에서 비교해 확인합니다.

---

## M2 — 사용량 · 프로젝트 화면

문서: [menus/usage.md](./menus/usage.md), [menus/project.md](./menus/project.md)

**산출물**

- 스토어: `getUsageTimeseries`, `getModelBreakdown`, `getProjectBreakdown` ([store-extensions.md §8](./store-extensions.md))
- API: `GET /api/v1/usage/timeseries`, `GET /api/v1/usage/models`, `GET /api/v1/projects`, `GET /api/v1/projects/:key`
- 화면: 기간·provider·모델 필터, 토큰 종류별 누적 막대, 프로젝트 목록/상세
- `project_aliases` 테이블 + 경로 가림 토글

**설계 결정**: 시계열은 SSE 스냅샷에 싣지 않습니다. 스냅샷은 "현재 상태"만 담고, 시계열은 필터가 바뀔 때만 REST로 당깁니다. 스냅샷에 넣으면 매 갱신마다 전 구간을 재계산해 브로드캐스트하게 됩니다.

**설계 결정**: 차트는 라이브러리 없이 순수 SVG로 그립니다. 대시보드의 막대·게이지가 이미 그 방식이고, 누적 막대 + 필터 조합도 같은 방식으로 충분합니다([라이브러리 채택 검토](#라이브러리-채택-검토)).

**완료 기준**

- 월 경계에서 버킷이 로컬 시간대 기준으로 끊긴다 (엔진의 `startOfLocalMonthIso()`와 동일 기준)
- 토큰 종류별 합이 대시보드 총합과 일치한다
- 프로젝트 가림을 켜면 스냅샷과 시계열 응답 어디에도 원본 경로가 없다

---

## M3 — Claude Code 어댑터 — 완료

문서: [provider-token-api.md §5.2](./provider-token-api.md), [claude-code-adapter.md](../claude-code-adapter.md)

이 마일스톤의 핵심은 파싱이 아니라 **부정확한 원본을 정직하게 다루는 것**이었습니다. 다만 실제 로그를 재보니 원본이 조사 시점보다 좋아져 있었고, 그래서 "낮춰 잡는 것"만큼 **근거가 생긴 필드를 정확히 올려 잡는 것**도 이 작업의 일부가 됐습니다([실측 정리](../토큰%20사용량%20측정.md#32-claude-code--구현-완료)).

**산출물**

- `service/providers/claude/{detector,parser,collector,hooks}.mjs`
- `usage_events`: `tool_tokens` / `field_quality` / `parser_version` / `request_id` 컬럼 + `event_key` 부분 UNIQUE 인덱스 + `upsertUsageEvent()` + `transaction()`
- 중복 제거: `claude|message.id|requestId`, **전역 last-wins**(+ 역행 방지 가드)
- 품질 등급: 필드별 등급 + 등급별 건수를 스냅샷에 실어 UI가 혼합 상태를 그대로 표시
- provider별 토큰 회계 선언(`tokenAccounting`)과 겹치지 않는 캐시 적중률 분모(`promptTokens`)
- Hook: `~/.claude/settings.json`에 5개 이벤트, provider별 설치 UI
- `PROVIDER_CATALOG`의 claude가 어댑터 등록으로 `connected` 승격
- `service/providers/jsonl-tail.mjs` — Codex와 공유하는 tail 리더

**하지 않은 것**: 보정 계수 곱하기, thinking 토큰 추정, 총합을 그럴듯하게 만들기. 값이 못 미더우면 배지로 알립니다.

**남긴 것(별도 토글)**: OTLP 수신 경로(`capabilities.telemetry = false`). `query_source`로 서브에이전트 사용량을 **분리해서** 보려면 필요합니다 — JSONL만으로도 부모 세션 귀속은 이미 됩니다.

**완료 기준 달성**

- 중간/최종 레코드를 순서대로 주입하면 최종값만 남습니다 — `test/claude-collector.test.mjs`
- 대시보드에 Claude가 별도 provider 행으로 나타나고 총합에 품질 배지가 붙습니다
- 프롬프트/응답 텍스트가 SQLite 파일 바이트와 HTTP 스냅샷 어디에도 없습니다 — `test/claude-privacy.test.mjs`
- 실제 코퍼스(214 파일 / 요청 13,757건 / 40억 토큰)에서 ccusage와 네 범주·총합이 **정확히 일치**합니다

## M9 — 대시보드 provider 분리 · 최근 정렬 (다음 작업)

문서: [menus/dashboard.md](./menus/dashboard.md) 의 **TODO T1 / T2**

실제 화면을 보고 확정한 두 항목입니다. 새 기능이 아니라 **지금 화면이 사실과 다르게 보이는 것**을 고칩니다.

- **T1** 요약 카드 3장(`캐시 적중` / `서버 주간 한도` / `Codex 서버 동기화`)을 provider별로 분리. 한도를 주지 않는 provider는 0%가 아니라 "미제공"(R7). 캐시 적중률 분모는 회계가 반영된 `promptTokens`
- **T2** "최근 프로젝트 발자국"을 `last_activity DESC` 로 정렬. 지금은 토큰 순이라 오늘 만진 프로젝트가 목록에 없습니다. 토큰 순 목록은 프로젝트 화면이 이미 담당

둘 다 스냅샷·API 모양 변화가 없어 스토어 정렬과 화면 분기만 손대면 됩니다.

---

## M8 — 세션 흐름 (턴 계층 · 새 탭) — 완료

문서: [menus/session.md](./menus/session.md), [provider-token-api.md §3.5](./provider-token-api.md), [store-extensions.md §10](./store-extensions.md)

기존 화면은 **얼마나 썼나**를 답했습니다. 이 마일스톤은 **어떤 절차로 얼마를 썼나**를 답합니다. 대화 본문은 저장하지 않은 채로요.

계기는 실측이었습니다 — 토큰 1위 세션의 99.4%가 캐시 읽기였고, 즉 "많이 만들어서"가 아니라 "긴 컨텍스트를 1,113번 다시 읽어서" 비쌌습니다. 그 사실이 기존 화면 어디에도 보이지 않았습니다.

**산출물**

- `service/providers/tool-phases.mjs` — 도구 이름 → 작업 단계 매핑(provider별 표, 정규 단계 6개)
- `service/providers/accounting.mjs` — provider별 토큰 회계 표 한 곳으로 통합
- `usage_events`: `turn_index` / `tool_counts` / `touched_paths` 컬럼
- `turns` 테이블 — 경계 사실만(토큰 없음)
- `provider_scan_state`: `parser_version` / `content_hash`
- 스토어: `getSessionRanking`, `getSessionFlow`, `upsertTurn`, `resetTurns`, `getLastTurnIndex`, `hasUnattributedTurns`
- 파서: Claude(`type:'user'` + `compact_boundary`), Codex(`user_message` + `response_item` + `context_compacted`)
- API: `GET /api/v1/sessions`, `GET /api/v1/sessions/:id/flow`
- 화면: 새 탭 `session`(세션 흐름) — 순위·컨텍스트 곡선(SVG)·단계별 배분·비싼 턴, 프로젝트 탭과 양방향 이동

**설계 결정 3개**

1. **턴 토큰을 별 테이블에 누적하지 않습니다.** 요청 행에 턴 번호를 달고 집계는 SQL로 뽑습니다 — 증분 tail이 턴 중간을 가르거나 세션을 resume할 때 누적이 두 배가 되는 것을 원장의 중복 제거로 막습니다. `session_activity` 테이블도 만들지 않았습니다(전부 유도 가능).
2. **단계는 파싱 때 확정하지 않습니다.** 파서는 도구 이름만 기록하고 분류는 조회 시점에 합니다 — 이름은 사실이고 단계는 해석이라, 매핑이 바뀌어도 재파싱이 필요 없습니다.
3. **재해석 트리거는 버전 + 원장 상태 두 개를 OR** 합니다. 버전 도장만 보면, 결함 있는 중간 버전이 버전만 올려놓고 메타를 못 쓴 경우 영구히 비어 있게 됩니다(이 마일스톤에서 실제로 겪었습니다).

**하지 않는 것**: 대화 요약을 만들어 DB에 넣기, 임의 계수로 "비용" 표시하기, 재독 배수로 좋다/나쁘다 판정하기, 턴 경계를 추측으로 보간하기.

**완료 기준 달성** — 전부 `test/session-flow.test.mjs`

- 턴 토큰 합 == 세션 토큰 합 (경계 미확인 버킷 포함)
- 재스캔·증분 tail·파서 버전업 어느 경로로도 턴 수와 토큰이 늘지 않음
- 도구 이름은 DB에 남고 도구 입력·프롬프트·응답은 SQLite 바이트에 없음
- 서브에이전트 요청이 부모 턴에 억지로 붙지 않고 0번 버킷에 남음
- `turns`가 비어 있어도 기존 화면 전부 동작

---

## M4 — 동기화 · 알림

문서: [menus/budget.md](./menus/budget.md), [menus/alert.md](./menus/alert.md)

**산출물**

- 동기화 화면: provider별 연결 상태, hook 설치/해제, 재스캔, 한도 snapshot 이력, reconciliation 타임라인, 진단
- API: `GET /api/v1/reconciliation`, `GET /api/v1/quota/history`
- 알림: `alert_rules`/`alert_events` 테이블, 서비스 프로세스 내 평가기, `GET|POST|PATCH|DELETE /api/v1/alerts` — 규칙 입력 검증은 `zod` 스키마([라이브러리 채택 검토](#라이브러리-채택-검토))
- 알림 종류: 한도 백분율 임계, 토큰/비용 예산, **수집 중단 감지**(watcher 오류 또는 마지막 스캔 지연)

**설계 결정**: 평가는 서비스에서 합니다. 창을 닫아도 알림이 동작해야 하고, 브라우저 탭 상태에 규칙 평가가 좌우되면 안 됩니다. 전달은 우선 앱 내 목록 + SSE 이벤트로 하고, OS 알림은 후속(브라우저 Notification 권한 필요).

**완료 기준**

- 규칙이 임계를 넘으면 `alert_events`에 `fired`가 남고 SSE로 즉시 전달된다
- 한도가 리셋되면 같은 규칙이 `resolved`로 닫힌다
- 수집기가 5분 이상 스캔하지 못하면 감지된다

---

## M5 — Gemini CLI 어댑터

문서: [provider-token-api.md §5.4](./provider-token-api.md)

**산출물**

- `service/providers/gemini/{detector,parser,collector}.mjs`
- `usage_events.tool_tokens` 컬럼 활성화 — 예약 필드였던 `tool_tokens`의 첫 실사용자
- `provider_scan_state`에 `content_hash`, `parser_version` — `.json` 전체 스냅샷 파일 대응
- `cached` → `cachedInputTokens` 분리 (input과 이중 계상 금지)
- `<project_hash>` 역매핑 실패 시 표시 정책

**완료 기준**

- thought 토큰이 `reasoningTokens`로, tool 토큰이 `toolTokens`로 들어간다
- 같은 `.json`을 두 번 스캔해도 합계가 늘지 않는다
- Gemini 로그 포맷이 바뀌었을 때 `parser_version`으로 재해석 대상을 고를 수 있다

---

## M6 — Cursor 어댑터

문서: [provider-token-api.md §5.3](./provider-token-api.md)

새 인프라가 셋 필요해서 마지막입니다: 자격증명 저장, 레이트리밋, 시간 창 커서.

**산출물**

- `service/providers/cursor/{client,collector}.mjs`
- `provider_credentials` 테이블 + 설정 화면의 API 키 입력 (값 회수 API 없음)
- `provider_api_cursor` 테이블, 시간 버킷 전진, 페이지네이션
- 레이트리밋 가드: 60 req/min(events), 20 req/min(daily), 기본 폴링 1시간 — `p-throttle`로 구현([라이브러리 채택 검토](#라이브러리-채택-검토))
- `provider_request_events` — 요청 기반 플랜에서 토큰 대신 요청 수/금액 저장
- 개인 계정: `detected: true, ledgerAvailable: false` 상태와 안내

**하지 않는 것**: 비공식 RPC 엔드포인트, 브라우저 쿠키, 다른 앱 키체인 읽기.

**완료 기준**

- API 키가 스냅샷·SSE·diagnostics 어디에도 노출되지 않는다
- 같은 시간 버킷을 재요청해도 이벤트가 중복 저장되지 않는다
- 레이트리밋 상한을 넘는 호출이 발생하지 않는다 (테스트로 강제)
- `chargedCents`는 추정이 아니라 `server_verified`로 표시된다

---

## M7 — 비용 · 내보내기

`docs/roadmap.md`의 cross-provider follow-up 중 우선 두 개만 가져옵니다.

- 모델 가격 레지스트리(발효일 포함) → 로컬 관측 토큰 기반 **추정** 비용. Cursor의 실측 금액과 같은 화면에 두되 라벨을 분리
- 로컬 원장 내보내기/가져오기(JSON/CSV) + 설정 화면의 데이터 삭제

**완료 기준**: 추정 비용에 `추정` 배지가 붙고, 실측 금액과 합산되지 않는다.

---

## 라이브러리 채택 검토

현재 런타임 의존성은 `react`/`react-dom` 둘뿐이고, 서비스 프로세스는 Node 내장(`node:sqlite`, `fs.watch`, `node:http`)만 씁니다. 이 몸집이 주는 것 — 네이티브 빌드 0으로 Windows 설치 마찰이 없고, 공급망 표면이 최소입니다. 그래서 채택 기준을 셋으로 고정합니다.

1. **직접 구현이 실제로 버그를 만드는 영역인가** — 경계 조건이 많아 수제 코드가 틀리기 쉬운 곳에만 쓴다
2. **설치·번들 비용이 작은가** — 네이티브 모듈 금지, 클라이언트는 M1의 번들 크기 기준 유지
3. **기존 설계를 바꾸도록 강요하지 않는가** — 수제 SVG 미학, "정규화된 스냅샷 + 좁은 명령" API 계약

### 채택

| 시점 | 라이브러리 | 근거 |
|---|---|---|
| M4 | `zod` | alert 규칙 CRUD는 서비스가 받는 **첫 사용자 입력 표면**. 알림 종류별로 필드 조합(임계값·창 길이·provider·예산 단위)이 다르게 늘어나는 구조라 수동 if 검증은 누락이 생기는 지점이고, 스키마가 API 문서 역할을 겸함. 더 작은 대안으로 `valibot`도 가능 |
| 검증 | `ccusage` (devDependency) | 런타임에서 쓰지 않고 **교차 검증 전용**. 같은 rollout 로그를 읽는 독립 구현이라, 같은 픽스처를 두 구현에 먹여 총합·출력·추론·캐시읽기 일치와 input 분해 관계를 고정하면 파서가 조용히 틀어지는 것을 잡습니다. 484KB·의존성 3개이고 배포물에는 들어가지 않으며, 미설치 환경에서는 테스트가 skip 됩니다 |
| M6 | `p-throttle` | 60/20 req/min 가드는 창 경계·동시 요청에서 직접 짜면 틀리기 쉬운 대표 영역. 의존성 0의 소형 패키지이고, 완료 기준 "상한을 넘는 호출 0"을 테스트로 강제하기도 쉬워짐 |

### 보류 — 재검토 트리거 명시

| 영역 | 후보 | 보류 이유 | 재검토 트리거 |
|---|---|---|---|
| 라우팅 (M1) | `wouter` | 메뉴 6개 상태 스위치로 충분, URL 요구 없음 | 딥링크·뒤로가기·화면 공유 URL 요구가 생길 때 (`wouter`는 ~2KB라 그때 넣어도 늦지 않음) |
| 차트 (M2) | Recharts / uPlot | 대시보드가 이미 순수 SVG로 막대를 그리고 있고, 누적 막대+필터는 같은 방식으로 충분. Recharts는 수십 KB로 번들 기준과 충돌 | 툴팁·줌·브러시 같은 상호작용 요구가 쌓이면 — 그때도 소형인 uPlot 먼저 |
| 날짜 버킷 (M2) | `date-fns` | 엔진에 `startOfLocalMonthIso()`가 이미 있고 시간/일/주/월 버킷은 내장 Date로 가능 | 설정의 "기간 시작일" 커스텀, 주 시작 요일 등 달력 규칙이 3개 이상 쌓일 때 부분 채택 |
| 파일 감시 (M3/M5) | `chokidar` | Codex collector의 `fs.watch` + 주기 reconcile 패턴이 플랫폼별 이벤트 누락을 이미 흡수. 신규 어댑터는 이 패턴을 재사용 | 어댑터 3종이 watcher 코드를 각자 복제하게 되면, 공용 watcher 추출 시점에 함께 검토 |
| CSV (M2/M7) | `d3-dsv` | **내보내기**는 고정 스키마라 escape 유틸 하나로 충분 | M7 **가져오기**에서 외부 CSV 파싱이 필요해지는 순간 — 남이 만든 CSV 파싱은 직접 짜지 않는다 |
| SQLite | `better-sqlite3` | `node:sqlite` 내장으로 충분하고, 네이티브 빌드는 Windows 설치 마찰을 되살림 | 내장 API의 성능·기능 한계가 실측으로 확인될 때 |

---

## 공통 체크리스트

마일스톤마다 아래를 통과해야 다음으로 넘어갑니다.

- [ ] `npm test` 통과 + 신규 픽스처 테스트 추가 ([provider-token-api.md §9](./provider-token-api.md))
- [ ] `npm run build` 성공
- [ ] `docs/` 상위 문서(architecture / provider-adapter-contract / codex-usage / roadmap)에 구현된 사실 반영
- [ ] 프롬프트·응답 텍스트, 자격증명이 SQLite/HTTP 응답에 없는지 확인
- [ ] 백분율 한도가 토큰 원장에 섞이지 않았는지 확인
