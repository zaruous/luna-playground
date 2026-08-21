# 구현 플랜

현재 위치: Codex 어댑터 1종 + 대시보드 1화면. 목표: 메뉴 6종 완성 + provider 4종(Codex/Claude/Cursor/Gemini).

순서를 정한 근거는 두 가지입니다. **(1) 화면 골격이 먼저 있어야** provider를 추가할 때 표시할 곳이 생깁니다. **(2) 같은 수집 방식끼리 묶어야** 인프라를 재사용합니다 — Claude·Gemini는 Codex와 같은 "로컬 파일 tail"이고, Cursor만 "인증된 서버 API"라 새 인프라(자격증명 저장, 레이트리밋, 시간 창 커서)를 요구하므로 마지막입니다.

```text
M1 메뉴 라우팅 골격 ──┬─> M2 사용량/프로젝트 화면 ──┐
                      │                              ├─> M6 Cursor 어댑터
                      └─> M4 동기화/알림 ────────────┤
M3 Claude 어댑터 ─────────> M5 Gemini 어댑터 ────────┘
                                                      └─> M7 비용·내보내기
```

M1은 모든 화면 작업의 선행 조건이고, M3는 M1과 독립적으로 병행 가능합니다(수집 계층만 건드림).

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

## M3 — Claude Code 어댑터

문서: [provider-token-api.md §5.2](./provider-token-api.md)

이 마일스톤의 핵심은 파싱이 아니라 **부정확한 원본을 정직하게 다루는 것**입니다. Claude JSONL의 `input_tokens`는 항목 75%가 플레이스홀더이고 `output_tokens`는 thinking을 뺀 값입니다([조사](./token-measurement-survey.md#2-claude-code-jsonl-자체의-신뢰성-문제)).

**산출물**

- `service/providers/claude/{detector,parser,collector}.mjs`
- `usage_events`: `request_id`, `field_quality`, `parser_version` 컬럼 + `event_key` 부분 UNIQUE 인덱스 + `upsertUsageEvent()`
- 중복 제거: `message.id` + `requestId`, **last-wins**
- 품질 등급 표시: 캐시 필드는 `로컬 관측`, input/output은 `미확인`/`추정`
- `PROVIDER_CATALOG`의 claude를 `connected`로 승격 (어댑터 등록 시 자동)

**하지 않는 것**: 보정 계수 곱하기, thinking 토큰 추정, 총합을 그럴듯하게 만들기. 값이 못 미더우면 배지로 알립니다.

**선택 산출물(별도 토글)**: OTLP 수신 경로. `claude_code.token.usage`의 `type`/`model`/`query_source`를 매핑하면 서브에이전트 사용량이 분리되고 품질이 `local_exact`로 올라갑니다. JSONL 레인을 덮어쓰지 않고 병렬 보관합니다.

**완료 기준**

- 중간/최종 레코드를 순서대로 주입하면 **최종값만** 남는다 (테스트 필수)
- 대시보드에 Claude가 별도 provider 행으로 나타나고, 총합에 품질 배지가 붙는다
- 프롬프트/응답 텍스트가 SQLite와 스냅샷에 없다

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
