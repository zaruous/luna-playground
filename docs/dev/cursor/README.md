# Cursor 로컬 트랙 (M6a) — 진행 플랜

**범위: 원격(Admin API/서버) 사용량은 배제하고, 로컬 토큰량 측정 기준으로 Cursor를
메뉴별 화면에 적용한다.** 이 문서는 그 실행 계획입니다. 실측 근거는
[measurements.md](./measurements.md), 그 위에서 내린 결정은
[decisions.md](./decisions.md)에 있고, 이 문서는 **화면(메뉴) 단위로 무엇이
바뀌는지**를 중심으로 정리합니다.

## 결론 먼저

**정정 (2026-08-25, Phase 0 실행 후).** 처음엔 "로컬에 토큰 수 필드가 없다"고
적었습니다. 표본 12개짜리 1차 조사의 결론이었고, 이진 blob 전체(1,068개)를 실제로
훑자(`scripts/probe-cursor.mjs`) 뒤집혔습니다 — Cursor CLI 로컬 저장소에는 **그 시점
컨텍스트 창의 구성을 카테고리별 토큰 수로 쪼갠 breakdown**이 있고, 카테고리 합이
586개 표본 전부에서 선언된 총합과 정확히 일치합니다. 상세는
[measurements.md](./measurements.md#확인된-것-2차-조사--컨텍스트-구성-breakdown-진짜-토큰-수-필드).

다만 이게 Codex/Claude/Gemini와 **같은 모양의 토큰량은 아닙니다.** 그쪽은 "이
요청이 입력 몇 개·출력 몇 개를 썼나"(요청 단위 델타)이고, Cursor 이 breakdown은
"지금 컨텍스트 창에 시스템 프롬프트/도구/규칙/대화가 각각 몇 토큰씩 들어있나"(구성
스냅샷)입니다. 그래서 이 트랙이 하는 일은 "Cursor도 다른 provider처럼 토큰 막대를
채운다"가 아니라 여전히 **"있는 모양대로, 다른 모양이라고 정직하게 보여준다"**
입니다 — 요청 단위 입력/출력/캐시 델타는 계속 "미제공"이고, 컨텍스트 구성
breakdown은 이제 실측값으로 보여줍니다. 기존 로드맵의 방향과 다른 점, 안 다른 점:

| | 기존 계획(§5.3 / M6 / roadmap Phase 3) | 이 트랙(M6a) |
|---|---|---|
| 1차 데이터 소스 | Admin API(서버) | 로컬 SQLite(IDE + CLI) |
| Personal 계정 로컬 데이터 | "귀속에만 쓰고 과금 근거로 자동 승격 안 함" — **방향은 이미 같았음** | 그 방향을 실제로 구현 |
| 새 인프라 | 자격증명 저장, 레이트리밋, 시간창 커서 | **없음** — 원격 호출이 없어 셋 다 불필요 |
| 화면에 뜨는 것 | 서버 검증 토큰·비용(`chargedCents`) | 요청 수·컨텍스트 구성 breakdown(토큰 실측)·변경 라인·귀속. **요청 단위** 입력/출력/캐시 델타만 "미제공" |

## 무엇을 정직하게 보여줄 수 있는가

| 신호 | 있음? | 어디서 | 화면에서 |
|---|---|---|---|
| 프로젝트 귀속(cwd) | ✅ | `meta.json.cwd`, `composerHeaders.value.workspaceIdentifier`/`trackedGitRepos` | 프로젝트 목록에 Cursor 행 |
| 대화/컴포저 수, 요청 수 | ✅ | `chats/*/store.db` role 카운트, `composerHeaders` 행 수 | 대시보드 카드, 프로젝트 상세 |
| **컨텍스트 구성 breakdown(토큰)** | ✅ 실측(586/586 항등식 일치) | 이진 blob `5.1`(총 토큰)/`5.2`(창 크기)/`5.3.3[]`(카테고리별 토큰) | usage/project에 "컨텍스트 구성" 패널 — 요청 델타 막대와는 분리 |
| 컨텍스트 점유율 | ✅ (백분율, 이제 `5.1/5.2`로 절대값 교차검증됨) | `composerHeaders.value.contextUsagePercent` | 동기화 화면의 "한도류" 자리 |
| 변경 라인 수 | ✅ | `composerHeaders.value.totalLinesAdded/Removed` | 프로젝트 상세 보조 지표 |
| **요청 단위** 입력/출력/캐시 토큰 델타 | ❌ (breakdown은 스냅샷이라 이 모양이 아님) | — | "미제공" 배지. 세션/상세 화면 제외 유지 |
| 턴 경계·입력·출력 분리 | ❌ (미확인 — Phase 0 후속 조사) | `conversation` 카테고리 증가량이 후보이나 미검증 | 세션 흐름·상세 화면에는 이번 단계에서 노출 안 함 |
| 모델명(요청 단위) | 부분 | `ai_code_hashes.model`(코드 diff에 한정) | 있으면 표기, 없으면 "모델 미기록"(기존 관례) |

## 어댑터 파일 지도 (제안)

```
service/providers/cursor/detector.mjs    ~/.cursor/chats · projects, %APPDATA%\Cursor\User\globalStorage 위치 탐색
service/providers/cursor/parser.mjs      composerHeaders/meta.json/blob role 카운트 → 구조 이벤트 (본문 제외)
service/providers/cursor/collector.mjs   content-hash 스냅샷 전략(결정 3) · cursor_local_activity 적재
service/scan-worker.mjs                  전략 디스패치에 cursor:sqlite-snapshot 추가
scripts/probe-cursor.mjs                 Phase 0 조사 스파이크 (측정 전용, 원장에 안 씀)
src/shared.js                            cursorSourceState() — geminiSourceState()와 같은 모양, kind: 'context-snapshot-only'
```

`capabilities`, 신규 테이블, protobuf 조사 방법은 [decisions.md](./decisions.md)에
있습니다. 여기서는 반복하지 않습니다.

## 메뉴별 적용 계획

메뉴 식별자와 현재 상태 표기는 [docs/dev/README.md](../README.md#메뉴별-구현-문서)의
관례를 그대로 따릅니다.

### `dashboard` (대시보드)

- provider 카드가 `planned`(회색, 준비 중)에서 `connected`로 바뀝니다. 토큰 합계
  자리는 다른 provider와 같은 "총 토큰" 숫자가 아니라 `cursorSourceState()`의
  `context-snapshot-only` 라벨과 함께 **마지막 관측 컨텍스트 총 토큰/창 크기**(예:
  "27,766 / 200,000")를 보여줍니다 — 값은 실측이지만 다른 provider의 "총 토큰"과
  같은 의미(요청 델타 누적)가 아니라는 걸 라벨로 구분합니다.
- "최근 프로젝트 발자국"(`getRecentProjectsAcrossProviders`)에는 Cursor 프로젝트도
  `last_activity` 기준으로 섞여 나옵니다.
- 캐시 적중률·요청당 평균처럼 **요청 델타**가 필요한 카드는 Cursor 행에서
  **비웁니다**(0이 아니라 "—") — `accounting: 'context_only'`면 얼리 리턴하도록
  `src/shared.js`에 분기 추가.

### `usage` (AI 사용량)

- 기간별 **토큰 누적 막대 차트**(요청 델타 기반)에는 여전히 **Cursor를 넣지
  않습니다** — 그 차트의 단위(요청이 쓴 입력/출력)와 breakdown의 단위(그 시점
  컨텍스트 구성)가 달라서 같은 막대에 합치면 둘 다 거짓말이 됩니다.
- 대신 이 화면 하단에 별도 패널 **"Cursor — 컨텍스트 구성"**을 추가합니다:
  기간 내 대화별 마지막 관측 breakdown을 카테고리(system_prompt/tools/rules/
  skills/mcp/subagents/summarized_conversation/conversation) 누적 막대로,
  창 크기(200K/256K)를 배경 기준선으로. 기존 `getUsageTimeseries`와는 분리된
  엔드포인트(`GET /api/v1/cursor/context?since&until`)로 — 기존 시계열 응답 모양
  (`tokens: {...}`, 요청 델타 전제)에 스냅샷 성격의 값을 끼워 넣으면 그 계약을
  읽는 모든 코드가 "이 tokens가 델타인지 스냅샷인지"를 다시 물어야 합니다.
- 모델 breakdown 차트에는 Cursor를 여전히 제외(요청 단위 모델별 토큰이 아직 없으므로).

### `project` (프로젝트)

- 프로젝트 목록/상세에 Cursor 세션(컴포저) 수가 추가 열로 나옵니다 — 값은
  `cursor_local_activity`에서.
- 프로젝트 상세의 **요청 델타 "토큰" 카드**에는 Cursor 몫이 **빠집니다**(0으로
  섞지 않음). 대신 "Cursor — 컨텍스트 구성" 보조 카드: 요청 수, 마지막 관측
  breakdown(카테고리별 토큰 미니 막대), 변경 라인.
- 프로젝트 가림(redaction) 규칙은 그대로 적용됩니다 — `cwd`가 가려지면 Cursor
  행도 같은 별칭을 씁니다(기존 `#applyProjectPrivacy` 재사용).

### `session` (세션 흐름)

- **이번 단계에서도 Cursor를 넣지 않습니다** — 다만 이유가 "토큰이 없다"에서
  "있는 토큰이 턴 스냅샷이라 요청 델타 정렬(`ORDER BY total_tokens DESC`)의
  전제와 안 맞는다"로 구체화됐습니다. `conversation` 카테고리의 스냅샷 간
  증가량을 턴 델타로 쓸 수 있는지는 [decisions.md Phase 0 후속 조사](./decisions.md#phase-0--구현-전-조사-스파이크--완료-2026-08-25-후속-조사-남음)
  2·3번이 끝나야 압니다. `session.md`의 기존 문구("Cursor: 불가")는 이 이유로
  갱신합니다.
- provider 필터 칩에는 Cursor가 나타나되 `providerUnavailable()`의
  `context-snapshot-only` 사유로 채워진 안내가 뜹니다.

### `detail` (상세 내역: 프로젝트 → 세션 → 도구 토큰량)

- 이 화면은 요청 단위 토큰량이 전제라 Cursor는 **제외합니다.** `session`과 같은
  이유·같은 재검토 조건을 공유합니다.

### `budget` (동기화)

- provider 상태 카드에 Cursor가 `connected`로 나타나되, Hook 설치 버튼은
  `capabilities.hooks: false`로 자동 숨겨집니다(기존 분기 재사용 — Gemini가 이미
  같은 경로).
- "한도 이력"·"대조 타임라인"은 **서버 대조가 전제**인 화면입니다. Cursor는
  `serverQuota: false`이므로 이 화면에는 안 나타나고, 대신 진단 패널에 한 줄:
  "Cursor — 로컬 전용, 서버 대조 없음. 마지막 관측 컨텍스트:
  {context_total_tokens}/{context_window_tokens} ({contextUsagePercent}%)".

### `alert` (알림)

- 알림 자체가 미구현(M4 후반)이라 이번 트랙에서 새로 만들 것은 없습니다. 나중에
  알림 규칙이 붙을 때도 Cursor는 토큰/한도 임계 규칙 대상에서 자연히 빠집니다
  (그 규칙들이 `tokenLedger`/`serverQuota`를 전제하므로).

### `settings` (설정)

- 기존 M6 계획에 있던 "API 키 입력" UI가 **필요 없어집니다** — 이 트랙은 자격증명을
  저장하지 않습니다. 설정 화면 관점에서는 오히려 작업이 줄어듭니다.
- 데이터 삭제(M7 예정) 범위에 `cursor_local_activity` 테이블만 추가하면 됩니다.

## 단계

```text
Phase 0  probe-cursor.mjs 로 이진 blob 필드 조사 — 완료, breakdown 발견 ─┐
Phase 0b IDE 쪽 재확인 + conversation 델타 검증 (후속 조사, 미완료) ─────┤
                                                                          ├─> Phase 2 detector/parser/collector
Phase 1  cursor_local_activity 스키마 + capabilities 확장 ───────────────┘        + cursorSourceState()
                                                                                       │
Phase 3  메뉴별 화면 반영(위 표) ──────────────────────────────────────────────────────┘
Phase 4  (Phase 0b 가 턴 단위 입출력 분리를 확정하면) 세션 흐름·상세 편입 재검토
```

Phase 0b와 Phase 1은 서로 의존하지 않아 병행 가능합니다. Phase 2는 둘 다 끝나야
시작합니다 — 스키마가 확정돼야 collector가 뭘 적재할지 알고, Phase 0b 결과가 나와야
"breakdown을 스냅샷으로만 쓴다 vs 턴 델타로도 쓴다"를 파서에 확정할 수 있습니다.

## 완료 기준

- [x] `probe-cursor.mjs`가 이진 blob 필드 경로·통계를 출력하고, 토큰류 필드에 대한
      결론(breakdown 발견, 항등식 586/586 일치)이 `measurements.md`에 추가됨
- [ ] IDE 쪽(`cursorDiskKV`)도 같은 breakdown을 주는지 확인 — 1차 실행은 IDE를 켠
      채로 돌려 6행만 잡혔음(잠금 의심), 재확인 필요
- [ ] `conversation` 카테고리 증가량과 실제 턴 경계·입출력 분리 가능 여부 검증
- [ ] `cursor_local_activity`가 같은 파일을 반복 스캔해도 행이 늘지 않음(멱등) —
      `composer_id` PK + upsert, breakdown은 "마지막 관측값 승리"
- [ ] Cursor가 `PROVIDER_CATALOG`에서 `connected`로 승격되고, 대시보드에 provider
      카드가 나타남
- [ ] **요청 델타**를 전제하는 화면(usage 시계열, session, detail)의 어디에도
      Cursor가 나타나지 않음 — breakdown은 그 화면들과 다른 별도 패널에만 나타남
- [ ] `cwd`/`trackedGitRepos` 기반 프로젝트 귀속이 프로젝트 화면에 반영되고,
      가림 설정이 다른 provider와 동일하게 적용됨
- [ ] 응답·SQLite 바이트 어디에도 blob `content`, `cursorAuth/*`, `secret://*` 값이
      없음(센티넬 테스트로 고정 — 기존 privacy test 패턴 재사용). breakdown 파싱은
      카테고리 **키/표시명**(`system_prompt`, "System prompt" 등 고정 어휘)과 숫자만
      읽고, 다른 필드 경로의 문자열은 안 읽습니다
- [ ] Admin API를 호출하는 코드가 이 트랙에 전혀 없음(리뷰 체크리스트 항목) —
      네트워크 호출 자체가 없으므로 레이트리밋 테스트가 필요 없음을 코드로 증명

## 하지 않는 것

[decisions.md의 "하지 않는 것"](./decisions.md#하지-않는-것)과 동일합니다. 요지:
Admin API 호출, 자격증명 저장 UI, 검증되지 않은 델타를 턴 토큰처럼 표시, 대화 본문
저장, 세션 흐름/상세 화면 편입(Phase 0b 전).

## 다른 문서에서의 위치

- [docs/roadmap.md Phase 3](../../roadmap.md)와 [implementation-plan.md
  M6](../implementation-plan.md#m6--cursor-어댑터)은 서버 API 우선 서술을 유지한 채
  이 문서를 M6a로 가리키도록 갱신했습니다 — 기존 결정을 지우지 않고 분기했다는
  기록입니다.
- [docs/dev/README.md](../README.md)의 메뉴별 구현 문서 표에 이 트랙이 언급된
  메뉴(`session`)의 상태 문구는 이유가 갱신됐을 때만 손댑니다(Phase 0 이후).
