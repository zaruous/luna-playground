# 포맷 두 개와 커서 규칙

Gemini CLI 는 세션을 **두 포맷**으로 남깁니다. 한 provider 안에 커서 규칙이
둘이라는 뜻이고, 이것이 이 어댑터에서 다른 provider 와 가장 크게 갈리는 지점
입니다.

```
${GEMINI_DATA_DIR:-~/.gemini}/tmp/<프로젝트 디렉터리>/chats/
  session-2026-01-01T00-00-abcd1234.json     문서 전체 스냅샷
  session-2026-01-02T00-00-bbbb2222.jsonl    증분 로그
```

`.endsWith('.json')` 은 `.jsonl` 을 **잡지 않습니다.** 두 확장자를 따로 적어야
합니다(`detector.mjs` 의 `isGeminiSessionFile`). 이 한 줄 때문에 실측 조사에서
386개 파일이 빠져 있었습니다.

## 포맷 1 — `.json` 문서 스냅샷

```jsonc
{
  "sessionId": "…UUID…",
  "projectHash": "<프로젝트 디렉터리 이름>",
  "startTime": "2026-01-01T00:00:00.000Z",
  "lastUpdated": "2026-01-01T00:10:00.000Z",
  "summary": "…",            // 대화 요약 — 읽지 않습니다
  "directories": ["…"],       // 419개 중 2개에만 존재
  "messages": [ /* 아래 메시지 모양 */ ]
}
```

세션이 자랄 때마다 **파일 전체가 다시 써집니다.** `lastUpdated` 가 앞쪽에 있고
배열이 재직렬화되므로 바이트 오프셋으로 이어 읽을 수 없습니다.

**커서 규칙**: `mtime` + 크기로 1차 판정하고, 통과하면 파일을 읽어 **내용 해시**
로 2차 판정합니다. 해시가 저장된 것과 같으면 `JSON.parse` 와 적재를 모두 건너
뜁니다 — 이 포맷에서 가장 비싼 단계가 파싱이라, "내용이 같은 재작성" 을 걸러
내는 것이 실질적인 절약입니다. 해시는 `provider_scan_state.content_hash` 에
저장합니다(M8 에서 이 컬럼을 예약해 둔 이유가 이것입니다).

`byteOffset` 에는 파일 크기를 넣습니다. 이어 읽을 지점이 아니라 "여기까지 다
읽었다" 는 표시이고, 실제 판정은 해시가 합니다.

**source_offset**: 사용량 이벤트의 **파일 내 순번**입니다. 바이트 지점이 없으니
`UNIQUE(provider, source_path, source_offset)` 을 만족시킬 다른 단조 값이 필요
합니다. 메시지는 뒤에만 붙으므로 순번은 안정적이고, 동일성 판정의 주체는 어차피
`event_key`(메시지 id)라 순번이 밀려도 합계는 늘지 않습니다
(`parser.mjs` 의 `withSourceOffsets`).

## 포맷 2 — `.jsonl` 증분 로그

줄이 뒤에만 붙습니다. 그래서 **다른 file 기반 provider 와 같은 바이트 tail** 을
씁니다(`readCompleteLines`). 줄은 세 종류입니다.

```jsonc
// 1) 헤더 — 파일 첫 줄
{"sessionId":"…","projectHash":"…","startTime":"…","lastUpdated":"…","kind":"main"}

// 2) 메시지 — `.json` 의 messages[] 원소와 같은 모양
{"id":"…","timestamp":"…","type":"user","content":"…"}
{"id":"…","timestamp":"…","type":"gemini","content":"…","thoughts":"…",
 "tokens":{"input":7872,"output":73,"cached":0,"thoughts":0,"tool":0,"total":7945},
 "model":"gemini-2.5-pro","toolCalls":[…]}

// 3) 패치
{"$set":{"lastUpdated":"…"}}
{"$set":{"messages":[{ "id":"…","timestamp":"…","type":"user","content":"…" }]}}
```

### `$set` 처리

3,063줄을 전수로 봤습니다.

| `$set` 키 | 건수 | 토큰 포함 |
|---|---|---|
| `lastUpdated` | 3,062 | 0 |
| `messages` | 1,982 | 0 |
| `summary` | 1 | 0 |
| `memoryScratchpad` | 1 | 0 |

**토큰이 실린 `$set` 은 0건입니다.** `$set.messages` 안의 메시지 객체 1,982개도
전부 토큰이 없고 키가 `content` / `id` / `timestamp` / `type` 뿐입니다. 그래서
`$set` 을 무시해도 사용량은 하나도 잃지 않습니다.

다만 그중 **한 건**은 일반 줄에 한 번도 나타나지 않은 id 였습니다(일반 줄 id
1,126개, `$set.messages` 전용 id 1개). 그 메시지가 `type: 'user'` 면 턴 경계가
사라집니다. 그래서 `$set.messages` 항목도 같은 메시지 해석 경로로 통과시킵니다
— 토큰이 없으니 결과적으로 턴 경계만 나옵니다.

`lastUpdated` / `summary` / `memoryScratchpad` 패치는 아무 이벤트도 만들지
않습니다.

## 두 포맷이 공유하는 메시지 해석

`parser.mjs` 의 `messageEvents(message, state)` 하나가 둘을 다 처리합니다.

| 입력 | 나오는 이벤트 |
|---|---|
| `type: 'user'` | `turn` (턴 번호 +1, 경계 시각 기록, `compacted: false`) |
| `type: 'gemini'` + `tokens` | `usage` (`eventKey: gemini\|<id>`) |
| `type: 'gemini'` 인데 `tokens` 없음 | 없음 (`messagesWithoutTokens` 카운터만) |
| `info` / `error` / `warning` | 없음 |

턴 경계는 사람 메시지입니다. 경계 앞에서 나온 사용량은 어느 턴인지 모르므로
**0번(경계 미확인) 버킷**에 남습니다 — 실측에서 첫 사람 메시지 앞에 토큰
메시지가 2건 있었습니다. `.jsonl` 을 파일 중간부터 이어 읽을 때도 같은 상황이
되므로, 이어 읽기에서는 저장된 마지막 턴 번호를 물려받습니다.

컴팩션 경계를 가리키는 표시는 두 포맷 어디에서도 찾지 못했습니다. 그래서
`compacted` 는 항상 `false` 입니다 — 있는 것처럼 표시하지 않습니다.

## 워커 디스패치

`service/scan-worker.mjs` 는 전략을 `provider:strategy` 키로 고릅니다.

```
codex:line        readCompleteLines + parseCodexRolloutLine
claude:line       readCompleteLines + parseClaudeTranscriptLine
gemini:line       readCompleteLines + parseGeminiLogLine
gemini:snapshot   readGeminiSessionFile(+해시) + parseGeminiSessionFile
```

provider 단위로 갈 수 없는 이유가 여기 있습니다 — Gemini 한 provider 안에 두
전략이 있어서, 전략은 **파일**이 정합니다(`geminiFileStrategy`). 컬렉터가 job 에
`strategy` 를 실어 보내고, 스냅샷 전략일 때만 `knownContentHash` 를 함께 넘겨
워커가 파싱을 건너뛸 수 있게 합니다.

## 재해석 트리거

Codex·Claude 와 같습니다: `parser_version` 이 낮으면, **또는** 원장에 턴이 안
붙어 있으면(`hasUnattributedTurns`) 처음부터 다시 읽습니다. 버전 도장만 보면
결함 있는 중간 버전이 버전만 올려놓고 메타를 못 쓴 경우가 영구히 비어 있게
됩니다(M8 에서 실제로 겪은 일).
