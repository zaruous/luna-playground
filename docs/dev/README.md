# NyangTracker 개발 계획 (docs/dev)

현재 코드에는 **Codex · Claude Code · Gemini CLI 어댑터**가 구현돼 있고(계획한 4종 중 셋 — Cursor는 M6), 메뉴별 화면은 M1에서 `src/views/`로 분리됐습니다. Cursor는 M6a(로컬 전용, [cursor/](./cursor/README.md))와 M6b(Admin API, 기존 §5.3)로 갈라졌고 둘 다 아직 미구현입니다.

이 디렉터리는 그 다음 단계를 다룹니다. `docs/` 상위 문서가 **현재 구현된 것**을 기술하는 반면, `docs/dev/`는 **아직 구현하지 않은 것**을 기술합니다 — 다만 완료된 마일스톤(M1~M3 · M5 · M8 · M9 · M10)은 문서에 완료 표시를 남겨 무엇이 실제로 들어갔는지 되짚을 수 있게 합니다. M4는 동기화 절반만 들어갔고 완료 기준 하나가 미달이라 "완료"로 적지 않습니다.

## 문서 지도

| 문서 | 내용 |
|---|---|
| [implementation-plan.md](./implementation-plan.md) | 마일스톤 M1~M10, 의존 순서, 단계별 완료 기준, 라이브러리 채택 검토 |
| [token-measurement-survey.md](./token-measurement-survey.md) | GitHub 오픈소스 트래커들의 토큰 측정 알고리즘 분석과 그로부터 도출한 설계 규칙 |
| [provider-token-api.md](./provider-token-api.md) | 표준 어댑터 인터페이스 위에서 Codex/Claude/Cursor/Gemini 4종의 토큰 처리 API 설계 (Codex·Claude·Gemini 구현 완료) |
| [gemini/](./gemini/README.md) | Gemini CLI 어댑터(M5) — 실측, agy(Antigravity CLI) 감지, 포맷·설계 |
| [cursor/](./cursor/README.md) | Cursor 로컬 트랙(M6a) — 원격 사용량 배제, 로컬 저장소 실측과 메뉴별 적용 계획 (**계획 단계 — 미구현**) |
| [cursor/기능적용가능성.md](./cursor/기능적용가능성.md) | 화면/기능 단위로 Cursor에 이번 M6a를 적용할 수 있는지, LLM별 기능지원표.md와 같은 O/△/X 양식으로 정리한 표 |
| [claude/기능적용가능성.md](./claude/기능적용가능성.md) | `src/views/*.jsx`를 전부 읽어 화면 요소마다 Claude가 실제로 맞게 동작하는지 O/△/X로 정리(구현된 provider라 "적용 가능한가"가 아니라 "화면 전제와 실제 데이터가 어긋나는 자리"를 찾는 문서) |
| [codex/기능적용가능성.md](./codex/기능적용가능성.md) | 같은 방식의 Codex 판 — `INSERT OR IGNORE` 원장 결함이 어느 화면 요소로 번지는지까지 추적 |
| [LLM별 기능지원표.md](./LLM별%20기능지원표.md) | Claude/Codex/Gemini/Cursor 4종의 토큰 사용량 기능 O/X 매트릭스(23개 기능) |
| [LLM별 기능지원표 상세.md](./LLM별%20기능지원표%20상세.md) | 위 표 각 행의 근거 — 파일:줄 인용, 실측 수치, 문서 인용 |
| [fix-plan.md](./fix-plan.md) | 열린 결함 다섯 개의 수정 순서. 실측으로 세웠고, 재는 과정에서 감사 당시 서술 여덟 개가 틀렸음이 드러나 그 정정도 함께 담았습니다 |
| [store-extensions.md](./store-extensions.md) | 위 설계를 받기 위한 SQLite 스키마·쿼리 확장 (§1·§8 구현 완료) |

## 메뉴별 구현 문서

메뉴 식별자는 `src/App.jsx:13`의 `navItems` 배열을 그대로 따릅니다. 파일명은 코드의 id 기준이고, 괄호는 UI 라벨입니다.

| 문서 | 메뉴 | 현재 상태 |
|---|---|---|
| [menus/dashboard.md](./menus/dashboard.md) | `dashboard` (대시보드) | 구현됨 — 확장 대상 |
| [menus/usage.md](./menus/usage.md) | `usage` (AI 사용량) | 구현됨 (M2) — 상세 표·CSV는 미구현, 열린 결함 하나([T1](./menus/usage.md#todo)) |
| [menus/session.md](./menus/session.md) | `session` (세션 흐름) | **구현됨 (M8)** — 턴 단위 토큰 배분, 프로젝트 탭과 양방향 이동 |
| [menus/project.md](./menus/project.md) | `project` (프로젝트) | 구현됨 (M2) |
| [menus/detail.md](./menus/detail.md) | `detail` (상세 내역) | **구현됨** — 프로젝트(cwd) → 세션 → 도구 토큰량. 본문은 [내용 보기] 팝업 전용 통로로만 |
| [menus/budget.md](./menus/budget.md) | `budget` (동기화) | **구현됨 (M4 동기화 절반)** — provider 상태 카드 · provider별 Hook · 한도 이력 · 대조 타임라인 · 진단 |
| [menus/alert.md](./menus/alert.md) | `alert` (알림) | 미구현 |
| [menus/settings.md](./menus/settings.md) | `settings` (설정) | 미구현 (스킨 선택만 헤더에 존재) |

각 메뉴 문서는 화면 미리보기(SVG 와이어프레임), 화면 요소 정의, 필요한 API, 필요한 스토어 쿼리, 완료 기준을 같은 순서로 담습니다. 와이어프레임은 **설계 시점의 의도**이고 구현된 화면과 1:1 이 아닙니다 — 어긋난 곳은 해당 문서의 화면 요소 표에 구현/미구현으로 적습니다.

구현된 화면에서 발견한 개선 항목은 그 화면의 메뉴 문서 안 **`## TODO`** 절에 모읍니다 — 별도 TODO 파일을 두지 않는 이유는 항목이 화면 설계와 떨어지면 맥락을 잃기 때문입니다.

지금 열려 있는 항목:

| 문서 | 항목 | 무엇이 틀렸나 |
|---|---|---|
| [menus/usage.md](./menus/usage.md#todo) | T1 | "기간 합계" 다섯 조각이 provider 합산이라 합이 총합과 어긋납니다(실측 2.55B 과다). 대시보드가 이미 고친 결함과 같은 것 |
| [menus/dashboard.md](./menus/dashboard.md#t3-아직-열린-항목--미해결) | T3 | JSX 안의 R7 분기에 테스트가 없음, hook provider 목록이 두 곳, 부제가 Codex 전용 문구 |
| [menus/session.md](./menus/session.md) | 원장 | 실제 원장에서 Codex 만 턴이 안 붙어 있음 — 적재 경로가 `INSERT OR IGNORE` 라 재해석이 수리하지 못함 |

닫힌 항목: dashboard 의 T1·T2 는 [implementation-plan.md](./implementation-plan.md) 의 M9 로, 그때 잔여로 남긴 둘은 이어진 결함 수정 라운드로 닫혔습니다.

## 설계 원칙 (상위 문서에서 승계)

1. 로컬 관측·서버 관측·추정은 **저장과 표시 모두에서** 분리한다.
2. 백분율 한도를 토큰으로 역산하지 않는다.
3. 정직한 불완전 측정이 정밀해 보이는 조작 측정보다 낫다.
4. 클라이언트는 정규화된 스냅샷과 좁은 명령만 받는다.
5. 새 provider가 공용 엔진 설계를 바꾸도록 두지 않는다 — provider 제약이 실제로 요구할 때만 바꾼다.

이 원칙은 [`docs/architecture.md`](../architecture.md)와 [`docs/roadmap.md`](../roadmap.md)에서 왔고, 아래 문서들은 그 위에서만 움직입니다.


---

- 결함/버그/개선 사항은 docs/dev/item 디렉토리에 {결함명}.md 파일에 기록합니다 yml 포멧터로 tags, title, desc, start_date, end_date, stauts등을 관리하고 내용을 정리합니다. 추후 관련 내용이 개선,수정,보안되면 상태를 완료와 일자를 반영합니다.