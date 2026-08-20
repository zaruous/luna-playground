# NyangTracker 개발 계획 (docs/dev)

현재 코드는 **Codex 어댑터 하나만** 구현된 상태입니다. 대시보드 메뉴 6개 중 실제 화면이 있는 것은 `dashboard` 하나이고, 나머지 5개는 `activeNav` 상태만 바뀌고 렌더링 분기가 없습니다(`src/App.jsx:200`).

이 디렉터리는 그 다음 단계를 다룹니다. `docs/` 상위 문서가 **현재 구현된 것**을 기술하는 반면, `docs/dev/`는 **아직 구현하지 않은 것**을 기술합니다.

## 문서 지도

| 문서 | 내용 |
|---|---|
| [implementation-plan.md](./implementation-plan.md) | 마일스톤 M1~M6, 의존 순서, 단계별 완료 기준 |
| [token-measurement-survey.md](./token-measurement-survey.md) | GitHub 오픈소스 트래커들의 토큰 측정 알고리즘 분석과 그로부터 도출한 설계 규칙 |
| [provider-token-api.md](./provider-token-api.md) | 표준 어댑터 인터페이스 위에서 Codex/Claude/Cursor/Gemini 4종의 토큰 처리 API 설계 |
| [store-extensions.md](./store-extensions.md) | 위 설계를 받기 위한 SQLite 스키마·쿼리 확장 |

## 메뉴별 구현 문서

메뉴 식별자는 `src/App.jsx:13`의 `navItems` 배열을 그대로 따릅니다. 파일명은 코드의 id 기준이고, 괄호는 UI 라벨입니다.

| 문서 | 메뉴 | 현재 상태 |
|---|---|---|
| [menus/dashboard.md](./menus/dashboard.md) | `dashboard` (대시보드) | 구현됨 — 확장 대상 |
| [menus/usage.md](./menus/usage.md) | `usage` (AI 사용량) | 미구현 |
| [menus/project.md](./menus/project.md) | `project` (프로젝트) | 미구현 (요약만 대시보드에 존재) |
| [menus/budget.md](./menus/budget.md) | `budget` (동기화) | 미구현 (수집 칩·Hook 버튼만 대시보드에 존재) |
| [menus/alert.md](./menus/alert.md) | `alert` (알림) | 미구현 |
| [menus/settings.md](./menus/settings.md) | `settings` (설정) | 미구현 (스킨 선택만 헤더에 존재) |

각 메뉴 문서는 화면 미리보기(SVG 와이어프레임), 화면 요소 정의, 필요한 API, 필요한 스토어 쿼리, 완료 기준을 같은 순서로 담습니다.

## 설계 원칙 (상위 문서에서 승계)

1. 로컬 관측·서버 관측·추정은 **저장과 표시 모두에서** 분리한다.
2. 백분율 한도를 토큰으로 역산하지 않는다.
3. 정직한 불완전 측정이 정밀해 보이는 조작 측정보다 낫다.
4. 클라이언트는 정규화된 스냅샷과 좁은 명령만 받는다.
5. 새 provider가 공용 엔진 설계를 바꾸도록 두지 않는다 — provider 제약이 실제로 요구할 때만 바꾼다.

이 원칙은 [`docs/architecture.md`](../architecture.md)와 [`docs/roadmap.md`](../roadmap.md)에서 왔고, 아래 문서들은 그 위에서만 움직입니다.
