# 냥트랙커 🐈‍⬛

Electron + React + Vite로 만든 로컬 우선 AI 사용량 트래커입니다. 블랙냥, 흰냥, 회색냥, 주황냥, 삼색냥 스킨을 지원합니다.

현재 구현 범위는 **Codex Adapter v1**입니다. Codex rollout 로그에서 실제 로컬 관측 토큰을 읽고 SQLite에 저장하며, 서버 rate-limit snapshot이 존재하면 별도 기록하여 로컬 활동과 비교합니다.

## 측정 원칙

냥트랙커는 다음 세 값을 의도적으로 분리합니다.

- **로컬 관측 토큰** — Codex rollout의 `token_count`에서 계산
- **서버 관측 한도** — Codex가 전달하는 rate-limit snapshot
- **예상 비용** — API 등가 비용 추정치이며 구독 과금액으로 간주하지 않음

서버 사용률과 로컬 토큰 사이에 임의 환산식을 만들거나 숫자를 강제 보정하지 않습니다. 대응되지 않는 서버 사용량 증가는 별도 attribution 상태로 남깁니다.

## 주요 기능

- 과거 Codex 세션 스캔
- byte offset 기반 JSONL 증분 tail
- Input / Cached / Cache-write / Output / Reasoning / Total 토큰 집계
- Codex session cwd 기반 프로젝트 분류
- 5시간 / 주간 서버 한도 snapshot 기록
- 로컬/서버 reconciliation 상태 표시
- 선택형 Codex lifecycle hook 연동
- Electron IPC 실시간 UI 갱신
- 5종 고양이 테마

## 개발

Node.js 24 이상이 필요합니다.

```bash
npm install
npm test
npm run dev
```

렌더러 빌드:

```bash
npm run build
```

세부 설계는 [`docs/codex-usage.md`](docs/codex-usage.md)를 참고하세요.
