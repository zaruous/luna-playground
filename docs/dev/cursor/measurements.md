# Cursor 로컬 저장소 실측

실측 시점: 2026-08-25(1차) · 2026-08-25(2차, 정정). 대상은 실제 사용 중인 Windows 머신
한 대이고, Cursor IDE(Composer)와 Cursor CLI(`cursor-agent`) 둘 다 활성 사용 중입니다.
목적은 "Cursor가 토큰량을 로컬에 남기는가, 남긴다면 어디에 무슨 모양으로"를 가이드
문서가 아니라 실제 파일을 읽어 답하는 것입니다 — [gemini/antigravity.md](../gemini/antigravity.md)와
같은 방법입니다.

> **정정 (2026-08-25, 같은 날 2차 조사).** 1차 조사는 "평문 JSON blob 3,629개 전수 +
> 이진 blob 표본 12개에서 토큰 수 필드를 못 찾았다"를 "토큰 수 필드가 없습니다"로
> 요약해 전달했습니다. **틀렸습니다.** 표본 12개가 너무 적었던 것이지 정말 없는 게
> 아니었습니다 — [antigravity.md](../gemini/antigravity.md#protobuf-는-필드-이름이-없다)가
> 이미 경고했던 바로 그 함정("grep으로 없다고 봤다가 틀렸다")을 이번엔 grep이 아니라
> **표본 부족**으로 반복한 것입니다. `scripts/probe-cursor.mjs`로 이진 blob 1,068개
> 전체를 훑자 컨텍스트 구성 breakdown 구조가 나왔고, 실측 586개 전부에서 조각 합이
> 선언된 총합과 정확히 일치했습니다. 아래 "확인된 것"의 새 절이 그 내용이고,
> [decisions.md](./decisions.md)와 [README.md](./README.md)도 이 결과에 맞춰
> 갱신했습니다. 이 절을 지우지 않고 남기는 이유는 이 프로젝트의 관례입니다 —
> M5에서 예측이 틀렸던 두 곳을 지우지 않고 정정으로 남긴 것과 같습니다
> ([implementation-plan.md M5](../implementation-plan.md#m5--gemini-cli-어댑터--완료)).

## 왜 실측부터 하는가

기존 계획([provider-token-api.md §5.3](../provider-token-api.md), [roadmap.md Phase
3](../../roadmap.md))은 "Cursor는 로컬 파일 원장이 없는 provider"라고 단정하고
Admin API를 유일한 경로로 삼았습니다. 그 단정을 이번에 다시 확인했더니 **틀렸습니다**
— 로컬 저장소는 존재하고 방대하며, 그 안에 실제 토큰 수 필드(컨텍스트 구성
breakdown)가 있습니다. 다만 처음엔 이걸 놓쳤습니다: 이진 blob 표본 12개만 보고
"필드가 없다"고 결론 냈다가, 표본을 전체(1,068개)로 넓히자 뒤집혔습니다 — 위 정정
문단과 아래 "확인된 것"이 그 경위와 실측치입니다. "저장소가 없다"·"저장소는 있는데
필드가 없다"·"저장소도 필드도 있는데 모양이 다르다" 세 가지가 이후 설계에서 각자
다른 결론으로 이어지므로, 지금은 세 번째입니다(agy 케이스가 두 번째 경우의 참고
사례 — [antigravity.md](../gemini/antigravity.md)).

## 어디에 무엇이 있는가

Cursor는 두 개의 독립된 로컬 저장 표면을 씁니다. IDE(Composer 패널)와 CLI(`cursor-agent`)가
겹치지 않는 위치에 각자 기록합니다.

```text
[A] Cursor IDE (Composer) — VSCode 계열 전역 상태
%APPDATA%\Cursor\User\globalStorage\state.vscdb   (SQLite)
  ItemTable(key, value)          cursorAuth/*, secret://*, cursor.slashUsage.v1 등
  composerHeaders(composerId, workspaceId, createdAt, lastUpdatedAt,
                  isArchived, isSubagent, recency, checkpointAt, value)
  cursorDiskKV(key, value)       agentKv:blob:<sha256> — 컴포저 대화의 청크 blob 저장소

[B] Cursor CLI (cursor-agent) — 홈 디렉터리
~/.cursor/chats/<workspaceHash>/<chatId>/meta.json    { schemaVersion, createdAtMs, updatedAtMs, cwd }
~/.cursor/chats/<workspaceHash>/<chatId>/store.db     blobs(id TEXT PK, data BLOB), meta(key,value)
~/.cursor/projects/<slug>/agent-transcripts/<uuid>/…  프로젝트별 transcript 디렉터리
~/.cursor/projects/<slug>/sdk-agent-store/…
~/.cursor/ai-tracking/ai-code-tracking.db             AI vs 사람 코드 라인 기여도(diff 기반) — 토큰 아님
~/.cursor/cli-config.json                             선택된 모델·권한·authInfo(email 등, 시크릿 아님)
```

두 표면 모두 **같은 blob 저장 방식**을 씁니다 — 내용 주소화(hash를 key로) SQLite
key-value 또는 `blobs(id, data)` 테이블에, 청크 단위로 대화 조각을 저장합니다.
IDE 쪽(`cursorDiskKV`)이 CLI 쪽(`chats/*/store.db`)보다 훨씬 큽니다(개발 머신 기준
235,844 키 대 32개 대화 · 3,629 blob) — Composer를 더 오래, 더 많이 썼기 때문입니다.

## 실측 규모

| 표면 | 파일/행 수 |
|---|---|
| `~/.cursor/chats/**/store.db` | 대화(chat) 32개 · blob 3,629개 |
| `cursorDiskKV` (`agentKv:blob:*`) | 키 235,844개 (전체 `cursorDiskKV`는 그 이상 — 파일 인덱스 등 포함) |
| `composerHeaders` | 694행 |
| `ai_code_hashes` (`ai-tracking.db`) | 59,990행 |

## 확인된 것

### blob은 두 종류로 갈린다 — 평문 JSON(본문 있음) / 이름 없는 이진(protobuf류)

blob의 첫 바이트로 구분됩니다.

- `{` 또는 `[`로 시작 → **평문 JSON**. `{"role":"system"|"user"|"assistant"|"tool", "content": ...}`
  모양이고, `content`에 시스템 프롬프트·사용자 질문·도구 결과 **본문 전체**가 그대로
  들어 있습니다. 3,629개 표본에서 역할 분포는 system 32 · user 78 · assistant 314 ·
  tool 723 — 나머지는 아래 이진 블롭입니다.
- 그 외 → **필드 이름 없는 이진**. 앞 4바이트가 protobuf 태그-바이트 패턴과 일치하고,
  일반 protobuf wire-format 스캐너로 재귀 디코드됩니다(`gemini/antigravity-protobuf.mjs`가
  이미 이 작업을 하는 코드입니다 — 재사용 대상). 관측된 내용: 도구 호출 시작/종료
  epoch-ms(예: `f59=1787118450907, f60=1787118453527`), 클라이언트 타입 문자열
  `"cli"`, 타임존 `"Asia/Seoul"`, grep/glob에 쓴 패턴 문자열, 파일 목록. **사람이 읽을
  수 있는 문자열이 필드 값으로 그대로 나오는 하위 필드도 있어**, 이진이라고 본문이
  전혀 없다고 단정할 수 없습니다 — 파일 경로나 검색어 같은 구조·본문 경계 항목의
  스펙트럼입니다.

첫 문서 조사에서 흔히 하는 실수를 [antigravity.md](../gemini/antigravity.md#protobuf-는-필드-이름이-없다)가
이미 지적했습니다: `grep token`으로 이진 블롭에서 "없다"고 결론 내리면 틀립니다.
와이어 포맷에는 필드 번호만 있고 이름이 없어 문자열 검색이 통하지 않습니다. 이번
조사도 그 함정을 피하려고 **일반 protobuf wire-scanner로 필드 번호·와이어타입·값을
전부 나열**한 뒤 살폈습니다(아래 "확인되지 않은 것" 참고) — 다만 표본이 12개 blob뿐이라
이 조사는 1차 스캔이고, [decisions.md](./decisions.md)의 Phase 0가 이어서 다룹니다.

### `contextUsagePercent` — 유일하게 확인된 사용량 인접 신호 (토큰 아님)

`composerHeaders.value`(JSON)에 표준 필드가 있습니다.

```json
{
  "type": "head",
  "composerId": "8efabe37-...",
  "contextUsagePercent": 47.803,
  "totalLinesAdded": 66,
  "totalLinesRemoved": 15,
  "subtitle": "Edited 진행내역.md, YmsViewBoxPlotReportPeriod.js",
  "filesChangedCount": 2,
  "trackedGitRepos": [{ "repoPath": "...", "branches": [...] }],
  "workspaceIdentifier": { "id": "...", "configPath": { "fsPath": "..." } },
  "createdAt": 1783503843722,
  "lastUpdatedAt": 1783552831360
}
```

694행 중 200행 표본에서 170행(85%)이 `contextUsagePercent`를 갖습니다. 이 값은 **그
컴포저(대화)의 컨텍스트 창 점유율**입니다 — Codex의 `/status` 백분율 한도, Antigravity의
`1.9.10.1/1.9.10.4`(누적 컨텍스트 크기 / 창 크기)와 같은 종류의 신호입니다. **토큰
수가 아니라 백분율**이라는 점이 핵심이고, R5("백분율 한도는 토큰으로 변환하지
않는다")가 그대로 적용됩니다.

`workspaceIdentifier`/`trackedGitRepos`는 프로젝트 귀속에 바로 쓸 수 있습니다 — Claude의
`cwd` 귀속과 같은 역할입니다.

### `meta.json` (CLI 쪽) — cwd와 시각만

```json
{"schemaVersion":1,"createdAtMs":1787118408128,"hasConversation":true,
 "updatedAtMs":1787118498753,"cwd":"C:\\Users\\USER\\git\\node\\e2eTests"}
```

프로젝트 귀속(cwd)과 대화 존재 여부는 여기서 바로 나옵니다. 토큰·모델 필드는 없습니다.

### `ai_code_hashes` (ai-tracking.db) — 모델·요청 귀속, 토큰 아님

```sql
CREATE TABLE ai_code_hashes (
  hash TEXT PRIMARY KEY, source TEXT NOT NULL, fileExtension TEXT, fileName TEXT,
  requestId TEXT, conversationId TEXT, timestamp INTEGER, model TEXT, createdAt INTEGER NOT NULL
)
```

59,990행. `requestId` · `conversationId` · `model` · `timestamp`가 있어 "이 대화가 어느
모델을 썼나"의 보조 근거는 되지만, 이 테이블의 본래 목적은 AI 생성 코드 라인 비율
추적(diff 기반)이라 토큰 수는 어디에도 없습니다.

### `cli-config.json` — 계정·모델 기본값 (시크릿 아님)

`authInfo.email` · `teamId` · `teamName`, 선택된 모델(`model.modelId`), 권한 allowlist
등. 이 파일에 API 키나 토큰 값 자체는 없습니다(`cursorAuth/*`는 별도로 `state.vscdb`의
`ItemTable`에 있고, 그건 절대 읽지 않습니다 — [decisions.md](./decisions.md)).

## 확인된 것 (2차 조사) — 컨텍스트 구성 breakdown, 진짜 토큰 수 필드

`scripts/probe-cursor.mjs`로 `~/.cursor/chats/**/store.db`의 이진 blob **1,068개
전체**(평문 JSON은 여전히 건너뜀)를 `service/providers/gemini/antigravity-protobuf.mjs`의
`scanProtobuf`로 재귀 스캔했습니다. 필드 경로 `5.1`/`5.2`/`5.3.3[]`에 이름 있는(!)
브레이크다운이 있습니다 — protobuf 필드 이름이 와이어에 없다는 원칙은 여전히
맞지만, 이 메시지는 **하위 필드 중 하나가 카테고리 이름 문자열 자체**라서
`system_prompt` / `tools` / `rules` 처럼 사람이 읽는 라벨이 그대로 나옵니다.

```text
5.1                    = 그 시점 컨텍스트 총 토큰 수
5.2                    = 컨텍스트 창 크기 (관측값: 200000 · 256000)
5.3.1 / 5.3.2          = 5.1 / 5.2 와 항상 동일값 — 같은 헤더의 중첩 사본
5.3.3[]                = 카테고리별 항목 반복
  5.3.3.1              = 카테고리 키 (예: "system_prompt")
  5.3.3.2              = 카테고리 표시명 (예: "System prompt")
  5.3.3.3              = 그 카테고리의 토큰 수
  5.3.3.4              = 그 카테고리의 문자 수 (5.3.3.3 대비 항상 ≈3.42배 — 토큰당 평균 글자수)
```

관측된 카테고리 8종: `system_prompt` · `tools` · `rules` · `skills` · `mcp` ·
`subagents` · `summarized_conversation` · `conversation`.

**항등식 검증(전수)**: 이진 blob 1,068개 중 586개가 이 구조를 갖고, **586개 전부에서
`Σ(카테고리별 5.3.3.3) == 5.1`이 정확히 일치**합니다(불일치 0). 예시(한 대화, 세
시점 스냅샷):

```text
system_prompt 617 + tools 8460 + rules 7093 + skills 2797 + mcp 1240 +
subagents 601 + summarized_conversation 0 + conversation 1825 = 22633 == 5.1
```

`window size`(5.2)는 관측 586개 중 583개가 200000, 3개가 256000 — 모델별 컨텍스트
창 크기로 보입니다(200K은 Claude 계열 창 크기와 일치). `5.1`(총 토큰) 관측 범위는
13,326~186,654입니다.

`summarized_conversation` 카테고리는 관측된 586개 전부에서 0입니다 — 이 대화들에서
아직 컴팩션(요약)이 일어나지 않았다는 뜻으로 읽힙니다. 값이 0이면 `5.3.3.3` 필드
자체가 와이어에서 생략됩니다(proto3 기본값 생략 규칙과 일치) — 그래서 스캐너가
"없으면 0"으로 채워 합을 계산합니다.

`conversation` 카테고리는 같은 대화의 연속 스냅샷에서 1825 → 1825 → 3593 → 3593 →
6958 → 6958처럼 **단조 비감소**하고, 나머지 카테고리(`system_prompt`/`tools`/`rules`/
`skills`/`mcp`/`subagents`)는 같은 구간에서 값이 고정입니다 — 대화가 길어질수록 그
차이만큼 `conversation` 칸이 자라는 모양이 정확히 일관됩니다. 값이 두 번씩 반복되는
것은(1825가 두 blob에 연속으로) 같은 스냅샷이 서로 다른 blob(예: 요청 시작/종료)에
중복 기록되기 때문으로 보이고, 이 중복은 [decisions.md](./decisions.md)의 재집계
결정에서 다룹니다.

**이게 대답하는 것과 대답하지 못하는 것.** 이 구조는 "그 시점 컨텍스트 창에 무엇이
얼마나 들어있나"(구성 스냅샷)를 답합니다. Codex/Claude/Gemini가 주는 "이 요청이 입력
몇 개·출력 몇 개를 썼나"(요청 단위 델타)와는 다른 종류입니다. `conversation` 칸의
증가량을 턴 사이 델타로 쓸 수는 있지만, 그 델타는 사용자 메시지와 어시스턴트 응답을
가르지 않고 합쳐서 담습니다 — Antigravity의 `1.9.10.1`이 "누적 컨텍스트 크기"였고
소비 토큰이 아니었던 것과 같은 성격의 주의가 필요합니다
([antigravity.md](../gemini/antigravity.md)의 "`1.9.10.*` — 컨텍스트 크기(소비 토큰
아님)" 절, 특히 "합산 금지" 문단).

재현: `node scripts/probe-cursor.mjs`.

## 확인되지 않은 것

### 개별 메시지 단위 타임스탬프·모델

평문 JSON 메시지 블롭 안에는 그 메시지 자체의 시각이나 모델 이름이 없습니다(딱 하나
예외: 도구 호출 인자 안에 우연히 등장한 `"model":"fast"`— 이건 subagent 호출
파라미터고 실제 사용 모델이 아닙니다). 시각은 이진 blob에 있는 것으로 보이고(위
f59/f60), 그 필드가 어느 JSON 메시지와 짝인지는 blob 간 참조 관계를 추가로 밝혀야
압니다 — 미확인.

## 절대 읽지 않은 것 (의도적으로 건드리지 않음)

아래는 이번 조사 중 **위치는 확인했지만 값을 읽지 않은** 항목입니다. 로컬 전용
계획이라도 이 셋은 범위 밖입니다.

- `ItemTable`의 `cursorAuth/accessToken` · `cursorAuth/refreshToken` — 로그인 자격증명.
- `secret://{"extensionId":...}` 키들(`anysphere.cursor-resolver-helper`
  connectionToken, `vscode.git`의 `git-ipc-auth-token` 등) — 다른 확장의 시크릿.
- 모든 blob의 `content` 필드 값 — 시스템 프롬프트·사용자 질문·도구 결과 본문.

이 경계는 [claude-code-adapter.md §17](../../claude-code-adapter.md)·
[session.md 설계 원칙](../menus/session.md#설계-원칙-본문-없이-절차를-본다)과 동일하고,
Cursor 쪽이 오히려 더 엄격해야 합니다 — 여기 본문은 **JSONL 한 파일이 아니라 SQLite
blob 저장소 전체**이므로 실수로 테이블을 통째로 읽으면 그대로 본문 사본이 됩니다.

## 참고: 실측에 쓴 스크립트

1차 조사(표본 12개, "확인되지 않음"으로 결론 냈던 쪽)는 임시 스크립트로 냈습니다.
**2차 조사(정정, 컨텍스트 breakdown을 찾은 쪽)는 `scripts/probe-cursor.mjs`로
재현 가능합니다** — `scripts/probe-antigravity.mjs`와 같은 방법(필드 번호·통계만
출력, 평문 blob은 첫 바이트로 걸러 절대 열지 않음)으로 이진 blob **전체**를
훑고, varint 필드 경로별 count/min/max/단조성과 "조각 합 == 총합" 후보를 냅니다.

```bash
node scripts/probe-cursor.mjs
# NYANG_CURSOR_HOME=/path node scripts/probe-cursor.mjs        (~/.cursor 대체)
# NYANG_CURSOR_APPDATA=/path node scripts/probe-cursor.mjs     (Cursor User 데이터 대체)
```

실측 규모(2026-08-25, 이 머신): CLI 대화 32개 · blob 1,642개(평문 574 · 이진 1,068) ·
`5.1`/`5.3.3[]` breakdown 있는 blob 586개 · 항등식 불일치 0건. IDE 쪽
`cursorDiskKV`(agentKv:blob)는 이번 실행에서 6행만 잡혔는데, 이 스크립트가 도는 동안
Cursor IDE가 `state.vscdb`를 잠그고 있었을 가능성이 있어 **미확인으로 남깁니다** —
IDE 프로세스를 닫고 재실행해 확인하는 것이 다음 조사 항목입니다.
