# LLM별 기능지원표

Claude Code · Codex · Gemini CLI · Cursor 네 provider가 이 코드베이스에 실제로
구현된 토큰 사용량 기능을 각각 지원하는지를 O/X로 정리합니다. 표의 근거(파일:줄,
문서 인용, 실측 수치)는 [LLM별 기능지원표 상세.md](./LLM별%20기능지원표%20상세.md)에
행 번호로 정리해 뒀습니다 — 이 문서는 스캔용, 상세 문서는 근거용입니다.

기준 시점: 2026-08-25. Claude·Codex·Gemini는 어댑터가 구현돼 있고(`PROVIDER_CATALOG`의
`integration: 'connected'`), Cursor는 아직 어댑터가 없습니다(`integration: 'planned'`,
[cursor/](./cursor/README.md) 참고) — 다만 로컬 저장소를 실측해 **일부 신호는 이미
확인됐습니다.** 그 신호는 O/X 대신 △로 표기하고 각주로 무엇이 확인됐는지 적습니다.

## 표기 범례

| 표기 | 뜻 |
|---|---|
| **O** | 코드에 구현돼 있고 실측(테스트 또는 실 코퍼스)으로 동작이 확인됨 |
| **△** | 부분적으로만 참 — 구현됐지만 알려진 결함으로 실제 원장에 못 미치거나(Codex), 로컬에 신호는 실측됐지만 코드로 연결되지 않음(Cursor) |
| **X** | 코드에 없음, 또는 실측 결과 값이 없음/설계상 배제됨 |

## 확인한 API·화면 목록

아래 기능 행은 이 API들이 실제로 반환하는 데이터에 근거합니다(`service/api-server.mjs`).

| API | 메뉴 | 무엇을 반환하나 |
|---|---|---|
| `GET /api/v1/snapshot` | 대시보드 | provider별 현재 상태·capabilities·전체 합계 |
| `GET /api/v1/usage/timeseries` | AI 사용량 | 기간·버킷별 토큰 시계열 |
| `GET /api/v1/usage/models` | AI 사용량 | 모델별 토큰 breakdown |
| `GET /api/v1/projects`, `/projects/recent` | 프로젝트 | 프로젝트별 집계·최근 활동 |
| `GET /api/v1/projects/:key`, `POST .../alias` | 프로젝트 | 프로젝트 상세·가림 설정 |
| `GET /api/v1/sessions` | 세션 흐름 | 세션 순위(총 토큰 기준) |
| `GET /api/v1/sessions/:id/flow` | 세션 흐름 | 턴·단계·컨텍스트 곡선 |
| `GET /api/v1/sessions/:id/turns/:idx/detail` | 세션 흐름 | 턴 상세(채팅/도구/MCP/파일) |
| `GET /api/v1/sessions/:id/records` | 상세 내역 | 프로젝트→세션→도구 토큰 레코드 |
| `GET /api/v1/sessions/:id/tool-calls/:id/content` | 상세 내역 | 도구 호출 본문(클릭 시 팝업) |
| `GET/POST/DELETE /api/v1/providers/:id/hooks` | 동기화 | lifecycle hook 설치/해제/상태 |
| `GET /api/v1/quota/history` | 동기화 | 서버 한도 snapshot 이력 |
| `POST /api/v1/rescan`, `GET /api/v1/diagnostics` | 동기화 | 재스캔, 수집 진단 |

## 기능 지원 매트릭스

### 1. 로컬 토큰 원장

| # | 기능 | Claude | Codex | Gemini | Cursor |
|---|---|---|---|---|---|
| 1 | 로컬 파일/DB 기반 요청 단위 토큰 원장 | O | O | O | X |
| 2 | 입력 토큰 실측 | O | O | O | X |
| 3 | 출력 토큰 실측 | O | O | O | X |
| 4 | 캐시 **읽기** 토큰 구분 | O | O | O | X |
| 5 | 캐시 **쓰기** 토큰 구분 | O | O | X | X |
| 6 | Reasoning/Thinking 토큰 분리 | O | O | O | X |
| 7 | Tool 사용량 지원여부 | O | △ | △ | X |
| 8 | 필드별 신뢰도 등급(`field_quality`) | O | X | O | X |
| 9 | 정정 가능한 중복 제거(upsert, vs insert-or-ignore) | O | X | O | X |

> **7번은 "도구를 얼마나 썼는지 알 수 있는가"를 종합한 값입니다.** 실제로는 세
> 겹입니다 — 이름·호출 횟수 기록(21번), 턴 상세에서 토큰으로 재배분해 보여주는
> 화면(22번), provider가 원본 로그에 별도로 주는 독립 `toolTokens` 필드(이건
> 사실상 아무도 못 씁니다). Claude는 세 겹 다 되고, Codex는 턴 상세의 파일
> 가지만 비어 있고, **Gemini는 이름·횟수 기록과 세션 단위 단계 배분까지는
> 되지만 턴 단위 drill-down 화면은 아직 `supported: false`**라 △입니다. 근거는
> [LLM별 기능지원표 상세.md #7](./LLM별%20기능지원표%20상세.md).

### 2. 서버 연동 (Admin API/서버 한도)

| # | 기능 | Claude | Codex | Gemini | Cursor |
|---|---|---|---|---|---|
| 10 | 서버 사용량/한도 스냅샷 수집 | X | O | X | X |
| 11 | 한도 이력 화면에 데이터 존재 | X | O | X | X |
| 12 | 서버-로컬 대조(reconciliation) 분류 | X | O | X | X |

### 3. 자동화·보강 경로

| # | 기능 | Claude | Codex | Gemini | Cursor |
|---|---|---|---|---|---|
| 13 | Lifecycle Hook 자동 설치 | O | O | X | X |
| 14 | 텔레메트리(OTLP) 보강 경로 | △ | X | X | X |

### 4. 프로젝트·세션 집계

| # | 기능 | Claude | Codex | Gemini | Cursor |
|---|---|---|---|---|---|
| 15 | 프로젝트(cwd) 귀속 | O | O | O | △ |
| 16 | 프로젝트 경로 가림(redaction) | O | O | O | X |
| 17 | 토큰 기준 세션 순위 | O | O | O | X |
| 18 | 세션 흐름 화면(컨텍스트 곡선·단계 배분) | O | △ | O | X |

### 5. 턴 단위

| # | 기능 | Claude | Codex | Gemini | Cursor |
|---|---|---|---|---|---|
| 19 | 턴 경계 인식(파서 레벨) | O | O | O | X |
| 20 | 턴 단위 사용량이 실제 원장에 반영됨 | O | △ | O | X |
| 21 | 도구→작업단계 매핑 | O | O | O | X |
| 22 | 턴 상세(채팅/도구/MCP/파일 분해) | O | △ | X | X |

### 6. Cursor 고유 신호 (M6a 실측)

| # | 기능 | Claude | Codex | Gemini | Cursor |
|---|---|---|---|---|---|
| 23 | 컨텍스트 구성 breakdown(그 시점 토큰 스냅샷) | X | X | X | △ |

## 한눈에 보는 관찰

- **Codex만 서버 대조(그룹 2)를 갖고, 그 대가로 그룹 1·5의 두 곳(9·20)에서 결함을
  치릅니다.** `insertUsageEvent`(INSERT OR IGNORE)를 쓰는 대가로 `turn_index`가
  한 번 NULL로 적재되면 재해석이 못 고칩니다 — 실제 원장 18,853행 중 6행만 턴이
  붙어 있습니다(상세 문서 #20).
- **Gemini는 그룹 1·5에서 Claude와 거의 동등하지만(8·19·20·21 전부 O), 그룹
  2·3이 전부 X입니다** — 서버 한도도, hook도 없습니다. 캐시 쓰기 구분(5)도 없는
  유일한 구현된 provider입니다.
- **Cursor는 지금 코드 기준으로 그룹 1·2·3·4·5 전부 X이지만, 그룹 6(23)과 15는
  △입니다** — 로컬에 있는 신호(cwd 귀속, 컨텍스트 구성 breakdown)는 실측으로
  확인됐고 항등식까지 맞았지만, 아직 어댑터 코드로 연결되지 않았을 뿐입니다.
  "안 된다"가 아니라 "아직 안 만들었다"입니다.
- **field_quality(8)는 Claude·Gemini에만 있고 Codex에는 없습니다.** Codex는 모든
  이벤트를 `'local_exact'`로 고정 표시합니다 — 등급을 매기지 않는 것이지 등급이
  높아서가 아닙니다.
