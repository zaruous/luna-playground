# 동기화 (`budget`)

**현재 상태: 미구현.** 대시보드 상단의 수집 칩 4개와 Hook 버튼이 이 기능의 일부를 임시로 담고 있습니다.

메뉴 식별자가 `budget`인데 라벨이 `동기화`인 것은 코드가 먼저 정해진 결과입니다(`src/App.jsx:13`). 예산 기능은 [알림](./alert.md)과 M7로 갔으므로, 이 화면은 **provider 연결과 수집 신뢰성**을 담당합니다. 식별자를 바꾸면 저장된 사용자 상태와 어긋나므로 그대로 둡니다.

## 화면 미리보기

![동기화 와이어프레임](../assets/budget.svg)

## 화면 요소

| 영역 | 내용 |
|---|---|
| provider 카드 4장 | Codex / Claude / Cursor / Gemini 각각의 연결 상태, 감지 결과, 설정 진입 |
| Hook 제어 | Codex lifecycle hook 설치/해제, 대상 이벤트 4종, 백업 파일 위치 |
| 서버 한도 이력 | `limit_id` × window별 백분율 추이 (percent 축, 토큰 아님) |
| 대조 이력 | reconciliation 분류별 타임라인 — 특히 `SERVER_ONLY_CHANGE` |
| 진단 | SQLite 경로, 행 카운터 5종 |

## provider 카드 상태 모델

[provider-token-api.md §8](../provider-token-api.md)의 `getStatus()`를 그대로 표시합니다.

| 상태 | 조건 | 표시 |
|---|---|---|
| 연결됨 | `detected && ledgerAvailable && watching` | 초록, 파일 수/폴링 주기 |
| 감지됨 · 원장 없음 | `detected && !ledgerAvailable` | 주황 — 예: Cursor 개인 계정 |
| 자격증명 필요 | `credentials === 'api_key'` 이고 미설정 | 주황 + 설정 링크 |
| 오류 | `lastError` 존재 | 빨강 + **한 줄 메시지**(스택 금지) |
| 준비 중 | 어댑터 미구현 (`integration: 'planned'`) | 회색 + 해당 마일스톤 표기 |

## Hook 제어

이미 구현된 API를 그대로 씁니다.

```
GET    /api/v1/providers/codex/hooks    → { installed, installedEvents, expectedEvents, hooksPath, command }
POST   /api/v1/providers/codex/hooks    → 설치 후 상태
DELETE /api/v1/providers/codex/hooks    → 해제 후 상태
```

화면에 반드시 넣을 문구: **hook은 가속 경로이고 수집 근거는 항상 로그**라는 점. 사용자가 hook을 끄면 실시간성이 떨어질 뿐 데이터가 사라지지 않습니다.

Claude도 lifecycle hook을 붙일 예정이므로(M3), 경로는 provider별로 일반화합니다: `/api/v1/providers/:provider/hooks`. Codex 경로는 하위 호환으로 유지합니다.

## 신규 API

```
GET /api/v1/quota/history?provider=&limitId=&windowMinutes=&since=
      → { points: [{ observedAt, usedPercent, resetsAt }] }
GET /api/v1/reconciliation?provider=&since=&limit=
      → { rows: [{ fromObservedAt, toObservedAt, classification, serverDelta, localTokens, windowMinutes }] }
```

두 API 모두 **percent와 토큰을 같은 축에 그리지 않도록** 응답을 분리합니다. 한도 이력은 percent 시계열, 대조 이력은 분류 목록입니다.

## 대조 이력 표시

`reconciliation_events`의 분류를 그대로 씁니다(`docs/codex-usage.md`).

| 분류 | 화면 문구 | 색 |
|---|---|---|
| `MATCHED_ACTIVITY` | 서버·로컬 동시 증가 | 초록 |
| `SERVER_ONLY_CHANGE` | 서버만 증가 — 로컬 근거 없음 | 주황 |
| `LOCAL_ONLY_ACTIVITY` | 로컬만 증가 — 서버 미반영 | 회색 |
| `RESET` | 한도 리셋 | 파랑 |
| `UNKNOWN` | 의미 있는 변화 없음 | 숨김(기본) |

`SERVER_ONLY_CHANGE`는 "다른 기기에서 썼거나, 클라우드 실행이거나, 지연 정산"입니다. 원인을 추측해 하나로 단정하지 않고 세 가능성을 문구로 남깁니다.

## 진단

`GET /api/v1/diagnostics`가 이미 `dbPath`, `sessions`, `usageEvents`, `rateSnapshots`, `scanFiles`, `cumulativeResets`를 반환합니다. 화면에 그대로 노출하고, **SQLite 경로 열기** 버튼은 두지 않습니다(브라우저에서 로컬 파일 열기는 불가하고, 서비스가 셸을 실행하는 경로를 만들면 안 됩니다).

## 완료 기준

- [ ] provider 4종의 상태가 `getStatus()` 값으로만 결정되고, 화면에 하드코딩된 provider 분기가 없음
- [ ] Hook 설치/해제 후 상태가 즉시 갱신됨
- [ ] 한도 이력 축이 percent이고 토큰 값이 섞이지 않음
- [ ] `lastError`가 스택트레이스 없이 한 줄로 표시됨
- [ ] 자격증명 값이 화면·응답에 나타나지 않음(설정 여부만)

## 하지 않는 것

- 서버 한도와 로컬 토큰을 같은 차트에 겹쳐 그리기
- `SERVER_ONLY_CHANGE`를 로컬 토큰으로 보정해 없애기
- 진단 화면에서 셸 명령이나 파일 탐색기 실행
