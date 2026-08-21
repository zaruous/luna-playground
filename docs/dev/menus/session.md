# 세션 흐름 (`session`)

**현재 상태: 구현됨(M8).** 새 탭입니다.

## 이 화면이 답하는 질문

기존 화면들은 **얼마나 썼나**를 답합니다. 이 화면은 **어떤 절차로 얼마를 썼나**를 답합니다.

실제 계기가 된 관찰입니다. 로컬 코퍼스에서 토큰 1위 세션은 4.74억 토큰을 썼는데, 그 내역이 이랬습니다.

```
캐시 읽기  470,700,343   (99.4%)
출력           773,304
비캐시 입력     15,012
```

"많이 썼다"의 실체는 **새로 만든 양이 아니라 같은 컨텍스트를 1,113번 다시 읽은 것**이었습니다. 그런데 기존 화면 어디에서도 그 사실이 보이지 않았습니다. 총 토큰만 크게 표시되니까요.

## 설계 원칙: 본문 없이 절차를 본다

대화 본문은 저장하지 않는다는 규칙([claude-code-adapter.md §17](../../claude-code-adapter.md))을 그대로 지킵니다. 그런데도 절차를 볼 수 있는 이유는 **구조 메타데이터와 본문이 분리 가능**하기 때문입니다.

| 읽는 것 (구조) | 읽지 않는 것 (본문) |
|---|---|
| 사람 프롬프트의 **존재와 시각** | 프롬프트 텍스트 |
| 도구 호출의 **이름** (`Bash`, `apply_patch`) | 도구 **입력**(`input.command`) |
| 도구 호출 **횟수** | 도구 출력 payload |
| 만진 **파일 경로** | 파일 내용, Read 결과 |
| 컴팩션이 **일어난 시각** | 컴팩션 요약문 |

이 경계는 기존 프라이버시 테스트가 그대로 검사합니다 — 센티넬 문자열은 `content`/`input`에만 들어가므로, 위 왼쪽 열만 읽으면 SQLite 바이트에 나타나지 않습니다.

## 핵심 개념: 턴(turn)

원장은 **요청(request)** 단위입니다. 그 위에 **턴**을 한 겹 얹습니다.

```text
사람 프롬프트 1개  ──┐
  요청 1              │
  요청 2              │  = 턴 1
  ...                 │
  요청 88            ─┘
다음 사람 프롬프트  ──> 턴 2 시작
```

턴이 있어야 "**프롬프트 한 번에 얼마**"가 나옵니다. 실측 예: 75개 턴 중 50번 턴 하나가 73.9M(세션의 15.8%)을 썼고, 요청 88개가 그 한 프롬프트에서 파생됐습니다.

### provider별 턴 경계

턴은 provider 중립 개념이고, **경계를 무엇으로 잡을지는 어댑터가 정합니다.**

| provider | 턴 경계 | 도구 이름 위치 | 컴팩션 마커 | 상태 |
|---|---|---|---|---|
| Claude | `type:'user'` 레코드 (`toolUseResult` 없고 텍스트 블록 있음) | `message.content[].tool_use.name` | `type:'system'`, `subtype:'compact_boundary'` | 구현 |
| Codex | `event_msg.payload.type === 'user_message'` | `response_item.payload.name` (`function_call`/`custom_tool_call`/`local_shell_call`) | `event_msg.payload.type === 'context_compacted'` | 구현 |
| Gemini | 세션 JSON의 대화 항목 경계 — **M5에서 확인 필요** | 미확인 | 미확인 | 예정 |
| Cursor | Admin API는 이벤트 단위 집계만 주고 대화 구조가 없음 | 없음 | 없음 | **불가** |

Cursor에 턴이 없는 것은 결함이 아니라 **원본에 정보가 없다는 사실**입니다. `capabilities.turnLedger = false`로 선언하고, 이 화면에서는 "요청 기반 provider — 턴 정보 미제공"으로 표기합니다.

### 도구 → 단계 매핑

도구 어휘가 provider마다 다릅니다. Claude는 `Bash`/`Edit`/`Read`, Codex는 `shell_command`/`apply_patch`/`exec`. 그래서 **정규 단계 이름은 공용, 매핑표는 어댑터별**입니다.

```js
// 정규 단계 — 이 6개만 씁니다. 늘리면 화면과 비교가 깨집니다.
'explore' | 'implement' | 'verify' | 'plan' | 'clarify' | 'delegate'
// 매핑되지 않는 도구는 'other', 도구를 안 쓴 턴은 'no-tool'
```

| 단계 | 뜻 | Claude | Codex |
|---|---|---|---|
| `explore` | 읽고 찾는다 | `Read` `Grep` `Glob` `WebFetch` | `tool_search_call` |
| `implement` | 파일을 고친다 | `Edit` `Write` `NotebookEdit` | `apply_patch` |
| `verify` | 실행해 확인한다 | `Bash` `PowerShell` | `shell_command` `exec` `run` `js` |
| `plan` | 작업을 쪼갠다 | `TaskCreate` `TaskUpdate` | — |
| `clarify` | 사람에게 묻는다 | `AskUserQuestion` | — |
| `delegate` | 서브에이전트에 넘긴다 | `Agent` `Task` | `multi_agent` 계열 |

한 턴에 여러 단계가 섞이면 **도구 호출 비율로 턴 토큰을 나눠 귀속**합니다. 이건 인과가 아니라 배분이므로 화면에 "추정 배분"으로 표기합니다.

## 화면 요소

```text
┌ 세션 흐름 ───────────────────────────────── [기간] [provider] ─┐
│ ┌ 요약 4칸 ────────────────────────────────────────────────┐ │
│ │ 관측 세션  │ 최고 재독 배수 │ 가장 비싼 턴 │ 우세 단계      │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ 세션 순위 표 ────────────────────────────────────────────┐ │
│ │ 프로젝트  총토큰  요청  턴  재독배수  우세단계  [프로젝트→] │ │
│ │ …클릭하면 아래 상세가 바뀜                                  │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌ 컨텍스트 곡선 ──────────┐ ┌ 단계별 배분 ─────────────────┐ │
│ │ 요청별 프롬프트 크기     │ │ verify 45% ▇▇▇▇▇▇▇▇         │ │
│ │ 컴팩션 지점 표시         │ │ implement 24% ▇▇▇▇          │ │
│ └─────────────────────────┘ └─────────────────────────────┘ │
│ ┌ 비싼 턴 목록 ────────────────────────────────────────────┐ │
│ │ 턴50  08:53  73.9M  88요청  implement  Edit32 Read28     │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

| 영역 | 내용 |
|---|---|
| 요약 4칸 | 관측 세션 수 / 최고 재독 배수 / 가장 비싼 턴 / 토큰이 가장 많이 간 단계 |
| 세션 순위 | 총 토큰 순. 요청·턴 수, 재독 배수, 우세 단계, **프로젝트 탭으로 가는 링크** |
| 컨텍스트 곡선 | 선택 세션의 요청별 프롬프트 크기(`input + cacheRead + cacheWrite`). 컴팩션 지점을 세로선으로 |
| 단계별 배분 | 선택 세션의 단계별 토큰 비중 (추정 배분임을 명시) |
| 비싼 턴 | 상위 N개 턴: 순번, 시각, 토큰, 요청 수, 우세 단계, 도구 상위 4개 |
| 원본 포인터 | 선택 세션의 메인 transcript 경로. **경로만 표시하고 내용은 열지 않음** |

## 파생 지표 정의

화면에 숫자를 띄우기 전에 정의를 못박아 둡니다. 정의가 흔들리면 세션 간 비교가 무의미해집니다.

```text
프롬프트 토큰   = 캐시가 input 밖인 회계(Claude):  input + cacheRead + cacheWrite
                  캐시가 input 안인 회계(Codex):   input + cacheWrite
                  (그 요청이 모델에 밀어 넣은 총량 ≈ 그 시점 컨텍스트 점유량)

재독 배수       = cachedInputTokens / (inputTokens + outputTokens)
                  "새로 만든 1토큰당 몇 토큰을 다시 읽었나". 클수록 긴 대화를 오래 끈 것

요청당 프롬프트 = 프롬프트 토큰 합 / 요청 수
                  컨텍스트 평균 점유량

턴 토큰         = 그 턴에 속한 요청들의 (프롬프트 토큰 + 출력)
```

**재독 배수는 나쁜 것이 아닙니다.** 캐시 읽기는 단가가 낮아서, 배수가 높다는 것은 "캐시가 잘 듣고 있다"는 뜻일 수도 있습니다. 이 화면은 배수를 **비용 구조의 성격**으로 제시하고 좋다/나쁘다를 판정하지 않습니다. 실제 금액 환산은 M7 비용 마일스톤에서 모델별 단가표가 붙은 뒤에만 합니다 — 지금 임의 계수를 곱해 "비용"이라 부르지 않습니다.

## 프로젝트 탭과의 교차 이동

양방향입니다.

```text
세션 흐름 ──[프로젝트 보기]──> 프로젝트 탭 (해당 프로젝트가 선택된 상태로 열림)
세션 흐름 <──[세션 흐름 보기]── 프로젝트 탭 (해당 프로젝트로 필터된 상태로 열림)
```

구현은 `App`이 소유한 `activeNav`에 **포커스 인자**를 함께 넘기는 방식입니다. URL을 쓰지 않는 이유는 프로젝트 경로가 브라우저 히스토리에 남는 것을 피해야 하기 때문입니다([project.md](./project.md)의 같은 이유로 `projectKey`는 해시입니다).

```js
// App.jsx
const [nav, setNav] = useState({ view: 'dashboard', focus: null });
// focus = { projectKey } 또는 { sessionId, provider }
```

## 필요한 API

```text
GET /api/v1/sessions?provider&since&until&limit
    → { sessions: [{ provider, sessionId, projectKey, projectName, model,
                      tokens, requestCount, turnCount, reuseMultiple,
                      peakPromptTokens, dominantPhase, firstAt, lastAt }] }

GET /api/v1/sessions/:sessionId/flow?provider
    → { session, turns: [{ turnIndex, startedAt, endedAt, requestCount,
                            promptTokens, outputTokens, toolCounts, phase,
                            compacted }],
        phases: [{ phase, tokens, share }],
        curve:  [{ requestIndex, at, promptTokens, outputTokens, compacted }],
        source: { mainSourcePath, transcriptCount } }
```

`sessionId`는 provider가 만든 UUID이므로 URL에 넣어도 경로가 새지 않습니다. 다만 `projectName`은 응답 본문에만 담고, 가림(`redacted`) 규칙을 프로젝트 화면과 동일하게 적용합니다.

## 필요한 스토어 쿼리

```js
getSessionRanking({ provider, since, until, limit })
getSessionFlow({ provider, sessionId })     // 턴 + 단계 + 곡선 한 번에
```

스키마는 [store-extensions.md §10](../store-extensions.md)에 있습니다. 설계 중에 한 번 뒤집혔으니 그 이유를 남겨 둡니다.

**처음 안**은 `turns` 테이블에 턴별 토큰 합계를 넣고 `session_activity`에 세션 롤업을 넣는 것이었습니다. **버렸습니다.** 두 곳에서 깨집니다.

- 증분 tail이 턴 중간을 가르면 두 번에 걸쳐 부분 합계가 들어와 누적해야 하는데, 절단 후 전체 재스캔에서 그 누적이 두 배가 됩니다
- 세션을 resume하면 같은 턴이 다른 파일에서 다시 관측되어 또 두 배가 됩니다

**채택한 안**은 요청 행에 턴 번호를 달고 집계를 SQL로 뽑는 것입니다.

```sql
usage_events.turn_index     -- 이 요청이 속한 턴 (NULL/0 = 경계 미확인)
usage_events.tool_counts    -- 이 요청이 부른 도구 이름 JSON {"Bash":2}
usage_events.touched_paths  -- 건드린 경로 접미 JSON {"docs/a.md":1}

turns(provider, session_id, turn_index, started_at, compacted, parser_version)
  -- 경계 사실만. 토큰은 없음
```

`usage_events`는 이미 `event_key`로 중복 제거되므로, 거기서 파생한 턴 집계는 **멱등성을 공짜로 물려받습니다.** "턴 토큰 합 == 세션 토큰 합"이 계산으로 보장되는 것도 이 구조 덕분입니다.

`session_activity` 테이블은 만들지 않았습니다. 메인 transcript 경로, transcript 수, 재독 배수, 컨텍스트 최고점, 도구·파일 카운트가 전부 `usage_events`에서 유도되기 때문입니다 — 이중 원장은 정합성 위험만 늘립니다([store-extensions.md §8](../store-extensions.md)의 같은 판단).

### 프롬프트 토큰은 회계별로 다르게 더한다

`프롬프트 토큰 = input + cacheRead + cacheWrite` 는 **캐시가 input 밖에 있는 회계에서만** 맞습니다. Codex는 `cached ⊆ input`이라 그대로 더하면 캐시 읽기를 두 번 셉니다. 그래서 회계 표를 `service/providers/accounting.mjs` 한 곳에 두고 어댑터 capabilities·엔진 집계·스토어 쿼리가 모두 그것을 봅니다. 이 값이 두 곳에 흩어져 있던 동안 캐시 적중률이 Claude에서 수천 %로 나왔습니다.

## 재계산 규칙

턴 원장은 **파생 데이터**입니다. 원장(`usage_events`)이 진실이고 `turns`는 그것을 묶은 것이므로:

- 같은 파일을 재스캔해도 턴 수와 턴 토큰이 늘지 않아야 합니다(멱등)
- 파서가 바뀌면 `parser_version`으로 재계산 대상을 고를 수 있어야 합니다
- 턴 원장이 비어 있어도 기존 화면은 전부 동작해야 합니다 — 이 테이블은 부가 계층입니다

턴 경계를 못 찾은 구간은 **턴 0번(`turn_index = 0`)에 모읍니다.** 0번은 "경계 미확인" 버킷이고, 화면에서 그렇게 표기합니다 — 억지로 1번 턴에 붙이지 않습니다. 실제로 0번에 들어가는 것은 두 종류입니다.

- 파일 tail이 중간부터 시작해 앞선 경계를 보지 못한 구간
- **서브에이전트 transcript의 요청** — 부모와 `sessionId`가 같지만 어느 부모 턴에서 시작됐는지 그 파일만 봐서는 알 수 없습니다. 스캔 순서로 아무 턴에 붙이면 거짓이 되므로 0번에 둡니다. 부모 턴 연결은 `agentId` 대조가 필요한 후속 과제입니다.

### 파서 버전업 시 재해석

턴 계층은 파서 v2에서 생겼습니다. v1으로 이미 읽은 파일은 offset이 파일 끝에 있어 그냥 두면 **턴 정보가 영원히 비어 있습니다.** 그래서 `provider_scan_state.parser_version`을 보고 이전 버전으로 읽은 파일은 한 번 처음부터 다시 해석합니다. 중복 제거가 있어 재해석이 합계를 늘리지는 않습니다.

이때 upsert의 역행 방지 가드가 걸림돌이 됩니다 — 같은 토큰 값이면 "낡은 관측"으로 보고 쓰기를 생략하던 규칙 때문에 새로 붙는 턴 번호가 저장되지 않았습니다. 그래서 가드를 **"더 작으면 무시, 같으면 통과"** 로 좁혔습니다. resume 사본(0으로 남은 복사본)은 여전히 걸러지고, 재해석은 메타를 채울 수 있습니다.

## 완료 기준

전부 `test/session-flow.test.mjs` 로 검사합니다.

- [x] 세션 순위가 총 토큰 순으로 나오고 파생 지표가 정의대로 계산됨
- [x] 같은 파일을 두 번·세 번 스캔해도 턴 수·턴 토큰이 늘지 않음
- [x] 턴 토큰 합계가 세션 토큰 합계와 일치(경계 미확인 버킷 포함)
- [x] 증분 tail이 턴 중간을 갈라도 번호가 되감기지 않고 요청이 원래 턴에 붙음
- [x] 도구 **이름**은 저장되고 도구 **입력**·프롬프트·응답은 SQLite 바이트에 없음
- [x] 컴팩션 지점이 곡선에 표시되고, 그 직후 프롬프트 크기가 실제로 떨어짐
- [x] 서브에이전트 요청이 부모 턴에 억지로 붙지 않고 0번 버킷에 남음
- [x] `turns`가 비어 있어도 기존 집계가 그대로 동작 (턴 0 / 미확인으로 표시)
- [x] 파서 버전업 시 이전 버전으로 읽은 파일을 한 번 재해석하고, 합계는 안 늘어남
- [x] 도구→단계 매핑이 provider별이고 모르는 도구는 `other` 로 떨어짐
- [x] 세션 → 프로젝트 이동 시 해당 프로젝트가 선택된 상태로 열림
- [x] 프로젝트 → 세션 흐름 이동 시 그 프로젝트로 필터된 상태로 열림
- [ ] Cursor처럼 턴이 불가한 provider는 "미제공"으로 표기 (M6에서 확인)

### 실제 원장에서는 Codex 만 비어 있습니다 — 미해결

위 단정은 전부 픽스처에서 참입니다. 그런데 개발 머신의 실제 원장을 재 보니
**Codex 만** 턴이 안 붙어 있습니다.

| provider | `turns` 경계 | 턴에 붙은 사용량 이벤트 |
|---|---|---|
| claude | 1,082 | 15,739 / 17,275 |
| gemini | 2,887 | 12,317 / 12,319 |
| **codex** | **2,718** | **6 / 18,853** |

경계는 2,718개가 제대로 들어와 있으니 파서는 맞습니다. 못 붙는 곳은 **적재**
입니다. Codex 만 `insertUsageEvent`(= `INSERT OR IGNORE`)를 쓰고 Claude·Gemini 는
`upsertUsageEvent` 를 씁니다. 그래서:

1. `turn_index` 가 NULL 인 행이 있으면 `hasUnattributedTurns` 가 참이 되어 그
   파일을 offset 0 부터 다시 읽습니다 — 설계대로입니다.
2. 그런데 다시 읽어 넣으려는 행은 `UNIQUE(provider, source_path, source_offset)`
   에 이미 있으므로 **IGNORE 됩니다.** 기존 행의 `turn_index` 는 갱신되지 않습니다.
3. 다음 기동에서 1번이 또 참입니다. **수리되지 않는 재해석이 매번 반복됩니다** —
   실측 Codex 파일 678개 / 785.2 MB 를 기동마다 전량 다시 읽고 파싱합니다.

`insertUsageEvent` 의 INSERT 컬럼 목록에 `turn_index` 는 들어 있으므로 **새로**
들어오는 행은 정상입니다. 못 고쳐지는 것은 그 컬럼이 생기기 전에 적재된 과거
행이고, 그것이 Codex 원장의 99.97% 입니다.

같은 원인으로 `field_quality` · `parser_version` · `request_id` 도 Codex 행
18,853개 전부 NULL 입니다 — 이 셋은 `insertUsageEvent` 의 컬럼 목록에 아예
없습니다(`upsertUsageEvent` 에는 있습니다).

고치는 방향은 Codex 도 `upsertUsageEvent` 를 쓰게 하는 것입니다. 다만 이 경로는
누적 diff 회계를 다루므로 "같은 행을 다시 써도 합계가 안 늘어난다"를 먼저
못박아야 합니다 — Claude·Gemini 는 요청 단위 값이라 last-wins 가 안전했지만
 Codex 는 증분입니다. 그래서 이 문서에 **미해결로 남기고** 코드는 건드리지
않았습니다.

## 하지 않는 것

- 프롬프트·응답·도구 입출력 저장 (§17)
- 대화 요약을 만들어 DB에 넣기 — 원본이 있으면 언제든 읽을 수 있고, 사본을 만들면 DB가 대화 아카이브가 됩니다
- 임의 계수로 "비용"을 계산해 표시하기 — 단가표는 M7
- 재독 배수로 좋다/나쁘다 판정하기
- 턴 경계를 추측으로 보간하기 — 못 찾으면 0번 버킷
