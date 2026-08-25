# LLM별 기능지원표 상세 (근거)

[LLM별 기능지원표.md](./LLM별%20기능지원표.md)의 각 행 번호에 대한 근거입니다. 코드
인용은 조사 시점(2026-08-25) 기준 파일:줄이고, 리뷰 시점에 줄 번호가 옮겨갔다면
같은 함수/변수 이름으로 다시 찾으세요. Cursor 항목은 [cursor/measurements.md](./cursor/measurements.md)·
[cursor/decisions.md](./cursor/decisions.md)를 그대로 가리킵니다 — 중복 서술하지 않습니다.

## 그룹 1 — 로컬 토큰 원장

### 1~3. 로컬 원장 · 입력 · 출력 토큰

- **Claude**: `service/providers/claude/parser.mjs`가 `usage.input_tokens`/`usage.output_tokens`를 직접 읽습니다(누적 diff 아님). `capabilities.accounting: 'direct'` — `service/providers/claude/collector.mjs:46`.
- **Codex**: `service/providers/codex/parser.mjs`가 `total_token_usage`/`last_token_usage` 누적값을 diff합니다. `capabilities.accounting: 'cumulative_diff'`.
- **Gemini**: 메시지가 이미 요청 단위(`accounting: 'direct'`) — `service/providers/gemini/collector.mjs:49`.
- **Cursor**: 요청 단위 원장이 로컬에 없습니다. `~/.cursor/chats`·`state.vscdb`를 이진 blob까지 전수 스캔했지만 `inputTokens`/`outputTokens` 류 필드는 0건입니다([measurements.md 확인되지 않은 것](./cursor/measurements.md#확인되지-않은-것)). 대신 있는 것은 행 23의 컨텍스트 구성 스냅샷입니다 — 성격이 다릅니다.

### 4~5. 캐시 읽기 / 캐시 쓰기 토큰 구분

정규화 매핑 원천은 `docs/dev/provider-token-api.md:336`의 "정규화 매핑 요약" 표입니다.

| provider | 캐시 읽기 필드 | 캐시 쓰기 필드 |
|---|---|---|
| Codex | `cached_input_tokens` | `cache_write_input_tokens` |
| Claude | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens` |
| Gemini | `cached` | **없음**(표에 `—`) |
| Cursor | 없음 | 없음 |

Gemini에 캐시 쓰기 필드가 없다는 것은 설계 문서의 서술이고, `service/providers/gemini/parser.mjs`에서도 `cacheWriteInputTokens`를 채우는 코드가 없습니다(항등식 `input+output+thoughts==total`이 캐시 쓰기 없이 성립 — [gemini/README.md](./gemini/README.md#측정-accounting--두-곳)).

### 6. Reasoning/Thinking 토큰 분리

- **Claude**: `service/providers/claude/parser.mjs:17-24` — `output_tokens_details.thinking_tokens`는 **2.1.228부터** 존재. 그 이전 버전 로그는 필드가 없어 `reasoningTokens`를 "미제공"으로 남깁니다(0이 아님). `THINKING_DETAIL_MIN_VERSION = '2.1.228'`.
- **Codex**: `service/providers/codex/parser.mjs:26` — `reasoningTokens: clampNonNegative(raw.reasoning_output_tokens ?? raw.reasoningTokens)`. 버전 게이팅이나 신뢰도 서술은 `docs/codex-usage.md`에 없습니다(그 문서에 `reasoning` 언급 0건) — 있으면 그대로 쓰고 없으면 0으로 떨어진다는 뜻입니다.
- **Gemini**: `service/providers/gemini/parser.mjs:134` — `const reasoning = clampNonNegative(tokens.thoughts)`. 신뢰도는 항등식 성립 여부로 등급화됩니다(행 8).
- **Cursor**: 없음.

### 7. Tool 사용량 지원여부

"도구를 얼마나 썼는지 알 수 있는가"는 코드에서 서로 다른 세 겹으로 나뉘어
있습니다 — (a) 도구 이름·호출 횟수 기록(`tool_counts`, 아래 21번), (b) 그걸 턴
상세 화면에서 입력+출력 토큰을 호출 비율로 재배분해 보여주는 것(22번), (c)
provider가 원본 로그에 별도로 주는 독립 `toolTokens` 필드. 이 행의 O/△/X는
**(a)와 (b)를 종합한 값**입니다 — (c)는 실제로 쓰이는 곳이 없어 종합 판단에서
비중을 두지 않았고, 사실만 각 provider 항목 끝에 남겨 둡니다.

- **Claude — O.** (a) `tool-phases.mjs`의 `claude:` 테이블이 실제 도구 이름을 담고 있고, (b) `claude/turn-detail.mjs`가 `supported: true`로 완전히 동작합니다 — 셋 중 유일하게 (a)·(b) 둘 다 완전합니다. (c) 독립 필드는 `service/providers/claude/parser.mjs:85` — `toolTokens: 0,` **하드코딩**이고 읽으려는 시도 자체가 없습니다.
- **Codex — △.** (a) `tool-phases.mjs`의 `codex:` 테이블도 실제 도구 이름을 담습니다. (b) `codex/turn-detail.mjs`가 `supported: true`이긴 하나 `filesMeasured: false`로 파일 가지만 항상 비어 있습니다(파서가 경로를 안 뽑음). (c) 모델에 `toolTokens` 키 자체가 없습니다(`EMPTY_USAGE`, `normalizeUsage` 등에 없음) — DB 컬럼이 0인 것은 `service/store.mjs`가 `usage.toolTokens ?? 0`으로 코얼레스해서고, Codex가 측정한 값이 아닙니다.
- **Gemini — △.** (a) `tool-phases.mjs`의 `gemini:` 테이블이 있고(M5에서 실제 로그로 채움), 세션 순위의 "우세 단계"·세션 흐름의 "단계별 배분"에 이미 씁니다. (b) 그런데 `gemini/turn-detail.mjs`가 `supported: false, reason: 'provider_not_implemented'`인 **템플릿뿐**이라, 이름·횟수 재료는 있어도 턴 단위로 토큰까지 쪼개 보여주는 화면은 아직 없습니다 — 그래서 O가 아니라 △. (c) `service/providers/gemini/parser.mjs:135,145`가 `tool` 필드를 실제로 읽지만, **코퍼스 전체에서 관측값이 항상 0**이라 `total` 안/밖 위치를 확정하지 못합니다(`gemini/collector.mjs:82-83`의 `toolTokensSeen` 카운터가 이 사실을 위한 것).
- **Cursor — X.** (a)·(b) 전부 X — 어댑터 자체가 없어 도구 이름을 기록할 재료가 없습니다. (c)도 당연히 없습니다.

### 8. 필드별 신뢰도 등급(`field_quality`)

- **Claude**: `service/providers/claude/parser.mjs:167-195` `claudeFieldQuality()` — 필드별로 등급을 매기고, 원본에 없는 키는 **삭제**합니다(0으로 안 남김). `eventQuality()`가 `measurementQuality`로 롤업.
- **Codex**: 그런 함수가 없습니다. `service/providers/codex/parser.mjs:295`가 모든 이벤트에 `measurementQuality: 'local_exact'`를 **고정** 부여합니다 — 등급을 매기는 게 아니라 항상 "확실"이라고 말하는 것입니다. 실제로 이 필드 자체는 `field_quality` 컬럼에 저장되긴 하나(`docs/codex-usage.md`가 "Codex 행 18,853개 전부 NULL"이라고 명시하는 건 `field_quality`/`parser_version`/`request_id` 세 컬럼이 애초에 `insertUsageEvent`의 INSERT 목록에 없어서입니다 — 행 9·20 참고).
- **Gemini**: `service/providers/gemini/parser.mjs:71-80` `geminiFieldQuality({ cacheInsideInput, identityHolds })` — Claude와 대등한 실제 등급 매커니즘.
- **Cursor**: 없음.

### 9. 정정 가능한 중복 제거(upsert)

- **Claude**: `service/providers/claude/collector.mjs:189` — `this.store.upsertUsageEvent(...)`. 같은 요청이 다시 관측되면 갱신됩니다.
- **Codex**: `service/providers/codex/collector.mjs:167` — `this.store.insertUsageEvent(...)`, SQL은 `INSERT OR IGNORE`(`service/store.mjs:548`). **이게 바로 행 20의 결함 원인**입니다 — `turn_index`가 한 번 NULL로 들어가면 같은 `(provider, source_path, source_offset)` UNIQUE 키에 걸려 재해석 결과가 반영되지 않습니다. `docs/dev/menus/session.md:342-359`에 전체 경위가 있습니다.
- **Gemini**: `service/providers/gemini/collector.mjs:295-297` — `eventKey`가 있으면 upsert, 없으면(드문 경우) insert로 폴백. 기본 경로는 Claude와 같습니다.
- **Cursor**: 미구현.

## 그룹 2 — 서버 연동

### 10~12. 서버 사용량 수집 · 한도 이력 · 대조 분류

셋을 한 번에 묶는 이유는 코드에서도 한 경로이기 때문입니다.

- **Codex만 O.** `service/providers/codex/collector.mjs:171-176`가 `event.type === 'rate_limits'`를 `store.insertRateLimits(...)`로 보냅니다(`service/store.mjs:689`, 테이블은 `server_usage_snapshots`). 대조 분류(`MATCHED_ACTIVITY`/`SERVER_ONLY_CHANGE`/`LOCAL_ONLY_ACTIVITY`/`RESET`/`UNKNOWN`)는 `service/store.mjs:774-788`의 `reconcileLatestWindow()`에 있고 `insertRateLimits()`에서만 호출됩니다. `GET /api/v1/quota/history`(`service/api-server.mjs:590-597`)는 `server_usage_snapshots`를 그대로 조회하므로, 그 테이블에 행이 없는 provider는 빈 배열을 받습니다(에러는 아님).
- **Claude/Gemini**: `capabilities.serverQuota: false`가 각 `collector.mjs`에 명시돼 있고, 파서 어디에도 `'rate_limits'` 이벤트를 만드는 코드가 없습니다(grep 0건). 대조할 서버 값 자체가 없으므로 `reconcile()`은 파일 tail 재확인만 하고 분류 로직을 타지 않습니다.
- **Cursor**: M6a(이 트랙)는 **의도적으로 Admin API를 호출하지 않습니다** — 이 셋을 만들려면 서버 인증이 필요하고, 그건 별도로 미룬 M6b의 몫입니다([cursor/decisions.md 결정 0](./cursor/decisions.md#결정-0-이-트랙은-원격-사용량을-다루지-않는다)). "못해서 X"가 아니라 "이번 트랙 범위 밖이라 X"입니다.

## 그룹 3 — 자동화·보강 경로

### 13. Lifecycle Hook 자동 설치

- **Codex**: `service/providers/codex/hooks.mjs`의 `CodexHookInstaller` — `~/.codex/hooks.json`에 `SessionStart`/`UserPromptSubmit`/`Stop`/`SessionEnd` 등록. CLI 브리지: `scripts/codex-hook.mjs`.
- **Claude**: `service/providers/claude/hooks.mjs`의 `ClaudeHookInstaller` — Claude `settings.json`에 `SessionStart`/`Stop`/`StopFailure`/`SessionEnd`/`SubagentStop` 등록. 브리지: `scripts/claude-hook.mjs`.
- **Gemini**: `capabilities.hooks: false`(`service/providers/gemini/collector.mjs:45`). 설치 파일 자체가 없습니다(`service/providers/gemini/` 디렉터리에 hooks.mjs 없음) — Gemini CLI의 hook 계약을 확인하지 못해서입니다.
- **Cursor**: 없음. `cursor-agent` CLI에 hook류 계약이 있는지도 아직 조사하지 않았습니다.

### 14. 텔레메트리(OTLP) 보강 경로

- **Claude**: `capabilities.telemetry: false`지만 **설계는 존재**합니다 — `docs/roadmap.md`: "The OTLP telemetry lane (`claude_code.token.usage`) is designed but not implemented." 그래서 X가 아니라 △. 활성화 시 `claude_code.token.usage` 메트릭을 받고 `query_source`(main/subagent/auxiliary)로 서브에이전트를 분리할 수 있다는 것까지 설계돼 있습니다.
- **Codex/Gemini**: 그런 설계 자체가 없습니다(`docs/dev/gemini/decisions.md`: "OTLP 같은 보강 레인은 없습니다").
- **Cursor**: 없음.

## 그룹 4 — 프로젝트·세션 집계

### 15. 프로젝트(cwd) 귀속

- **Codex**: `service/providers/codex/parser.mjs` — `meta.cwd ?? payload?.cwd`.
- **Claude**: `service/providers/claude/parser.mjs:206-210` — cwd 우선, 없으면 저장 디렉터리명.
- **Gemini**: `service/providers/gemini/parser.mjs:94,104-108` — cwd 있으면 사용, 없으면 `projects.json` 색인 실패 시 해시(`gemini:<12자>`)로 구분 유지(합치지 않음).
- **Cursor**: 어댑터는 없지만 신호는 실측됐습니다 — CLI `meta.json.cwd`, IDE `composerHeaders.value.workspaceIdentifier`/`trackedGitRepos`([cursor/measurements.md](./cursor/measurements.md)). 그래서 △.

### 16. 프로젝트 경로 가림(redaction)

`project_aliases` 테이블 하나로 세 provider 모두 처리합니다 — provider별 분기가
없는 엔진 공용 기능입니다(`service/store.mjs:1104-1129`, `service/api-server.mjs:104-178`).
Claude/Codex/Gemini는 이미 이 경로를 씁니다(O). Cursor는 프로젝트 화면에 아직 나타나지
않아 실질적으로 검증할 대상이 없습니다(X) — 다만 메커니즘 자체가 provider 무관이라
Cursor 어댑터가 붙으면 별도 구현 없이 바로 동작할 것으로 예상됩니다.

### 17. 토큰 기준 세션 순위

`getSessionRanking()`(`service/store.mjs:1342`)이 `usage_events`를 `total_tokens DESC`로
묶습니다 — Claude/Codex/Gemini 모두 이 원장에 행이 있어 O. Cursor는 원장에 토큰
행이 없어 정렬 기준 자체가 성립하지 않습니다(X) — [cursor/README.md 세션 흐름
절](./cursor/README.md)에서 이번 단계 제외를 명시.

### 18. 세션 흐름 화면(컨텍스트 곡선·단계 배분)

`getSessionFlow()`가 턴·곡선·단계 배분을 한 번에 냅니다. Claude·Gemini는 턴 원장이
실제로 채워져 있어(행 20) O. **Codex는 화면 자체는 동작하지만 턴 원장의 99.97%가
비어 있어(행 20) 곡선·단계 배분이 대부분 "턴 0(경계 미확인)" 버킷에 몰립니다** —
기능은 있지만 알려진 결함 때문에 실제 유용성이 떨어져 △. Cursor는 X.

## 그룹 5 — 턴 단위

### 19. 턴 경계 인식(파서 레벨)

`docs/dev/menus/session.md:52-57` 표(파서가 무엇을 턴 경계로 보는가):

| provider | 턴 경계 | 상태 |
|---|---|---|
| Claude | `type:'user'` 레코드(`toolUseResult` 없고 텍스트 블록 있음) | 구현 |
| Codex | `event_msg.payload.type === 'user_message'` | 구현 |
| Gemini | 세션 JSON의 대화 항목 경계 | 구현(아래 실측 참고) |
| Cursor | 원본에 대화 구조가 없음(구 서술) | 불가 |

이 표의 Gemini 행은 문서 원문이 "예정"이라고 적어 뒀지만, 실제 코드
(`service/providers/gemini/parser.mjs:174`가 `type:'turn'` 이벤트를 냄)와 아래 행 20의
실측 수치(턴 2,887개, 이벤트 12,317/12,319 부착)가 이미 구현·동작 중임을 보여줍니다 —
**문서가 코드보다 뒤처진 경우**라 여기서는 실측을 따라 O로 적었습니다. Cursor 행의
"불가" 사유는 이제 [cursor/decisions.md](./cursor/decisions.md)의 M6a 실측으로 갱신
대상입니다(로컬에 대화 구조 자체는 있으나 턴 경계·입출력 분리는 아직 미확인).

### 20. 턴 단위 사용량이 실제 원장에 반영됨

`docs/dev/menus/session.md:336-340`의 실측 표(개발 머신 실 원장):

| provider | `turns` 경계 | 턴에 붙은 사용량 이벤트 |
|---|---|---|
| claude | 1,082 | 15,739 / 17,275 (91%) |
| gemini | 2,887 | 12,317 / 12,319 (99.98%) |
| **codex** | **2,718** | **6 / 18,853 (0.03%)** |

Codex만 파서가 경계를 제대로 찾아내면서도(2,718개) 원장에는 거의 안 붙는 이유가
행 9의 `INSERT OR IGNORE`입니다 — "미해결"로 문서에 명시돼 있고 코드는 아직
안 건드렸습니다. 그래서 19는 O(파서는 맞음), 20은 △(적재가 안 됨)로 갈립니다.

### 21. 도구→작업단계 매핑

`service/providers/tool-phases.mjs:27-74`의 `TABLES` 객체 키를 그대로 확인:
`claude`(28-44), `codex`(45-50), `gemini`(55-70)는 실제 도구 이름이 채워진 테이블이고,
`cursor`(73)는 `Object.freeze({})` — 빈 테이블입니다(전부 `other`로 떨어짐, 필자가
직접 파일을 읽어 확인).

### 22. 턴 상세(채팅/도구/MCP/파일 분해)

`service/providers/*/turn-detail.mjs`의 `supported` 플래그:

- Claude: `supported: true`(`claude/turn-detail.mjs:23-29`).
- Codex: `supported: true`지만 `filesMeasured: false`(`codex/turn-detail.mjs:22-32`) — "파서가 경로를 안 뽑아서 파일 가지가 항상 빈다. 0개가 아니라 미측정"이라고 주석에 명시. 그래서 △.
- Gemini: `supported: false, reason: 'provider_not_implemented'`(`gemini/turn-detail.mjs:39-51`) — 파일 자체가 "아직 켜지 않은 템플릿"이라고 헤더에 적혀 있습니다.
- Cursor: `supported: false, reason: 'provider_has_no_turns'`(`cursor/turn-detail.mjs:30-37`) — 이 파일도 템플릿입니다.

## 그룹 6 — Cursor 고유 신호

### 23. 컨텍스트 구성 breakdown

전체 실측 경위·항등식·수치는 [cursor/measurements.md](./cursor/measurements.md#확인된-것-2차-조사--컨텍스트-구성-breakdown-진짜-토큰-수-필드)에
있습니다. 요약: CLI+IDE 이진 blob 1,818개에서 `5.1`(총 토큰)/`5.2`(창 크기)/
`5.3.3[]`(카테고리별 토큰) breakdown을 찾았고 카테고리 합이 1,818개 **전부**에서
총합과 정확히 일치했습니다. 다른 세 provider는 이런 "그 시점 컨텍스트 구성"
스냅샷 개념이 없습니다(요청 단위 델타만 있음) — 그래서 X이지 "못해서 X"가
아니라 "다른 종류의 값이라 해당 없음"에 더 가깝습니다. Cursor 쪽은 아직
`service/providers/cursor/*.mjs` 코드로 연결되지 않아 △입니다.
