# 상세 내역 (`detail`)

**현재 상태: 미구현 (설계).** 새 탭입니다.

## 이 화면이 답하는 질문

세션 흐름 화면의 턴 상세는 "이 턴에서 **무엇이** 토큰을 가져갔나"를 범주(채팅·도구·MCP)로 답합니다.
이 화면은 상세 내역을 **시작점**으로 뒤집습니다 — 요청·도구 호출 한 줄 한 줄을 표로 펼쳐 놓고,
두 질문에 바로 답합니다.

1. **뭐가 많았나** — 어느 요청이, 어느 도구 호출이 토큰을 가져갔나
2. **왜 많았나** — 그 요청의 프롬프트가 커진 **원인**이 무엇이었나

"왜"에 답하는 열쇠는 도구 호출과 그 **결과 크기**의 연결입니다. 도구 결과는 다음 요청의
프롬프트로 들어가므로, "요청 N이 비쌌다"의 원인은 대부분 "요청 N-1의 도구가 큰 결과를
돌려줬다"입니다. 기존 턴 상세의 호출 비율 배분(인과가 아니라 배분)으로는 이 질문에
답할 수 없어서, 이 화면은 **결과 크기라는 실측 원인**을 열로 답니다.

## 화면 미리보기

![상세 내역 와이어프레임](../assets/detail.svg)

## 데이터 근거 — 로그에 답이 있는가 (검증 완료)

설계 전에 "이 질문에 답할 데이터가 원본 로그에 있는가"를 두 경로로 확인했습니다.

**실측** (이 리포지토리를 작업한 원격 세션의 실제 Claude Code JSONL, 프라이버시 안전
프로브 — 이름·개수·크기·토큰만 측정):

- 요청 단위 usage 필드(input / cache_read / cache_creation / output / thinking) 커버리지 9/9 = 100%
- `tool_use`(id·name) ↔ `tool_result`(tool_use_id) 연결 12/12 = 100%
- 원인 상관 확인: 직전 도구 결과 17,598자였던 요청의 신규 프롬프트 10,043토큰,
  13,993자 → 7,712토큰. 결과 크기가 프롬프트 증가를 방향성 있게 설명합니다

**웹 자료** (2026-08 확인):

| 확인한 것 | 근거 |
|---|---|
| `usage` 필드 이름 4종 + `tool_use`/`tool_result` 스키마 | Anthropic Messages API 공식 문서 |
| `output_tokens_details.thinking_tokens` | Extended thinking 공식 문서 |
| 도구 결과 **본문이 로그에 저장됨** — 레코드당 두 곳: `.toolUseResult`(원본 출력)와 `.message.content[].content`(모델에 되먹인 tool_result 블록) | agentfluent#72 유출 분석, LLMnesia, samkeen gist |
| Codex 도 동형: `function_call` ↔ `function_call_output` 이 `call_id` 로 연결, `token_count` 이벤트 | Codex rollout 역공학 글, openai/codex#19022·#24948 |
| JSONL 토큰 신뢰성 경고(입력 플레이스홀더, thinking 누락) | anthropics/claude-code#28197·#27361 — **기존 파서의 버전 게이트(2.1.143 / 2.1.228)와 정확히 대응**, 새 열 없이 `measurementQuality` 로 이미 커버 |

결론: 두 질문 모두 로그에 근거가 있습니다. 없는 것은 파서가 아직 결과 크기를 **안 뽑는 것**뿐입니다.

## 설계 원칙: 크기는 재고 본문은 안 읽는다

[session.md의 경계 표](./session.md#설계-원칙-본문-없이-절차를-본다)에 한 줄이 늘어납니다.

| 읽는 것 (구조) | 읽지 않는 것 (본문) |
|---|---|
| 도구 결과의 **크기(문자수)와 tool_use_id 연결** | 도구 결과의 내용 |

크기는 내용이 아니라 내용의 **길이**입니다. 그래도 파서가 처음으로 `tool_result` 블록에
닿게 되므로, 이 경계는 문서만이 아니라 테스트로 못박습니다 — 기존 센티넬 검사를 확장해
**센티넬 문자열이 파서 이벤트·목록 응답·SQLite 바이트 어디에도 나타나지 않음**을
검사합니다(길이는 나타나도 됩니다). 본문을 실제로 보는 길은 하나뿐이고 파서를 거치지
않습니다 — 아래 [내용 보기](#내용-보기-명시적-열람만-저장은-없음) 절.

측정 대상은 두 저장 위치 중 `message.content[].content`(tool_result 블록) 쪽입니다.
큰 출력은 CLI 가 잘라서 프리뷰만 모델에 넣는 경우가 있어(원본은 별도 파일로 빠짐),
**모델에 실제로 들어간 쪽**을 재야 프롬프트 증가와 맞아떨어집니다. `.toolUseResult` 는
원본 크기라서 재지 않습니다 — 두 값이 다를 때 어느 쪽이 컨텍스트를 키웠는지를 물으면
답은 항상 tool_result 블록입니다.

크기 단위는 **문자수**로 표기하고 토큰으로 환산하지 않습니다. 환산 계수는 모델·언어마다
다르고, 임의 계수를 곱해 정밀해 보이게 하지 않는다는 규칙(재독 배수·비용과 같은 원칙)을
그대로 따릅니다. 화면은 "직전 결과 17.6K자 → 신규 프롬프트 10.0K토큰"처럼 **둘 다
실측값으로** 나란히 보여줍니다.

## 내용 보기: 명시적 열람만, 저장은 없음

크기만으로는 "왜 컸나"까지 갑니다. 그 다음 "그래서 **뭘** 읽었길래"를 분석하려면 실제
내용이 필요할 때가 있습니다. 그래서 각 도구 호출 행에 **[내용 보기]** 버튼을 둡니다 —
누르면 그 호출 하나의 `tool_use.input` 과 `tool_result` 본문을 원본에서 그 자리에서
읽어 **팝업(모달)** 으로 띄웁니다.

이것은 위 경계 표를 **문단 하나만큼 여는** 결정이므로, 여는 조건을 못박습니다.

| 조건 | 규칙 |
|---|---|
| 기본은 닫힘 | 목록(records)·집계 응답에는 결과 데이터(본문·프리뷰)가 **포함되지 않습니다**. 센티넬 검사가 그대로 지킵니다 |
| 클릭 시에만 | 본문 요청은 [내용 보기] 클릭이 팝업을 열 때만 발생합니다 — 목록을 그리면서 미리 불러오지 않습니다. 팝업을 닫으면 본문은 화면 상태에서도 버립니다(재열람은 재요청) |
| 전용 통로 | 본문은 별도 엔드포인트가 나르고, 요청한 **tool_use_id 하나**의 input·결과만 담습니다 |
| 저장 없음 | 어디에도 저장하지 않습니다 — SQLite·캐시·서버 로그 모두. 응답은 `Cache-Control: no-store` |
| 가림 존중 | 경로 가림된 프로젝트에서는 버튼이 비활성이고 엔드포인트도 사유와 함께 거부합니다 |
| 원본 없으면 없음 | 원본이 지워졌으면 "원본 없음" — 원장에서 지어내지 않습니다 |
| 위험 고지 | 유출 사례가 보여주듯 도구 출력에는 자격증명이 남을 수 있습니다. 뷰어 상단에 그 경고를 상시 표기합니다 |

성격은 기존 privacy-safe local log inspector 와 같습니다 — 로그 소유자가 자기 로컬
로그를 자기 화면에서 열람하는 것이고, 트래커가 본문을 **가공·요약·색인**하는 것이
아닙니다. 파서도 이 경로를 타지 않습니다: 뷰어는 원본 파일의 해당 레코드를 직접 읽는
별도 리더를 쓰고, 파서가 내보내는 이벤트에는 여전히 본문이 없습니다.

## 핵심 개념: 원인(cause) 열

```text
요청 N-1:  assistant 가 Read 호출 (tool_use id=A)
           user 레코드에 tool_result(tool_use_id=A, 17,598자)   ← 크기만 잰다
요청 N:    usage { input+cacheWrite = 10,043 }                  ← 이 증가의 원인이 위 줄
```

- 요청 행의 **원인** = 직전 요청 이후 들어온 tool_result 크기의 합과 그 도구 이름들
- 첫 요청의 원인은 도구가 아니라 시스템 프롬프트+사람 프롬프트입니다 — "(첫 요청)"으로 표기
- 한 원인 구간에 도구가 여럿이면 도구별 크기를 **각각** 보여줍니다. tool_use_id 연결이
  있으므로 턴 상세의 `(혼합)` 같은 뭉개기가 필요 없습니다 — 로그가 말해 주는 것은 나눕니다
- 원인은 프롬프트 증가의 **전부가 아닙니다**(어시스턴트 자신의 직전 출력, 시스템 주입도
  프롬프트에 들어갑니다). 화면은 원인 막대를 신규 프롬프트 대비 비율로 그리되 "도구 결과가
  설명하는 몫"이라고 적고, 나머지를 도구 탓으로 지어내지 않습니다

## 화면 요소

| 영역 | 내용 |
|---|---|
| 최근 프로젝트 | **최근 작업 순, 최대 5개** 칩. 첫 칩이 기본 선택. 경로 가림 규칙은 프로젝트 화면과 동일 |
| 세션 선택 | 선택 프로젝트의 최근 세션 목록(최근 순). 세션 흐름 화면과 같은 `getSessionRanking` 을 프로젝트 필터로 좁혀 씁니다 |
| 요약 줄 | 선택 세션의 총 토큰 · 요청 수 · 도구 호출 수 · 도구 결과 크기 합 · 최대 원인 도구 · 측정 품질 |
| 내역 표 | 요청 단위 행: 시각 · 턴 · 도구(호출 수) · **결과 크기** · 신규 프롬프트(input+cacheWrite) · 캐시 읽기 · 출력 · **원인 막대** |
| 행 수 | **20 / 50 / 100 / 1000, 기본 100.** 서버 recordLimit 과 화면 표시가 같은 값을 씁니다 |
| 정렬 | 기본 시각순. 신규 프롬프트·결과 크기·출력으로 정렬 가능 — `src/table-sort.js` 재사용 |
| 내용 보기 | 도구 호출이 있는 행의 **[보기]** 버튼. 클릭 시에만 전용 엔드포인트를 불러 그 호출의 input·결과 본문을 **팝업(모달)** 에 표시 — 목록 응답에는 본문이 없습니다 ([내용 보기 절](#내용-보기-명시적-열람만-저장은-없음)의 조건대로) |
| 이동 | 행의 턴 번호를 누르면 세션 흐름 화면의 그 턴 상세로 (기존 `focus` 인자 방식, URL 없이) |

행이 상한을 넘으면 "N행 / 전체 M행"으로 잘렸음을 표기합니다 — 조용히 자르지 않습니다.

## 파서 확장 (v3)

턴 상세와 같은 원칙입니다 — 해석은 파서 한 곳, 화면과 API 는 파서가 내보내는 구조
메타데이터만 씁니다.

```text
CLAUDE_PARSER_VERSION = 3

파서 상태에 추가:
  pendingToolUses: Map<tool_use_id, toolName>   // assistant 의 tool_use 블록에서
  pendingResults:  [{ tool, chars }]            // user 레코드의 tool_result 에서 크기만

usage 이벤트에 추가:
  causeResults: [{ tool, chars }]   // 직전 usage 이후 쌓인 결과들 — 이 요청 프롬프트의 원인
  causeChars:   number              // 합계
```

- `tool_result` 에서 읽는 것은 `tool_use_id` 와 `content` 의 **길이**뿐입니다. 문자열이면
  `.length`, 블록 배열이면 직렬화 길이 — 값은 버리고 길이만 남깁니다
- 서브에이전트 transcript 도 같은 규칙으로 동작합니다(파일 안에서 연결이 닫히므로).
  단 부모 턴 귀속은 기존과 같이 0번 버킷입니다
- v2 로 읽은 파일의 재해석은 기존 `parser_version` 재스캔 규칙을 그대로 탑니다.
  단, 이 화면은 원장을 거치지 않으므로(아래) 재해석 없이도 동작합니다

Codex 는 `function_call_output.call_id` 로 같은 구조가 가능함을 웹 자료로 확인했지만
**실물 로그로 검증하지 못했습니다**(개발 머신에만 있음). Claude 를 먼저 붙이고, Codex 는
실측 검증 전까지 `supported: false, reason: 'unverified'` 로 시작합니다 — 픽스처만 믿고
켜지 않습니다. Gemini·Cursor 는 턴 상세와 같은 이유로 미지원입니다.

## 원장이 아니라 원본을 다시 읽습니다

턴 상세와 같은 결정, 같은 대가입니다([session.md](./session.md#원장이-아니라-원본을-다시-읽습니다)).
결과 크기를 원장에 넣기 시작하면 요청당 도구별 크기 배열이 들어가야 하고, 그건 원장이
로그의 사본이 되는 길입니다. 요청이 올 때 그 세션의 원본 파일들을 처음부터 읽어 응답만
만들고 저장하지 않습니다.

턴 상세와 다른 점 하나: 턴 필터 없이 **세션 전체**를 모읍니다. 읽는 파일 셋과 스캔
비용은 턴 상세와 같고(어차피 처음부터 읽습니다), 모으는 행 수만 다릅니다. 행 상한은
요청 파라미터(20/50/100/1000)이고 서버 상한은 1000입니다.

## 필요한 API

```text
GET /api/v1/projects/recent?limit=5
    → { projects: [{ projectKey, projectName, lastEventAt, tokens, provider }] }
    -- 대시보드 recents(최근 순 정렬, M9)와 같은 쿼리를 limit 만 좁혀 씁니다

GET /api/v1/sessions/:sessionId/records?provider&limit=100
    → { session, supported, available, reason,
        totals: { totalTokens, promptTokens, outputTokens, requestCount,
                  toolCalls, resultChars },
        records: [{ seq, at, turnIndex, category, model, sidechain,
                    measurementQuality,
                    tokens: { inputTokens, cachedInputTokens, cacheWriteInputTokens,
                              outputTokens, reasoningTokens, promptTokens },
                    tools, paths,
                    toolCalls: [{ id, tool }],          -- 내용 보기용 tool_use_id. 본문 없음
                    causeResults: [{ tool, chars }], causeChars }],
        recordCount, truncated,
        source: { files: [{ path, exists, lines, bytes }], missing } }

GET /api/v1/sessions/:sessionId/tool-calls/:toolUseId/content?provider
    → { supported, available, reason,
        tool, at, turnIndex,
        input:  { chars, content },                     -- tool_use.input
        result: { chars, content },                     -- tool_result 블록 (모델에 들어간 쪽)
        source: { path, line } }
    -- 본문이 나가는 유일한 통로. [내용 보기] 클릭이 팝업을 열 때만 호출되고,
    -- records 응답에는 결과 데이터가 포함되지 않습니다.
    -- Cache-Control: no-store, 저장 없음,
    -- 가림 프로젝트는 available: false, reason: 'redacted'
```

`limit` 은 20·50·100·1000 만 받고 그 외는 100으로 접습니다. 가림된 프로젝트에서는
경로 문자열이 응답에 나가지 않는 규칙(턴 상세와 동일)을 그대로 적용합니다.

## 필요한 스토어 쿼리

새 테이블·새 컬럼 없음. 쓰는 것은 둘 다 기존입니다.

```js
getRecentProjects({ limit: 5 })        // 대시보드 recents 재사용
getSessionSources({ provider, sessionId })  // 턴 상세가 쓰는 원본 파일 목록 그대로
```

## 완료 기준

`test/session-records.test.mjs` 로 검사합니다.

- [ ] 요청 행의 `causeChars` 가 그 요청 직전 tool_result 크기 합과 일치 (픽스처)
- [ ] `tool_use_id` 로 도구별 크기가 갈리고, 여러 도구가 섞여도 `(혼합)` 없이 각각 나옴
- [ ] resume 사본이 있어도 행과 합계가 부풀지 않음 (eventKey 중복 제거 승계)
- [ ] 행 상한 20/50/100/1000 이 서버·화면에서 같은 값이고, 넘치면 `truncated` 와 전체 행 수 표기
- [ ] 응답과 SQLite 바이트에 센티넬(도구 결과 본문) 부재 — 길이만 존재
- [ ] 원본이 없으면 `available: false, reason: source_missing` — 지어내지 않음
- [ ] 최근 프로젝트가 최근 작업 순 최대 5개, 가림 규칙 적용
- [ ] 첫 요청 행의 원인이 "(첫 요청)"으로 표기되고 도구 탓으로 배분되지 않음
- [ ] Codex/Gemini/Cursor 는 빈 상세가 아니라 `supported: false` 와 이유
- [ ] 행의 턴 번호 클릭 시 세션 흐름 화면의 해당 턴이 열림 (focus 인자)
- [ ] content 엔드포인트가 요청한 `tool_use_id` **하나**의 input·결과만 담고, records 응답에는 본문 센티넬 부재가 유지됨
- [ ] content 요청이 [내용 보기] 클릭(팝업 열기)에서만 발생 — 목록 렌더링이 본문을 선요청하지 않음
- [ ] 팝업을 닫으면 본문이 화면 상태에서 버려지고, 다시 열면 재요청됨
- [ ] 내용 보기를 호출한 **뒤에도** SQLite 바이트에 센티넬 부재 — 열람이 저장을 만들지 않음
- [ ] content 응답에 `Cache-Control: no-store` 가 붙음
- [ ] 가림 프로젝트에서 content 가 `reason: 'redacted'` 로 거부되고 버튼이 비활성

## 하지 않는 것

- 도구 결과 본문을 **저장하거나 목록·집계 응답에 싣기** — 본문은 [내용 보기] 전용 엔드포인트가 요청 시 원본에서 그 호출 하나만 나르고, 어디에도 저장하지 않습니다
- 본문을 요약·색인·검색 대상으로 만들기 — 열람은 표시로 끝나고 파생물을 만들지 않습니다
- 문자수를 토큰으로 환산하기 — 실측 두 값(자 / 토큰)을 나란히 둡니다
- 결과 크기를 원장에 저장하기 — 요청 때 원본을 읽어 응답만 만듭니다
- 원인으로 설명 안 되는 프롬프트 증가분을 도구에 배분하기 — 설명되는 몫만 막대로 긋습니다
- 검증 안 된 provider 를 픽스처만으로 켜기 — Codex 는 실물 로그 검증 후에 켭니다
