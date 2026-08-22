# Antigravity CLI (agy) 실측

Antigravity CLI 는 Gemini CLI 와 다른 경로에 SQLite 를 둡니다. 이 문서는 **2026-08-22
실측** 기준이며, 코퍼스는 대화 **1개 · 스텝 15개**뿐입니다 — 사용자가 `~/.gemini` 를
지워 이전 43개 대화가 사라진 뒤의 상태입니다.

## 어디에 무엇이 있는가

```
~/.gemini/antigravity-cli/
  conversations/<uuid>.db     SQLite — 사용량은 gen_metadata.data
  brain/<uuid>/.system_generated/logs/transcript.jsonl   토큰 필드 없음
  log/cli-*.log               토큰 필드 없음
```

옛 Gemini CLI 가 쓰던 `${GEMINI_DATA_DIR:-~/.gemini}/tmp/.../chats/` 는 agy 전환
뒤 **없을 수 있습니다.** integration=connected 인데 그 경로만 보면 detected=false 가
되어 "안 썼다"로 읽힙니다(R7).

## 확인된 것

### protobuf 는 필드 **이름**이 없다

처음 조사에서 `grep totalTokenCount` 로 "토큰이 없다"고 판단했습니다. **틀렸습니다.**
protobuf 와이어 포맷에는 필드 번호만 있고 이름 문자열이 없어 grep 으로는 있어도
안 보입니다. `gen_metadata.data` 를 varint 스캐너로 훑어야 합니다.

디코드 절차:

1. `gen_metadata.data` 가 콤마 구분 십진 바이트 문자열이면 `Buffer` 로 되돌린다
2. wire 0(varint)·wire 2(length-delimited, 재귀)만 읽는다
3. 필드 경로는 `1.9.10.1` 처럼 번호만 적는다

구현: `service/providers/gemini/antigravity-protobuf.mjs` · 측정 하네스:
`scripts/probe-antigravity.mjs`

### `1.9.10.*` — 컨텍스트 크기 (소비 토큰 **아님**)

| 경로 | 관측 | 해석 |
|---|---|---|
| `1.9.10.1` | 20082 → 36121 단조 증가 | 그 스텝 시점 **누적 컨텍스트 크기** |
| `1.9.10.4` | 256000 고정 | 컨텍스트 창 크기 |
| `1.9.10.3` | 반복 `{.2=태그, .4=값}` | 컨텍스트 구성 내역 |
| `1.9.10.3.2` | 36121 | 내역 총합 |

**항등식(1대화)**: `6169 + 13760 + 16192 = 36121` — 조각 합 = 선언 총합 (일치 1 /
불일치 0).

**합산 금지:** 스텝마다 `1.9.10.1` 을 더하면 매 턴 다시 읽은 컨텍스트를 중복
계상합니다 — Claude 세션 흐름의 재독 배수와 같은 현상입니다. 절대 "총 사용량"으로
쓰지 않습니다.

## 확인되지 않은 것

### `1.4.*` — 요청 단위 숫자, 의미 미확정

```
1.4.1 = 1298 (고정)   1.4.2 = 14076, 14743, ...
1.4.3 = 259, 106, ... 1.4.5 = 16277, ... (idx 4부터)
1.4.6 = 24 (고정)     1.4.9 = 215, 57, ...
1.4.10 = 44, 49, ...
```

입력/출력/캐시/사고 중 무엇인지 **모릅니다.** 코퍼스가 1개뿐이라 확정할 수
없습니다. 필드 의미가 확정되기 전에는 **어떤 숫자도 화면 사용량으로 올리지
않습니다.**

### transcript.jsonl

최상위 키는 `step_index · source · type · status · created_at · content ·
tool_calls · thinking` 뿐이고 **토큰 필드가 없습니다.** 파싱·저장 대상이 아닙니다
(대화 본문).

## 화면 정책

| collector.sources | 원장 | 화면 kind |
|---|---|---|
| legacy chats 있음 + 관측됨 | >0 | `legacy-observed` — 숫자 표시 |
| agy 있음, legacy 없음 | 0 | `agy-unmeasured` — `—` + 미확립 문구 |
| 둘 다 없음 | >0 | `legacy-gone` — 원장만 |
| 둘 다 없음 | 0 | `not-installed` |

`detected` = legacy chats **또는** agy conversations 중 하나라도 있으면 `true`.

## 다음에 할 일 (측정 확정 후)

1. `scripts/probe-antigravity.mjs` 로 코퍼스가 쌓이면 `1.4.*` 의미 후보를 문서화
2. 확정된 회계만 parser/collector 에 연결
3. 그 전까지는 `agy-unmeasured` 상태 유지
