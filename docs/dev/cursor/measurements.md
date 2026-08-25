# Cursor 로컬 저장소 실측

실측 시점: 2026-08-25. 대상은 실제 사용 중인 Windows 머신 한 대이고, Cursor IDE(Composer)와
Cursor CLI(`cursor-agent`) 둘 다 활성 사용 중입니다. 목적은 "Cursor가 토큰량을 로컬에
남기는가, 남긴다면 어디에 무슨 모양으로"를 가이드 문서가 아니라 실제 파일을 읽어 답하는
것입니다 — [gemini/antigravity.md](../gemini/antigravity.md)와 같은 방법입니다.

## 왜 실측부터 하는가

기존 계획([provider-token-api.md §5.3](../provider-token-api.md), [roadmap.md Phase
3](../../roadmap.md))은 "Cursor는 로컬 파일 원장이 없는 provider"라고 단정하고
Admin API를 유일한 경로로 삼았습니다. 그 단정이 여전히 맞는지를 이번에 다시
확인했습니다 — 맞지만, 이유가 조사 시점의 예상과 다릅니다: **로컬 저장소는 존재하고
방대하지만, 그 안에 토큰 수 필드가 없습니다.** 이 구분이 중요한 이유는 "저장소가 없다"와
"저장소는 있는데 그 필드가 없다"가 이후 설계에서 다른 결론으로 이어지기 때문입니다
(agy 케이스와 같은 구조 — [antigravity.md](../gemini/antigravity.md) 참고).

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

## 확인되지 않은 것

### 토큰 수 필드 — 평문 JSON 전수 스캔에서 0건

3,629개 blob(대화 32개) 전체를 `role`이 있는 JSON으로 파싱해 `/token/i` 정규식으로
훑었습니다. 매치 66건 전부가 같은 키 하나, `"__contextReadToken"`이었고, 이건 **컨텍스트
읽기 API의 페이지네이션 커서**로 보입니다(값이 짧은 불투명 문자열이고 반복 조회에
쓰임) — 토큰 **수**가 아니라 토큰(token)이라는 낱말이 겹친 다른 개념입니다.
`inputTokens` · `outputTokens` · `promptTokens` · `totalTokens` · `tokenUsage` ·
`usage":{` 패턴은 0건입니다. `%APPDATA%\Cursor\User`와 `~/.cursor`의 다른 JSON
파일(`statsig-cache.json`, `settings.json` 등)에서도 같은 패턴을 찾았지만 매치는
feature-flag 설정값(`tokenUsageThresholdPercentage`) 하나뿐이었고, 실측된 사용량이
아니라 SDK가 내려받은 설정입니다.

### 이진 blob의 필드 의미 — 1차 스캔(표본 12개)에서 후보 없음, 확정 아님

일반 wire-scanner로 12개 이진 blob을 펼쳐 필드 번호·값을 전부 봤습니다. 도구 호출
시작/종료 시각, 클라이언트 타입, 타임존, grep 패턴, 파일 목록 외에 토큰 수처럼 보이는
정수 필드는 없었습니다. 그러나 **agy 조사에서 이미 겪은 그대로**, 표본 12개는 근거로
삼기엔 너무 적고, 이번 스캔은 varint(wire 0)·length-delimited(wire 2) 재귀만 최소
구현으로 훑은 것이라 필드 경로별 통계(최소/최대/단조성/조각-합 후보)까지는 내지
않았습니다. **"없다"가 아니라 "12개 표본에서는 못 찾았다"로만 남깁니다.**
[decisions.md](./decisions.md)의 Phase 0가 `probe-antigravity.mjs`와 같은 방식의
전수 조사를 다음 단계로 둡니다.

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

이 문서의 수치는 임시 스크립트(`node --experimental-sqlite`, 이 저장소에 커밋하지
않음)로 냈습니다. 재현 가능한 형태로 남기는 첫 산출물이
[decisions.md](./decisions.md)의 `scripts/probe-cursor.mjs`입니다 —
`scripts/probe-antigravity.mjs`와 같은 목적(필드 번호·통계만 출력, 본문 금지)으로
Cursor의 이진 blob을 훑습니다.
