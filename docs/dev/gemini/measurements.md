# Gemini 실측

이 문서의 숫자는 **개발 머신의 실제 코퍼스 전수**입니다. 파서를 쓰기 전에 재고,
그 결과로 설계를 바꿨습니다. 예측과 어긋난 지점은 어긋났다는 사실까지 남겨
둡니다 — 다음에 읽는 사람이 같은 예측을 다시 하지 않도록.

## 코퍼스 규모

| 포맷 | 파일 | 레코드 | 토큰이 실린 것 |
|---|---|---|---|
| `.json` | 419 | 메시지 15,139 | 11,796 |
| `.jsonl` | 386 | 줄 6,983 | 1,519 |
| 합 | 805 | — | 13,315 |

`.jsonl` 386개는 **처음 조사에서 통째로 빠져 있었습니다.** `endsWith('.json')` 이
`.jsonl` 을 잡지 않기 때문입니다. 계획서(§5.4)에 `*.jsonl` 이 적혀 있었는데도
놓쳤고, 파일 수를 세는 스크립트가 같은 실수를 하고 있어서 드러나지 않았습니다.

메시지 `type` 분포(`.json`): `user` 2,724 · `gemini` 11,813 · `info` 532 · `error` 70.
`.jsonl` 은 여기에 헤더 줄(`main` 2,050)과 `$set` 줄(3,063)이 더 있습니다.

## 토큰 항등식 — 전수 성립

```
input + output + thoughts === total
cached <= input
```

| 판정 | `.json` | `.jsonl` |
|---|---|---|
| `input+output == total` (thoughts=0) | 3,246 (27.52%) | 663 |
| `input+output+thoughts == total` | 8,550 (72.48%) | 856 |
| `input+output+thoughts+tool == total` | 0 | 0 |
| **어느 것도 아님** | **0** | **0** |

`cached > input`: **0건**. `tool > 0`: **0건**. 여섯 토큰 필드
(`input`/`output`/`cached`/`thoughts`/`tool`/`total`)는 **누락 0건**으로 항상
채워져 옵니다. `id`/`timestamp`/`model` 도 누락 0건입니다.

## 계획서 예측과 어긋난 두 가지

### 1. `thoughts` 가 `output` **밖**에 있습니다

Codex·Claude 는 `output ⊇ reasoning` 이라, 겹치지 않는 분해를 만들 때 출력
조각에서 추론을 빼야 합니다. Gemini 는 빼면 안 됩니다 — 빼면 출력이 실제보다
작아지고 조각 합이 합계에 못 미칩니다.

이 때문에 `src/shared.js` 의 `decomposeTokens` 가 기존 두 분기 어디에도 맞지
않아 fallback("겹침 미확인")으로 떨어지고 있었습니다. 세 번째 분기를 넣었습니다.
`cacheWrite === 0` 을 조건에 포함한 이유는 Gemini 로그에 캐시 쓰기 필드가 아예
없어 항상 0 이기 때문입니다 — 이 조건이 없으면 캐시 쓰기가 있는 Claude 기록이
우연히 같은 항등식을 만족할 때 엉뚱한 분해가 먼저 잡힙니다.

### 2. `cached` 가 `input` **안**에 있습니다

`accounting.mjs` 에 `gemini: 'cache_disjoint'` 가 *"M5 에서 확인"* 주석과 함께
들어가 있었습니다. 근거는 "가이드가 cached 를 input 에서 분리하라고 명시한다"
였는데, 로그는 반대였습니다: `cached <= input` 이 전수 성립하고 `total` 에
`cached` 가 따로 더해지지 않습니다.

`cache_disjoint` 로 두면 캐시 적중률의 분모가 `input + cached` 가 되어 값이
부풀려집니다. `cache_in_input` 으로 정정했습니다(Codex 와 같은 회계).

### `tool` 은 확인할 수 없었습니다

전 코퍼스에서 0 이라 `total` 안인지 밖인지 알 수 없습니다. 그래서 **자리를
가정하지 않고** 값만 그대로 싣습니다. 0 이 아닌 `tool` 이 나타나면 위 항등식이
깨지고, 그때는 보정하지 않고 `partial` 등급 + `identityMismatches` 카운터로
드러냅니다. `decomposeTokens` 도 그 경우 fallback 으로 떨어져 "겹침 미확인" 이
붙습니다 — 모르는 것을 아는 척하지 않는 쪽이 맞습니다.

## 중복 메시지 id

같은 `message.id` 가 여러 파일·여러 줄에 다시 나타납니다. resume 사본입니다.

| 포맷 | 고유 id | 중복 발생 |
|---|---|---|
| `.json` | 11,498 | 298 |
| `.jsonl` | 809 | 636 |

그래서 `gemini|<message.id>` 를 키로 요청 단위 upsert(last-wins)를 씁니다.
실제 효과: 토큰이 실린 메시지 13,315건 → 원장 이벤트 **12,307건**. 1,008건이
중복으로 흡수됐고, 재스캔해도 이 수가 늘지 않습니다.

## 프로젝트 디렉터리

`tmp` 아래 디렉터리 186개가 두 형태로 섞여 있습니다.

| 형태 | 개수 | chats 보유 | 경로 복원 |
|---|---|---|---|
| 읽을 수 있는 슬러그 (`mes-mcp-server`) | 76 | 41 | `projects.json` 으로 **73개** |
| 64자 16진수 해시 | 110 | 81 | sha256 역매핑 **2개** |

`~/.gemini/projects.json` 은 `{ projects: { "<소문자 절대경로>": "<슬러그>" } }`
형태이고 73개 항목이 있습니다. 한 슬러그가 두 경로를 가리키는 경우는 **0건**
이었습니다.

해시는 여러 정규화 형태로 sha256 을 맞춰 봤지만 거의 안 맞습니다.

| 시도한 형태 | 일치 |
|---|---|
| 원본 경로 | 2/110 |
| 소문자 | 2/110 |
| POSIX 구분자 | 0/110 |
| 드라이브 대문자 | 1/110 |

옛 CLI 가 만든 해시이고 그 경로가 색인에 더 이상 없기 때문으로 보입니다.
그래서 **일반적으로 역매핑 불가**로 다룹니다. 정책은
[decisions.md](./decisions.md#프로젝트-귀속) 에 있습니다.

세션 문서의 `directories` 필드는 419개 중 **2개**에만 있었습니다. 있으면 그것이
가장 직접적인 근거이므로 색인보다 우선합니다. 다만 항목이 둘 이상이면 어느
것이 이 세션의 프로젝트인지 로그가 말해 주지 않아 고르지 않습니다.

## 도구 이름

`toolCalls[].name` 으로 **70종**이 관측됐습니다. 상위:

```
run_shell_command 2591   replace 2194   read_file 2034   write_file 1208
list_directory 234   write_todos 213   grep_search 118   google_web_search 94
glob 89   search_file_content 61   take_snapshot 61   click 50
```

꼬리는 MCP·프로젝트 전용 이름입니다(`mcp_chrome-devtools_*`, `API-post-page`,
`browser_navigate` 등). 단계 표에는 **CLI 내장 도구만** 넣었습니다 — 남의
프로젝트 어휘를 우리 분류로 굳히면 provider 간 비교가 깨집니다. 나머지는
`other` 로 떨어지고, 그것이 "아직 분류 근거가 없다"는 정직한 표시입니다.

도구 인자(`args`) 키 분포:

```
file_path 5303   command 2591   description 2265   new_string 2194
instruction 2193   old_string 2190   content 1212   dir_path 627
absolute_path 136
```

이 중 **경로 키만** 봅니다: `file_path` / `absolute_path` / `dir_path` / `path`.
`command` · `old_string` · `new_string` · `content` · `instruction` 은 도구 입력
본문이라 열지 않습니다.

## 시계열 비용

"전체 기간" 을 화면 선택지에 넣어도 되는지 확인한 값입니다(3 provider 합).

| 버킷 | 버킷 × provider |
|---|---|
| 시간 | 948 |
| 일 | 234 |
| 주 | 60 |
| 월 | 17 |

버킷은 **활동이 있는 구간에만** 생기므로 달력 길이가 아니라 활동량에 비례
합니다. 8개월 × 24시간이 아니라 948개라 부담이 없습니다.

## 모델 분포

```
gemini-3-flash-preview 6,035   gemini-2.5-pro 4,289   gemini-2.5-flash 1,024
gemini-3-pro-preview 258   gemini-3.1-pro-preview 97   gemini-2.0-flash 93
```

한 세션 안에서 모델이 바뀝니다. 그래서 세션 행의 모델은 마지막 관측값이고,
이벤트마다는 그 시점의 모델을 각각 기록합니다.
