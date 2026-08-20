# 대시보드 (`dashboard`)

**현재 상태: 구현됨.** 이 문서는 확장 항목만 다룹니다.

지금 `src/App.jsx`의 `App()` 안에 대시보드 JSX가 인라인으로 들어 있습니다. M1에서 `src/views/DashboardView.jsx`로 **동작 변화 없이** 옮기는 것이 첫 작업입니다.

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

## 완료 기준

- [ ] 뷰 분리 후 렌더 결과·SSE 갱신·focus reconcile 동작이 이전과 동일
- [ ] 기간 전환 시 카드/차트/프로젝트가 같은 기간을 사용
- [ ] planned provider가 0이 아니라 `—`로 표시됨
- [ ] 품질 배지가 provider별로 다르게 표시됨 (Codex `로컬 관측`, Claude `미확인`)

## 하지 않는 것

- 백분율 한도를 토큰으로 환산해 카드에 합산하기
- 추정 비용을 총 토큰 카드에 섞기 (비용은 M7, 별도 라벨)
