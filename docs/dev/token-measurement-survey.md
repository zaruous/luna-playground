# 토큰 측정 알고리즘 조사 — 오픈소스 트래커 분석

조사 시점: 2026-08. 목적은 "다른 도구들은 코딩 에이전트의 토큰량을 **무엇을 읽어서, 어떻게 세는가**"를 확인하고, 그 실패 사례를 NyangTracker 설계 규칙으로 옮기는 것입니다.

결론을 먼저 적으면: **로그에 적힌 숫자를 그대로 합산하는 구현은 거의 예외 없이 틀린 값을 낸다.** 문제는 파싱이 아니라 (1) 스트리밍 중간 기록, (2) 누적/증분 혼동, (3) 로그에 아예 없는 토큰 종류, (4) 백분율 한도와 토큰의 혼용 네 곳에서 발생합니다.

## 1. ccusage — 가장 널리 쓰이는 참조 구현

[ccusage](https://github.com/ccusage/ccusage)는 16종 CLI(Claude Code, Codex, Gemini CLI, Copilot CLI, Amp, Goose 등)의 로컬 로그를 읽어 일/월/세션 단위로 집계합니다.

### 중복 제거 키와 그 함정

ccusage는 Claude Code 기록을 `message.id` + `requestId` 조합으로 중복 제거하고, **먼저 본 항목을 유지(first-wins)** 합니다.

문제는 Claude Code가 스트리밍 중 같은 `requestId`로 여러 항목을 append하고, **앞쪽 항목이 중간 스냅샷**이라는 점입니다. 즉 first-wins는 구조적으로 과소 집계입니다. 이슈 [#888](https://github.com/ccusage/ccusage/issues/888)의 실측:

- 하루치 데이터에서 `output_tokens` 약 **517,777 토큰 누락**
- `output_tokens`가 서로 다른 중복 그룹 551개 중 **550개에서 `latest == max`** — 즉 "마지막 유지"와 "최대값 유지"는 실질적으로 같은 결과

권고안은 세 가지(latest-wins / max-wins / 값이 다를 때만 후행 우선)로 제시되었고, 실측상 구분이 거의 무의미합니다.

### 토큰 필드

ccusage가 합산하는 범주는 input / output / cache creation / cache read이며, Gemini는 여기에 thought·tool이 추가됩니다. Gemini 가이드는 **cached를 cache read로 분리해 input과 이중 계상하지 않는다**고 명시합니다([ccusage Gemini 가이드](https://ccusage.com/guide/gemini/)). 비용은 LiteLLM 가격 DB 조회이며, 미등록 모델은 `$0.00`으로 나옵니다. thought 토큰은 output 단가로 계산합니다.

## 2. Claude Code JSONL 자체의 신뢰성 문제

여기가 가장 중요한 발견입니다. `~/.claude/projects/<project>/<conversation-id>.jsonl`의 usage 필드는 **필드별로 신뢰도가 다릅니다.**

[측정 보고](https://gille.ai/en/blog/claude-code-jsonl-logs-undercount-tokens/) 기준:

| 필드 | 신뢰도 |
|---|---|
| `usage.cache_read_input_tokens` | 정확 (상태줄과 ~1x 일치) |
| `usage.cache_creation_input_tokens` | 정확 |
| `usage.input_tokens` | **전체 항목의 75%가 0 또는 1** — 스트리밍 플레이스홀더가 최종값으로 갱신되지 않음. 100~174x 과소 |
| `usage.output_tokens` | 10~17x 과소. thinking 토큰이 빠져 있고(그 자체로 약 3x), 스트리밍 중간값 문제도 겹침 |

레코드에 `thinking_tokens` 같은 별도 필드는 없습니다. 같은 문제가 Anthropic 저장소 이슈 [#28197](https://github.com/anthropics/claude-code/issues/28197), ccusage 이슈 [#866](https://github.com/ccusage/ccusage/issues/866)에도 올라와 있습니다.

즉 **Claude 어댑터를 JSONL만으로 만들면 "정확한 총 토큰"을 만들 수 없습니다.** 이는 파서 품질 문제가 아니라 원본 데이터의 한계입니다.

### 대안 원본: OpenTelemetry

Claude Code는 [공식 텔레메트리](https://code.claude.com/docs/en/monitoring-usage)로 `claude_code.token.usage`(단위: tokens)와 `claude_code.cost.usage`(단위: USD)를 내보냅니다. 속성:

- `type` = `input` | `output` | `cacheRead` | `cacheCreation`
- `model`, `session.id`, `query_source`(`main`/`subagent`/`auxiliary`), `terminal.type`, `app.entrypoint`

`CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER=otlp` + `OTEL_EXPORTER_OTLP_ENDPOINT`로 활성화되고, 기본 export 간격은 60초입니다. **서브에이전트 사용량이 `query_source`로 구분되어 나오는 것**이 JSONL 대비 큰 이점입니다.

## 3. Codex — 누적 카운터 diff 방식

Codex CLI는 `~/.codex/sessions/**/rollout-*.jsonl`에 턴별 토큰과 모델을 기록하고, 자체 비용 계산이나 이력 화면은 제공하지 않습니다. ccusage를 포함한 도구들은 **누적 카운터를 diff** 해서 턴 증분을 만듭니다.

또한 Codex는 **토큰으로 과금 한도를 재지 않습니다.** 5시간 창과 주간 창의 **사용 백분율**로 잽니다(`/status`). 그래서 토큰 원장과 한도 원장이 애초에 다른 단위입니다.

NyangTracker의 현재 구현이 이미 이 지점을 다룹니다 — `service/providers/codex/parser.mjs`가 `total_token_usage`/`last_token_usage`를 함께 쓰고(`incrementSource`로 근거를 남김), `rate_limits`는 별도 원장(`server_usage_snapshots`)으로 보관합니다. 상세는 [`docs/codex-usage.md`](../codex-usage.md).

## 4. Cursor — 로컬 파일이 아니라 공식 API

Cursor는 로컬 로그로 토큰을 셀 수 없습니다. 공식 [Admin API](https://cursor.com/docs/account/teams/admin-api)가 정답입니다.

| 항목 | 내용 |
|---|---|
| 엔드포인트 | `POST /teams/filtered-usage-events`, `POST /teams/daily-usage-data` |
| 인증 | Basic 인증, API 키를 username으로 |
| 토큰 필드 | `isTokenBasedCall`이 true일 때 `tokenUsage.{inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens}` |
| 비용 | `totalCents`, `chargedCents`, `discountPercentOff` |
| 식별자 | `timestamp`(epoch ms 문자열), `userEmail`, `model`, `conversationId`, `kind` |
| 집계 단위 | **시간 단위** — 시간당 1회 이상 폴링 권장하지 않음 |
| 레이트리밋 | filtered-usage-events 60 req/min, daily-usage-data 20 req/min, 페이지 크기 최대 1000 |

`isTokenBasedCall`이 false인 요청 기반(request-based) 플랜에서는 **토큰 자체가 제공되지 않습니다.** 이 경우는 요청 수와 비용만 실측 가능합니다.

[openusage](https://github.com/robinebers/openusage/blob/main/docs/providers/cursor.md)는 여기서 더 나가 `api2.cursor.sh` Connect RPC, `cursor.com/api/usage`, Stripe 잔액, CSV export를 쓰고 **Cursor 로컬 상태 DB와 키체인에서 세션 토큰을 읽습니다.** 동작은 하지만 비공식 엔드포인트 + 타인 자격증명 저장소 접근이라 NyangTracker는 채택하지 않습니다(아래 규칙 R6).

## 5. 다중 provider 정규화 사례

- [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) — Codex/Claude/Gemini/Cursor/Copilot을 한 CLI로 묶고, 한도를 `usage.{primary,secondary,tertiary}.{usedPercent, remainingPercent, windowMinutes, resetsAt}`로 평탄화합니다. 수집 전략을 CLI/Web(브라우저 쿠키)/OAuth/API/Local 5종으로 구분합니다. NyangTracker의 `quotaWindows`와 사실상 같은 모양이고, 우리 쪽은 `limitId`까지 키에 넣어 모델별 한도를 분리합니다.
- Token Tracker — provider별 로그를 `(source, model, hour_start)` 키의 30분 UTC 버킷으로 정규화하고 로컬 HTTP API(포트 7680)로 제공합니다. **버킷 단위 사전 집계**는 우리가 시계열 화면을 만들 때 참고할 구조입니다([설명](https://agenticcontrolplane.com/blog/codex-cli-cost-tracking)).
- [geminiusage](https://github.com/rmedranollamas/geminiusage) — Gemini 세션 로그 파싱 + 계단식 가격 적용 + TUI.

## 6. 도출한 설계 규칙

| # | 규칙 | 근거 |
|---|---|---|
| R1 | 중복 제거는 **last-wins**(동일 키 중 마지막 항목 채택). `max`와 사실상 동일하나, 순서 기반이 구현·검증이 쉽다 | ccusage #888 실측 550/551 |
| R2 | 필드 단위로 신뢰도를 기록한다. Claude의 `input_tokens`/`output_tokens`는 `measurementQuality`를 낮춰 저장하고 UI에서 `추정`/`미확인`으로 표시 | Claude JSONL 100~174x 과소 |
| R3 | 누적 카운터는 반드시 diff하고, 감소는 리셋 후보로 분류한다. 리셋 시 전체 누적값을 사용량으로 기록하지 않는다 | Codex 구현 경험 + 도구 공통 |
| R4 | 캐시 읽기 토큰은 input에 합산하지 않고 별도 필드로 유지한다 | ccusage Gemini 가이드의 이중 계상 회피 |
| R5 | 백분율 한도는 토큰으로 변환하지 않는다. 한도 원장과 토큰 원장은 끝까지 별도 테이블 | Codex 한도가 percent 단위 |
| R6 | 비공식 엔드포인트, 브라우저 쿠키, 타 앱 키체인에서 자격증명을 훔쳐오지 않는다. 공식 API 키를 사용자가 직접 입력하는 경로만 지원한다 | openusage 방식의 위험 |
| R7 | 로그가 제공하지 않는 값은 비워 둔다. thinking 토큰이 로그에 없으면 0이 아니라 "미확인"이다 | Claude thinking 누락 |
| R8 | 텔레메트리 같은 더 정확한 원본이 있으면 **선택적 보강 경로**로 붙이고, 로그 기반 값을 조용히 덮어쓰지 않는다 | Claude OTel `query_source` 이점 |

R2·R7은 특히 중요합니다. 다른 도구들이 "총합 하나"를 보여주다가 틀리는 지점을, 우리는 **필드별 품질 등급**으로 드러내는 방향으로 갑니다.

## 출처

- [ccusage](https://github.com/ccusage/ccusage) · [Gemini 가이드](https://ccusage.com/guide/gemini/) · [이슈 #888 (중복 제거)](https://github.com/ccusage/ccusage/issues/888) · [이슈 #866 (JSONL 신뢰성)](https://github.com/ccusage/ccusage/issues/866)
- [Claude Code JSONL 과소 집계 분석](https://gille.ai/en/blog/claude-code-jsonl-logs-undercount-tokens/) · [anthropics/claude-code #28197](https://github.com/anthropics/claude-code/issues/28197)
- [Claude Code 모니터링 문서 (OTel)](https://code.claude.com/docs/en/monitoring-usage)
- [Cursor Admin API](https://cursor.com/docs/account/teams/admin-api) · [openusage cursor.md](https://github.com/robinebers/openusage/blob/main/docs/providers/cursor.md)
- [Gemini CLI 세션 관리](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)
- [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) · [Codex CLI 비용 추적 정리](https://agenticcontrolplane.com/blog/codex-cli-cost-tracking) · [geminiusage](https://github.com/rmedranollamas/geminiusage)
