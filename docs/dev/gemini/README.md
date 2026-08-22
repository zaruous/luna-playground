# Gemini CLI 어댑터 (M5)

Gemini CLI 세션 로그를 읽어 공용 원장에 넣는 어댑터입니다. Codex·Claude와 같은
엔진·스토어·스캔 파이프라인을 그대로 쓰고, **다른 것은 토큰 회계와 커서 규칙**
둘입니다. 그 둘은 가이드 문구가 아니라 실제 로그를 재서 정했습니다.

## 이 디렉터리

| 문서 | 내용 |
|---|---|
| [measurements.md](./measurements.md) | 실측 전체 — 코퍼스 규모, 토큰 항등식, 계획서 예측과 어긋난 지점 |
| [antigravity.md](./antigravity.md) | Antigravity CLI(agy) SQLite protobuf — 확인된 것·미확정·화면 정책 |
| [formats.md](./formats.md) | 포맷 두 개(`.json` 스냅샷 / `.jsonl` 증분 로그)와 커서 규칙, `$set` 처리 |
| [decisions.md](./decisions.md) | 설계 결정, 하지 않은 것, 남은 것 |

상위 문서에서의 위치는 [provider-token-api.md §5.4](../provider-token-api.md),
[implementation-plan.md M5](../implementation-plan.md),
[roadmap.md Phase 4](../../roadmap.md)입니다.

## 구현 파일 지도

```
service/providers/gemini/detector.mjs    위치 탐색 · 파일 발견 · projects.json 색인 · 파일 읽기+해시 · 세션 키
service/providers/gemini/parser.mjs      두 포맷 공용 메시지 해석 · 토큰 정규화 · 도구 활동
service/providers/gemini/collector.mjs   준비 → 적재 → 마감 3단계 · 두 커서 전략 · 백필
service/scan-worker.mjs                  provider:strategy 디스패치(gemini:line / gemini:snapshot)
service/providers/tool-phases.mjs        gemini 도구 → 작업 단계 표
service/providers/accounting.mjs         gemini: cache_in_input  ← 실측으로 정정
src/shared.js                            decomposeTokens 세 번째 분기(추론이 출력 밖인 회계)
test/gemini-parser.test.mjs              파서 계약 12건
test/gemini-collector.test.mjs           수집기 · 멱등성 · 프라이버시 7건
```

원본 위치는 `${GEMINI_DATA_DIR:-~/.gemini/tmp}/<프로젝트 디렉터리>/chats/` 이고,
`projects.json` 은 홈(`~/.gemini`)에서 읽습니다. `GEMINI_DATA_DIR` 은 홈이 아니라
`tmp` 자리를 대체하므로 두 경로를 따로 다룹니다. 테스트가 다른 위치를 가리킬
수 있도록 `NYANG_GEMINI_HOME` 도 받습니다.

## capabilities

```js
localLedger: true          로컬 세션 파일이 원장입니다
serverQuota: false         세션 로그에 한도 정보가 없습니다
hooks: false               Gemini CLI 의 hook 규약을 확인하지 못했습니다
telemetry: false
credentials: 'none'
accounting: 'direct'       메시지가 이미 요청 단위 — 누적 diff 아님
tokenAccounting: 'cache_in_input'
```

`hooks: false` 로 둔 결과 대시보드의 Hook 칩·설치 버튼에 Gemini 가 나타나지
않습니다. 규약을 모르는 채 `true` 로 두면 누를 수 없는 버튼이 생깁니다.

## 완료 기준과 근거

| 기준 | 근거 |
|---|---|
| thought → `reasoningTokens`, tool → `toolTokens` | `test/gemini-parser.test.mjs` |
| 같은 파일을 다시 스캔해도 합계·턴이 늘지 않음 | `test/gemini-collector.test.mjs` — 재스캔과 커서 삭제 후 전량 재해석 두 경로 (증분 tail 경로는 아직 테스트가 없습니다) |
| `parser_version` 으로 재해석 대상 선택 가능 | Codex·Claude 와 같은 규칙 + 원장 상태 OR (`hasUnattributedTurns`) |
| 실제 코퍼스에서 항등식 불일치 0 | 807 파일 스캔에서 `identityMismatches: 0`, `cacheOutsideInput: 0`, `parseErrors: 0` |
| 분해 조각 합 == 합계 | 987,623,731 == 987,623,731 (화면 "기간 합계" 에서도 확인) |
| 본문이 SQLite·스냅샷에 없음 | `test/gemini-collector.test.mjs` 의 센티넬 6종 검사 |

## 실행 결과 (개발 머신)

```
807 파일  1회차 9.3초 · 2회차 0.2초(전량 증분 스킵)
987,623,731 토큰 / 12,319 이벤트 / 턴 2,887 / 세션 807
프로젝트 색인 73 · 경로 해석 · 미해석은 파일 단위 누적 카운터
3 provider 통합 백필: 1,719 파일 14.9초
```

엔진을 통해 나온 전체 기간 합계가 어댑터 단독 검증값과 정확히 같습니다
(987,623,731) — 두 경로가 같은 결과를 낸다는 확인입니다.

독립 구현인 `ccusage gemini` 와도 대조했습니다. 10개월 중 9개월이 토큰 단위로
일치하고, 남은 차이는 2026-02 의 -13,020,954 = 그 달 중복 `message.id` 298건
분량입니다 — ccusage 는 같은 id 를 두 번 세고 우리는 한 번 셉니다. 이 대조가
`chats/<uuid>/` 하위 디렉터리 누락(76,888 토큰)을 잡아냈습니다.
