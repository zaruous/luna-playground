# LLM별 토큰 처리 API 설계

표준 어댑터 인터페이스는 이미 `service/providers/contracts.mjs`에 있습니다. 이 문서는 그 인터페이스를 **바꾸지 않고** Codex / Claude / Cursor / Gemini 4종을 어떻게 얹는지, 그리고 각 provider가 요구하는 확장이 무엇인지 정의합니다.

전제는 [token-measurement-survey.md](./token-measurement-survey.md)의 규칙 R1~R8입니다. 특히 R5(백분율↔토큰 변환 금지)와 R7(없는 값은 0이 아니라 미확인)이 아래 설계 전반을 지배합니다.

## 1. 현재 계약 (변경 없음)

```js
class UsageProviderAdapter extends EventEmitter {
  constructor({ id, name, measurement = 'local_observed', capabilities = {} })
  async start()            // 감지 → 과거 수집 → 증분 관측 시작
  stop()                   // watcher/timer/연결 해제
  async reconcile(reason)   // 놓친 로컬/서버 관측 복구
  getStatus()              // 비민감 수집 상태
}
```

필수 메서드는 `assertProviderAdapter()`가 검사합니다(`start`/`stop`/`reconcile`/`getStatus` + `on`). 발신 이벤트는 `updated`, `hook`, `error-state` 셋뿐이고, 레지스트리가 `provider` id를 붙여 엔진으로 전달합니다.

## 2. 확장 1 — 수집 원본 종류(`sourceKind`)

Codex 하나만 있을 때는 "파일 tail" 하나로 충분했습니다. Cursor가 들어오면 원본이 HTTP API이고, Claude는 선택적으로 텔레메트리 수신이 됩니다. 그래서 어댑터 메타데이터에 원본 종류를 추가합니다.

```js
// capabilities 확장 (기존 필드 유지)
capabilities: {
  localLedger: true,       // 로컬 로그로 토큰 원장을 만들 수 있는가
  serverQuota: true,       // 서버 한도 snapshot을 얻을 수 있는가
  serverLedger: false,     // 서버가 토큰 원장 자체를 주는가 (Cursor 전용)
  hooks: true,             // lifecycle hook 가속 경로가 있는가
  telemetry: false,        // 선택적 텔레메트리 보강 경로가 있는가
  credentials: 'none',     // 'none' | 'api_key'
}
```

`sourceKind`는 이벤트가 아니라 **저장 시 근거**로 쓰입니다. `usage_events.measurement_source`에 이미 있는 컬럼(`local_log` 기본값)을 다음 값으로 확장합니다.

| `measurement_source` | 의미 | 사용 provider |
|---|---|---|
| `local_log` | provider가 디스크에 쓴 durable 로그 | Codex, Claude, Gemini |
| `server_api` | provider 공식 API가 준 토큰 원장 | Cursor |
| `server_snapshot` | 백분율/한도 snapshot (토큰 아님) | Codex, Claude(제한적) |
| `telemetry` | OTLP 등 푸시 수신 | Claude(선택) |

## 3. 확장 2 — 증분 커서 두 종류

현재 `provider_scan_state`는 `(provider, source_path)` 키에 **바이트 오프셋**을 저장합니다. 파일 기반 provider에는 그대로 맞지만, API 기반 provider에는 시간 창 커서가 필요합니다.

```js
// 파일 기반 (Codex/Claude/Gemini) — 기존 구조 유지
{ provider, sourcePath, byteOffset, previousUsage, updatedAt }

// API 기반 (Cursor) — 신규
{ provider, sourceKey: 'filtered-usage-events', windowEnd, lastEventTimestamp, page, updatedAt }
```

API 커서 규칙:

- `windowEnd`는 **닫힌 시간 버킷의 끝**만 전진시킨다. Cursor는 시간 단위 집계이므로 진행 중인 시각은 확정값이 아니다.
- 같은 시간 버킷을 재요청해도 안전해야 한다 → 이벤트 식별자 기반 중복 제거(§5.3)에 의존한다.
- 폴링 간격 기본 1시간. provider 문서가 권고하는 하한을 코드 상수로 못박는다.

## 3.5 확장 3 — 턴 계층 (M8)

토큰 원장은 **요청** 단위입니다. 그 위에 **턴**(사람 프롬프트 1개 ~ 다음 프롬프트까지)을 얹으면 "어떤 절차로 얼마를 썼나"가 나옵니다. 설계 전체는 [menus/session.md](./menus/session.md)에 있고, 여기서는 **어댑터가 무엇을 제공해야 하는지**만 정의합니다.

```js
// capabilities 추가
capabilities: {
  turnLedger: true,                  // 턴 경계를 원본에서 찾을 수 있는가
  accounting: 'direct',              // 'cumulative_diff' | 'direct'
  tokenAccounting: 'cache_disjoint', // 'cache_in_input' | 'cache_disjoint'
}
```

### 어댑터가 새로 내보내는 이벤트

```js
{
  type: 'turn',
  provider: 'claude',
  sessionId: '...',
  turnIndex: 12,          // 세션 내 1부터. 0 은 "경계 미확인" 예약값
  startedAt: '2026-08-21T01:00:00.000Z',  // 프롬프트 시각. 본문은 담지 않는다
  compacted: false,       // 직전에 컨텍스트 컴팩션이 있었는가
  parserVersion: 2,
}
```

기존 `usage` 이벤트에는 세 필드를 더 붙입니다.

```js
{
  turnIndex: 12,                        // 이 요청이 속한 턴
  toolCounts: { Bash: 2, Edit: 1 },     // 도구 **이름**만. 입력(payload)은 읽지 않는다
  touchedPaths: { 'docs/a.md': 1 },     // 경로 접미만 (마지막 단 + 부모)
}
```

### provider 별로 확인해야 하는 것

새 어댑터를 붙일 때 이 표의 자기 행을 채워야 합니다. 못 채우면 `turnLedger: false` 로 선언하고 화면은 "턴 정보 미제공"으로 표기합니다 — **0으로 채우지 않습니다**(R7).

| provider | 턴 경계 | 도구 이름 위치 | 컴팩션 마커 | 상태 |
|---|---|---|---|---|
| Codex | `event_msg.payload.type === 'user_message'` | `response_item.payload.name` (`function_call` / `custom_tool_call` / `local_shell_call` / `tool_search_call`) | `event_msg/context_compacted`, `compacted` 레코드 | 구현 |
| Claude | `type:'user'` 이고 `toolUseResult` 없고 text 블록 있음 | `message.content[].tool_use.name` | `type:'system'`, `subtype:'compact_boundary'` | 구현 |
| Gemini | `type:'user'` 메시지 (`.json` 의 `messages[]` / `.jsonl` 의 메시지 줄 · `$set.messages` 포함) | `toolCalls[].name` | **없음** — 두 포맷 어디에도 마커가 없어 `compacted` 는 항상 false | 구현 ([gemini/formats.md](./gemini/formats.md)) |
| Cursor | **불가** — Admin API는 이벤트 단위 집계만 주고 대화 구조가 없음 | 없음 | 없음 | `turnLedger: false` |

### 도구 → 단계 매핑은 어댑터 어휘로

정규 단계 이름은 공용 6개(`explore` / `implement` / `verify` / `plan` / `clarify` / `delegate`)이고, **도구 어휘는 provider마다 다릅니다.** 표는 `service/providers/tool-phases.mjs` 한 곳에 provider별로 두고, 파서는 **이름만 기록**합니다.

파싱 때 단계를 확정하지 않는 이유는 매핑이 바뀌어도 재파싱이 필요 없게 하려는 것입니다 — **이름은 사실이고 단계는 해석**입니다. 새 provider는 빈 표로 시작해도 동작하며, 그때는 전부 `other`로 떨어집니다(정직한 미분류).

### 회계 표는 한 곳에만

`service/providers/accounting.mjs`가 provider별 토큰 회계(`cache_in_input` / `cache_disjoint`)를 갖고, 어댑터 capabilities·엔진 집계·스토어 쿼리가 모두 그것을 봅니다. 이 값이 두 곳에 흩어져 있던 동안 캐시 적중률이 Claude에서 수천 %로 나왔습니다.

## 4. 공통 정규화 타입

파서가 만들어 스토어로 넘기는 모양은 이미 [`docs/provider-adapter-contract.md`](../provider-adapter-contract.md)에 있습니다. 4종을 다 받으려면 두 필드를 더 씁니다.

```js
{
  type: 'usage',
  provider: 'claude',
  eventTimestamp: '2026-08-21T10:00:00.000Z',
  session: { provider, sessionId, cwd, projectName, model },
  delta: {
    inputTokens: 0,
    cachedInputTokens: 0,      // 캐시 읽기. input에 합산하지 않는다 (R4)
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    toolTokens: 0,             // 신규 — Gemini tool 토큰
    totalTokens: 0
  },
  fieldQuality: {              // 신규 — 필드 단위 신뢰도 (R2)
    inputTokens: 'unverified',
    outputTokens: 'partial',
    cachedInputTokens: 'exact'
  },
  eventKey: '...',
  measurementSource: 'local_log',
  measurementQuality: 'partial'
}
```

### 품질 등급

| 등급 | 정의 | UI 라벨 |
|---|---|---|
| `server_verified` | provider 공식 사용량 API가 확정한 값 | 서버 검증됨 |
| `local_exact` | 로컬 로그가 최종 확정값을 담고 있음 | 로컬 관측 |
| `partial` | 값은 실측이지만 일부 범주가 빠짐 (예: thinking 미포함 output) | 추정 |
| `unverified` | 원본이 플레이스홀더/미갱신일 수 있음 | 미확인 |

`measurementQuality`는 이벤트 전체의 최저 등급으로 정하고, `fieldQuality`가 필드별 근거를 남깁니다. 두 값이 있으므로 UI는 "합계는 미확인, 캐시 읽기는 로컬 관측" 같은 혼합 상태를 정직하게 표시할 수 있습니다.

## 5. provider별 설계

### 5.1 Codex — 구현 완료 (참조 구현)

| 항목 | 값 |
|---|---|
| 원본 | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl` |
| 토큰 레코드 | `event_msg.payload.type === 'token_count'` |
| 증분 방식 | `last_token_usage` 우선, 없으면 `total_token_usage` 누적 diff |
| 커서 | 파일별 byte offset + 이전 누적값 |
| 한도 | 같은 이벤트의 `rate_limits` → `server_usage_snapshots` (percent) |
| 중복 제거 | `eventKey` = `codex|session|timestamp|model|토큰 6종` (fork는 부모 세션 id) |
| 품질 | `local_exact` |
| Hook | `~/.codex/hooks.json`에 4개 이벤트 |

상세는 [`docs/codex-usage.md`](../codex-usage.md). 나머지 3종은 이 구조에서 **다른 점만** 기술합니다.

### 5.2 Claude Code — 구현 완료

| 항목 | 값 |
|---|---|
| 원본 | `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project>/<conversation-id>.jsonl` (+ `<session>/subagents/agent-*.jsonl`, `subagents/workflows/<run>/*.jsonl`) |
| 토큰 필드 | `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, `usage.output_tokens_details.thinking_tokens` |
| 증분 방식 | **레코드가 이미 요청 단위** — 누적 diff가 아니라 요청별 값 (`capabilities.accounting = 'direct'`) |
| 토큰 회계 | `capabilities.tokenAccounting = 'cache_disjoint'` — 캐시 읽기/쓰기가 input 밖 |
| 중복 제거 | `claude\|message.id\|requestId`, **last-wins + 역행 방지** (R1) |
| 커서 | 파일별 byte offset. 단, tail 이후에도 **같은 requestId가 다시 나타날 수 있음** |
| 한도 | JSONL에 없음 → `capabilities.serverQuota = false` |
| 품질 | 아래 표 |

핵심 난점 두 개를 어떻게 다루는지가 이 어댑터의 전부입니다.

**(a) 같은 요청이 여러 줄** — 두 가지 이유로 생깁니다. 첫째, 한 응답이 content block(thinking / text / tool_use) 단위로 나뉘어 기록되고 앞 줄은 스트리밍 중간값을 담습니다. 둘째, 세션을 resume하면 이전 transcript가 새 파일로 복사됩니다. byte offset tail 방식과 충돌하는데, 이미 커밋한 값을 나중 값으로 교체해야 하기 때문입니다. 해결:

```js
// 저장은 (provider, event_key) upsert — 마지막 관측이 이긴다
// event_key = `claude|${messageId}|${requestId}`
store.upsertUsageEvent(event, filePath, sourceOffset);   // 기존 insert-if-absent 와 별도
```

즉 Claude 어댑터는 **append-only 가정을 버리고 요청 단위 upsert**를 씁니다. `usage_events`에 이미 `event_key`가 있으므로 UNIQUE 제약과 UPSERT만 추가했습니다([store-extensions.md](./store-extensions.md)).

주의할 점 둘:

- 중복 제거 키는 **파일이 아니라 요청**을 가리켜야 합니다. 파일 단위로 끊으면 resume 사본 때문에 실측에서 출력이 8.37% 부풀었습니다.
- resume 사본의 사용량이 0으로 남는 경우가 있어(실측 1건) upsert는 **더 작은 값으로 덮지 않습니다**. 한 파일 안에서 역행은 실측 0건이므로 이 가드는 last-wins 의미를 바꾸지 않습니다.
- upsert 시 `source_offset`은 최초 값을 유지합니다 — `UNIQUE(provider, source_path, source_offset)`이 남아 있어 갱신하면 새 행이 생깁니다.

**(b) 필드별 신뢰도** — R2에 따라 그대로 노출합니다. 아래는 이 기계의 실제 로그(2.1.143~2.1.232, assistant 레코드 30,753건)로 확인한 등급입니다.

| 필드 | 등급 | 근거 |
|---|---|---|
| `cachedInputTokens` | `local_exact` | ccusage와 정확히 일치 |
| `cacheWriteInputTokens` | `local_exact` | 동일. TTL 내역(`cache_creation.ephemeral_*`)과 어긋나는 13건만 `partial` |
| `inputTokens` | `local_exact` (2.1.143+) | `input ≤ 1`은 8.9%뿐이고 그중 98.8%는 캐시가 프롬프트를 흡수한 정상 케이스. 한 요청의 여러 레코드에서 값이 변하지 않아 스트리밍 플레이스홀더가 아님. 하한 미만·미확인 버전은 `unverified` |
| `outputTokens` | `local_exact` (2.1.228+) / `partial` | thinking 내역이 있는 버전만 완전성을 증명할 수 있음 |
| `reasoningTokens` | `local_exact` (2.1.228+) / 미제공 | `output_tokens_details.thinking_tokens`. 필드가 없는 버전은 0이 아니라 키를 비움 (R7) |

조사 문서가 인용한 "`input_tokens` 항목 75%가 0/1 플레이스홀더"는 2.1.x 범위에서 재현되지 않았습니다. 그 수치는 당시 측정으로 보존하고, 우리 등급은 픽스처가 뒷받침하는 범위에만 적용합니다([claude-code-adapter.md](../claude-code-adapter.md) §7의 요구사항).

**(c) 선택적 텔레메트리 보강** — `capabilities.telemetry`는 현재 `false`입니다. 켜면 서비스가 로컬 OTLP 수신 지점을 열고, Claude Code에 다음을 설정하도록 안내합니다.

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<서비스가 배정한 포트>
```

`claude_code.token.usage`의 `type`(`input`/`output`/`cacheRead`/`cacheCreation`) × `model` × `session.id` × `query_source`(`main`/`subagent`/`auxiliary`)를 그대로 매핑하면 **서브에이전트 사용량 분리**까지 얻습니다. 이 경로로 들어온 값은 `measurement_source = 'telemetry'`, 품질 `local_exact`로 저장하고, JSONL 원장을 **덮어쓰지 않고 별도 레인으로 병렬 보관**합니다(R8). 화면에서는 텔레메트리 레인이 있으면 그것을 기본 표시로 승격합니다.

다만 JSONL만으로도 서브에이전트 귀속은 됩니다 — 서브에이전트 transcript의 `sessionId`가 부모 세션 id이기 때문입니다(실측). 텔레메트리의 이점은 `query_source`로 **부모/서브에이전트 사용량을 나눠 볼 수 있다**는 쪽입니다.

**(d) Hook** — `~/.claude/settings.json`에 `SessionStart / Stop / StopFailure / SessionEnd / SubagentStop`. 가속 경로일 뿐이라 hook을 다 끄고도 수집이 정확해야 하며, 테스트가 그것을 검사합니다.

### 5.3 Cursor

Cursor는 유일하게 **로컬 파일 원장이 없는** provider입니다.

| 항목 | 값 |
|---|---|
| 원본 | `POST /teams/filtered-usage-events` (이벤트 단위), `POST /teams/daily-usage-data` (일 단위 보조) |
| 인증 | Basic, API 키를 username으로. 키는 사용자가 설정 화면에서 직접 입력 |
| 토큰 필드 | `tokenUsage.{inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens}` — `isTokenBasedCall === true`일 때만 |
| 비용 | `totalCents`, `chargedCents` — provider가 준 실제 금액이므로 추정이 아니라 `server_verified` |
| 커서 | `windowEnd` 시간 버킷 + 페이지네이션(`page`, `pageSize` ≤ 1000) |
| 폴링 | 기본 1시간. 데이터가 시간 단위 집계이므로 그 이상 자주 호출해도 새 값이 없다 |
| 레이트리밋 | 60 req/min (events), 20 req/min (daily) — 어댑터에 토큰 버킷 구현 |
| 품질 | `server_verified` |
| 턴 경계 | **불가** — API가 대화 구조를 주지 않습니다. `turnLedger = false` 로 선언하고 세션 흐름 화면에서 "턴 정보 미제공"으로 표기 |

```js
// 이벤트 식별자: API가 안정적인 id를 주지 않으므로 조합 키를 만든다
eventKey = `cursor|${timestamp}|${userEmail}|${model}|${conversationId ?? ''}|${kind}`;
```

**요청 기반 플랜 처리**: `isTokenBasedCall === false`면 토큰이 없습니다. 이때 토큰 필드를 0으로 채우면 R7 위반입니다. 대신:

- `usage_events`에 토큰 이벤트를 만들지 않는다
- `requestsCosts` / 요청 수는 **별도 카운터**로 저장하고 UI에 "요청 기반 플랜 — 토큰 미제공"으로 표기한다
- `capabilities.localLedger = false`, `serverLedger = true`

**개인 계정**: Admin API는 팀/엔터프라이즈 대상입니다. 개인 계정은 공식 토큰 원장 경로가 없으므로 어댑터는 `detected: true, ledgerAvailable: false` 상태로 남고, 화면은 연결 안내만 띄웁니다. 비공식 RPC·쿠키·키체인 경로는 사용하지 않습니다(R6).

### 5.4 Gemini CLI

M5에서 구현했습니다. 처리 사항 전체는 [gemini/](./gemini/README.md) 에 있고 —
[실측](./gemini/measurements.md) · [포맷과 커서 규칙](./gemini/formats.md) ·
[설계 결정](./gemini/decisions.md) — 아래는 그 요약입니다. **예측이 아니라 실측**입니다. 개발 머신 코퍼스
(`.json` 419파일 / 토큰 실린 메시지 11,796건 + `.jsonl` 386파일 / 1,519건)를
전수로 재서 확정했습니다. 예측과 어긋난 항목은 표에 함께 적어 둡니다 — 다음에
읽는 사람이 같은 예측을 다시 하지 않도록.

| 항목 | 값 |
|---|---|
| 원본 | `${GEMINI_DATA_DIR:-~/.gemini/tmp}/<project_dir>/chats/*.json`, `*.jsonl` |
| 토큰 필드 | input / output / cached / thoughts / tool / total — 여섯 개가 **항상** 채워져 옵니다(누락 0건) |
| 포맷 | **둘**입니다. `.json` 은 문서 전체 스냅샷, `.jsonl` 은 헤더 + 메시지 + `$set` 패치가 뒤에만 붙는 증분 로그. `endsWith('.json')` 은 `.jsonl` 을 잡지 않습니다 |
| 증분 방식 | `.jsonl` 은 다른 provider 와 같은 바이트 tail. `.json` 은 tail이 불가하므로 mtime + 크기로 1차, **내용 해시**로 2차 판정(내용이 같은 재작성이면 파싱을 건너뜁니다) |
| 프로젝트 귀속 | 디렉터리 이름이 두 형태입니다. **읽을 수 있는 슬러그**(76개 중 73개가 `~/.gemini/projects.json` 로 실제 경로까지 풀림, 중복 슬러그 0건)와 **64자 해시**(110개 중 sha256 역매핑이 맞는 것은 2개뿐 → 사실상 역매핑 불가). 못 풀리면 `unknown-project` 로 합치지 않고 `gemini:<해시 12자>` 를 식별자로 씁니다 — 합치면 서로 다른 프로젝트 81개가 한 줄이 됩니다 |
| 세션 식별 | 세션 UUID (`.json` 최상위 / `.jsonl` 헤더 줄) |
| 한도 | 로컬에 없음 → `serverQuota = false` |
| 품질 | `local_exact`. 아래 항등식이 깨진 이벤트만 `partial` 로 내리고 값은 보정하지 않습니다 |
| 턴 경계 | **확인됨** — 사람 메시지(`type: 'user'`)가 경계입니다. 경계 앞의 사용량은 0번(경계 미확인) 버킷에 남습니다. 컴팩션 표시는 로그에서 찾지 못해 `compacted` 는 항상 false 입니다 |
| 도구 이름 | **확인됨** — gemini 메시지의 `toolCalls[].name`. 코퍼스에서 70종이 관측됐고 CLI 내장 도구만 단계 표에 넣었습니다(나머지는 MCP·프로젝트 전용이라 `other`) |
| 중복 제거 | `gemini|<message.id>` 로 요청 단위 upsert. 같은 id 가 여러 파일·줄에 다시 나타납니다(`.json` 298건 / `.jsonl` 636건 — resume 사본) |

**토큰 회계 — 예측과 반대였던 두 가지**

전수에서 `input + output + thoughts === total` 이 성립하고 `cached <= input` 입니다
(불일치 0건). 여기서 두 가지가 나옵니다.

1. **`thoughts` 는 `output` 밖에 있습니다.** Codex·Claude 는 `output ⊇ reasoning`
   이라 겹치지 않게 그릴 때 output 에서 reasoning 을 빼야 하는데, Gemini 는
   빼면 안 됩니다 — 빼면 출력 조각이 실제보다 작아지고 조각 합이 total 에
   못 미칩니다. `src/shared.js` 의 `decomposeTokens` 에 이 항등식을 위한 세 번째
   분기가 있습니다.
2. **`cached` 는 `input` 안에 있습니다.** 따라서 회계는 `cache_disjoint` 가 아니라
   Codex 와 같은 **`cache_in_input`** 입니다. 이 문서의 이전 판은 가이드 문구를
   근거로 "input에서 분리(R4)"라고 적었지만 로그가 반대였습니다.

`tool` 은 코퍼스 전체에서 0 이라 total 안인지 밖인지 확인할 수 없었습니다.
그래서 자리를 **가정하지 않고** 값만 그대로 싣습니다. 0 이 아닌 tool 이 나타나면
위 항등식이 깨지고, 그때는 보정 대신 `partial` 등급과 불일치 카운터로 드러납니다.

매핑:

| Gemini 필드 | 공용 필드 |
|---|---|
| input | `inputTokens` (캐시 읽기 **포함**) |
| cached | `cachedInputTokens` (input 안쪽 — 프롬프트 분모에 다시 더하지 않음) |
| output | `outputTokens` (추론 **불포함**) |
| thoughts | `reasoningTokens` |
| tool | `toolTokens` — 예약 필드의 첫 실사용자. total 안의 자리는 미확인 |
| total | `totalTokens` |

읽지 않는 것: 메시지 `content` / `displayContent` / `thoughts` 본문 / `summary`,
`toolCalls` 의 `args`·`result`·`resultDisplay`·`description`, 그리고 같은
디렉터리의 `logs.json`(사용자 프롬프트 원문)과 홈의 `oauth_creds.json`.
도구 인자에서는 경로 키(`file_path` / `absolute_path` / `dir_path` / `path`)만
보고, 저장하는 것은 경로 전체가 아니라 마지막 두 조각입니다.

`.json` 전체 스냅샷 파일을 다루기 위해 파일 기반 커서에 필드를 하나 더 씁니다.

```js
{ provider: 'gemini', sourcePath, byteOffset, contentHash, parserVersion, updatedAt }
```

`parserVersion`을 남기는 이유: Gemini CLI 로그 포맷이 바뀌면 과거 데이터를 재해석해야 하고, 그때 어느 레코드가 어느 파서로 들어왔는지 알아야 합니다.

## 6. 정규화 매핑 요약

| 공용 필드 | Codex | Claude JSONL | Claude OTel | Cursor API | Gemini |
|---|---|---|---|---|---|
| `inputTokens` | `input_tokens` (캐시 포함) | `usage.input_tokens` (캐시 제외) | `type=input` | `tokenUsage.inputTokens` | input |
| `cachedInputTokens` | `cached_input_tokens` | `usage.cache_read_input_tokens` | `type=cacheRead` | `tokenUsage.cacheReadTokens` | cached |
| `cacheWriteInputTokens` | `cache_write_input_tokens` | `usage.cache_creation_input_tokens` | `type=cacheCreation` | `tokenUsage.cacheWriteTokens` | — |
| `outputTokens` | `output_tokens` | `usage.output_tokens` | `type=output` | `tokenUsage.outputTokens` | output |
| `reasoningTokens` | `reasoning_output_tokens` | `usage.output_tokens_details.thinking_tokens` (2.1.228+) | output에 포함 | 없음 | thought |
| `toolTokens` | — | — | — | — | tool |
| `totalTokens` | `total_tokens` | 네 범주 합산 | 합산 | 합산 | total |
| 한도 | `rate_limits` (percent) | 없음 | 없음 | 금액/요청 수 | 없음 |
| 비용 | 추정 | 추정 | `cost.usage` | `chargedCents` (실측) | 추정 |
| `tokenAccounting` | `cache_in_input` | `cache_disjoint` | `cache_disjoint` | `cache_disjoint` | **`cache_in_input`** (실측, §5.4) |

Gemini 칸이 §5.4 와 어긋나 있었습니다. 이 표는 예측을 적어 둔 판이 남아 있었고,
실측은 `cached <= input` 이라 회계가 Codex 와 같습니다 — 같은 문서 안에서 두 값이
갈리면 나중에 읽는 쪽이 표를 믿습니다. 근거는 `service/providers/accounting.mjs`.

`inputTokens`가 provider마다 다른 것을 센다는 점을 표로 못박아 둡니다 — Codex는 캐시 읽기를 input 안에 포함하고 Claude는 포함하지 않습니다. 그래서 캐시 적중률 같은 파생값은 어댑터가 선언한 `tokenAccounting`으로 겹치지 않는 분모를 만들어 계산합니다.

빈 칸은 **0이 아니라 미제공**입니다. 스토어는 0으로 채우지만 `fieldQuality`에서 제외해 UI가 "0 토큰"과 "측정 불가"를 구분할 수 있게 합니다.

## 7. 어댑터 골격

```js
import { UsageProviderAdapter } from '../contracts.mjs';

export class ClaudeCollector extends UsageProviderAdapter {
  constructor({ store, claudeHome = resolveClaudeHome(), reconcileIntervalMs = 5000 }) {
    super({
      id: 'claude',
      name: 'Claude',
      measurement: 'local_observed',
      capabilities: { localLedger: true, serverQuota: false, hooks: true, telemetry: true, credentials: 'none' },
    });
    // ...
  }

  async detect() { /* ~/.claude/projects 존재 확인 */ }
  async discoverFiles() { /* 대화 JSONL 열거 */ }
  async scanFile(filePath, reason) { /* offset tail → parse → upsert → emit('updated') */ }
  async refreshWatchers() { /* 활성 파일 watch */ }
  async reconcile(reason) { /* 놓친 tail 복구 */ }
  getStatus() { /* detected, watching, filesDiscovered, lastError, parserVersion */ }
}
```

Cursor는 파일이 없으므로 `discoverFiles`/`refreshWatchers` 대신 `pollWindow(windowEnd)`와 `rateLimiter`를 갖습니다. 인터페이스 4개 필수 메서드는 동일하게 유지되므로 레지스트리·엔진·API·클라이언트는 손대지 않습니다.

## 8. 상태 보고 규격

`getStatus()`는 provider마다 달라도 되지만, UI가 공통으로 읽는 키를 정합니다.

```js
{
  provider: 'cursor',
  detected: true,             // 설치/설정이 확인됨
  ledgerAvailable: false,     // 토큰 원장을 실제로 얻을 수 있는가
  watching: false,            // 파일 감시 또는 폴링 활성
  lastScanAt: '...',
  lastError: null,            // 사용자에게 보여줄 1줄 메시지 (스택 금지)
  filesDiscovered: 0,         // 파일 기반 provider만
  requestsInWindow: 12,       // API 기반 provider만 (레이트리밋 가시화)
  parserVersion: 3
}
```

## 9. 테스트 요구

provider를 추가할 때 최소 픽스처 테스트 세트:

1. 과거 스캔 — 픽스처 로그 → 기대 토큰 합계
2. 증분 tail — 파일 append 후 재스캔 시 **증분만** 반영
3. 중복 제거 — 같은 요청의 중간/최종 레코드를 순서대로 넣어 **최종값이 남는지** (Claude 필수)
4. 리셋/역행 — 누적 카운터 감소 시 전체값이 사용량으로 잡히지 않는지 (Codex 패턴)
5. 필드 품질 — 빠진 범주가 0이 아니라 미확인으로 남는지
6. 한도 분리 — 백분율이 토큰 테이블에 들어가지 않는지
7. 레이트리밋 — API provider가 상한을 넘겨 호출하지 않는지 (Cursor)
8. 프라이버시 — 프롬프트/응답 텍스트가 SQLite와 HTTP 스냅샷에 나타나지 않는지
9. 턴 경계 — 사람 프롬프트만 턴을 열고 도구 결과는 열지 않는지, 재스캔해도 턴 수가 늘지 않는지, **턴 토큰 합이 세션 토큰 합과 일치**하는지 (`turnLedger: true` 인 provider 필수)
10. 도구 이름/입력 분리 — 도구 **이름**은 DB에 남고 도구 **입력**은 SQLite 바이트에 없는지

기존 Codex 테스트(`test/codex-*.test.mjs`)가 1·2·4·6을 이미 덮습니다. 3·5·7·8은 신규 항목입니다.
