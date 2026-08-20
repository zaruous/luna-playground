# 냥트랙커 🐈‍⬛

React + Vite 클라이언트와 로컬 Node 서비스로 만든 로컬 우선 AI 사용량 트래커입니다. 블랙냥, 흰냥, 회색냥, 주황냥, 삼색냥 스킨을 지원합니다.

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
- provider adapter registry 기반 Codex/Claude/Cursor/Gemini 확장 구조
- 세션 이벤트 키 기반 active/archive 중복 제거
- Input / Cached / Cache-write / Output / Reasoning / Total 토큰 집계
- Codex session cwd 기반 프로젝트 분류
- `limit_id`와 실제 window 길이별 서버 한도 snapshot 기록
- 로컬/서버 reconciliation 상태 표시
- 선택형 Codex lifecycle hook 연동
- 인증된 로컬 HTTP API + SSE 실시간 UI 갱신
- 개발 모드(Vite HMR)와 독립 브라우저 서버 모드 모두 같은 로컬 서비스 사용
- 5종 고양이 테마

## 개발

Node.js 24 이상이 필요합니다.

```bash
npm install
npm test
npm run dev
```

`npm run dev`는 사용량 서비스를 루프백 포트에 띄우고, `http://127.0.0.1:5173`의 Vite 개발 서버 페이지에 서비스 접속 정보를 주입합니다.

클라이언트 빌드:

```bash
npm run build
```

독립 서버/브라우저 모드:

```bash
npm run start:web
# 기본 주소: http://127.0.0.1:47831
```

세부 설계는 [`docs/codex-usage.md`](docs/codex-usage.md), [`docs/provider-adapter-contract.md`](docs/provider-adapter-contract.md), [`docs/http-sse-transport.md`](docs/http-sse-transport.md)를 참고하세요.
