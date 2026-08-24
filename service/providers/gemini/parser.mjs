import path from 'node:path';
import { clampNonNegative, projectNameFromCwd, worstQuality } from '../../utils.mjs';

// v2: 세션 정체를 로그의 sessionId 가 아니라 파일 경로에서 만들고,
//     $set.messages 를 턴 경계로 쓰지 않습니다(둘 다 실측 근거는 아래).
//     버전을 올리면 기존 파일이 전부 재해석돼 잘못 쌓인 턴이 다시 만들어집니다.
export const GEMINI_PARSER_VERSION = 2;

// ── 실측으로 확정한 회계 ────────────────────────────────────────────────────
//
// 개발 머신의 코퍼스를 전수로 재봤습니다.
//   .json  419 파일 / 토큰이 실린 메시지 11,796건
//   .jsonl 386 파일 / 토큰이 실린 줄     1,519건
//
//   input + output + thoughts === total   ← 두 포맷 모두 전수 성립, 불일치 0건
//   cached <= input                       ← 전수 성립 (cached 는 input 안쪽)
//   tool                                  ← 전 코퍼스에서 0, 자리 확인 불가
//
// 여기서 두 가지가 Codex·Claude 와 다릅니다. 둘 다 틀리면 합계가 조용히 어긋
// 나는 지점입니다.
//
//   1) thoughts(추론)가 output **밖**에 있습니다. Codex·Claude 는 output ⊇
//      reasoning 이라 겹치지 않게 그릴 때 output 에서 reasoning 을 빼야 하는데,
//      Gemini 는 빼면 안 됩니다 — 빼면 출력 토큰이 실제보다 작게 나옵니다.
//   2) cached 가 input **안**에 있습니다. 따라서 회계는 Codex 와 같은
//      cache_in_input 입니다. 계획 문서(docs/dev/provider-token-api.md §5.4)는
//      "cached 는 input 에서 분리(R4)"로 예측했지만 로그가 반대였습니다.
//      예측이 아니라 로그를 따릅니다.
//
// tool 은 값이 0 이라 total 안에 있는지 밖에 있는지 알 수 없습니다. 그래서
// 위치를 **가정하지 않고** 값만 그대로 싣습니다. 0 이 아닌 tool 이 나타나면
// 위 항등식이 깨지고, 그때는 보정하지 않고 불일치로 표시합니다.

const PATH_ARG_KEYS = ['file_path', 'absolute_path', 'dir_path', 'path'];

// 파일 이름은 세션 UUID 가 아니라 앞 8자만 담고 있어(session-<시각>-<8자>)
// 세션 식별자로는 쓸 수 없습니다. 다만 헤더를 아직 못 읽은 상태에서 세션
// 행을 만들어야 할 때의 자리표시자로는 유일하고 안정적입니다.
export function geminiFallbackSessionId(filePath) {
  const base = path.basename(String(filePath));
  return base.replace(/\.jsonl?$/i, '') || 'unknown-session';
}

// 도구 이름만 기록합니다. args 에서는 **경로 키만** 봅니다 — command /
// old_string / new_string / content / instruction 은 도구 입력 본문이라 열지
// 않습니다. 경로도 전체가 아니라 마지막 두 조각만 남깁니다(Claude 어댑터와
// 같은 규칙).
export function geminiToolActivity(message) {
  const toolCounts = {};
  const touchedPaths = {};
  const calls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
  for (const call of calls) {
    const name = typeof call?.name === 'string' ? call.name : null;
    if (!name) continue;
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;
    const args = call.args;
    if (!args || typeof args !== 'object') continue;
    let target = null;
    for (const key of PATH_ARG_KEYS) {
      if (typeof args[key] === 'string' && args[key]) { target = args[key]; break; }
    }
    if (!target) continue;
    const suffix = target.split(/[\\/]+/).filter(Boolean).slice(-2).join('/');
    if (suffix) touchedPaths[suffix] = (touchedPaths[suffix] ?? 0) + 1;
  }
  return { toolCounts, touchedPaths };
}

// 로그가 여섯 필드를 항상 채워 보냅니다(실측: 누락 0건). 그래서 기본 등급은
// 전부 local_exact 이고, 실측 계약이 깨진 필드만 partial 로 내립니다.
export function geminiFieldQuality({ cacheInsideInput, identityHolds }) {
  return {
    inputTokens: identityHolds ? 'local_exact' : 'partial',
    cachedInputTokens: cacheInsideInput ? 'local_exact' : 'partial',
    outputTokens: identityHolds ? 'local_exact' : 'partial',
    reasoningTokens: identityHolds ? 'local_exact' : 'partial',
    // 값은 로그가 준 그대로입니다. total 안의 자리만 미확인입니다.
    toolTokens: 'local_exact',
  };
}

function eventQuality(fieldQuality) {
  return Object.values(fieldQuality).reduce((worst, grade) => worstQuality(worst, grade), null) ?? 'local_exact';
}

export function createGeminiParserState({
  filePath,
  projectDirName = null,
  project = null,
  session = null,
  sessionKey = null,
  turn = null,
} = {}) {
  const cwd = project?.cwd ?? null;
  return {
    filePath,
    projectDirName,
    project,
    session: session ?? {
      provider: 'gemini',
      // 로그의 sessionId 는 쓰지 않습니다 — 실측에서 파일 347개가 한 값을
      // 공유했고 UUID 도 아닌 값이 있었습니다. 대화 단위는 파일이므로 경로에서
      // 만든 키가 정체입니다(detector.mjs 의 geminiSessionKey).
      sessionId: sessionKey ?? geminiFallbackSessionId(filePath),
      cwd,
      // 경로를 알면 다른 provider 와 같은 규칙(마지막 경로 조각)으로 이름을
      // 만듭니다. 모르면 디렉터리 이름이 우리가 아는 전부입니다.
      projectName: cwd ? projectNameFromCwd(cwd) : project?.projectName ?? 'unknown-project',
      model: null,
      modelProvider: 'google',
      cliVersion: null,
      source: null,
      gitSha: null,
      gitBranch: null,
      gitOriginUrl: null,
      startedAt: null,
    },
    stats: {
      identityMismatches: 0,
      cacheOutsideInput: 0,
      toolTokensSeen: 0,
      messagesWithoutTokens: 0,
    },
    // 턴 경계는 사람 메시지(type: 'user')입니다. 파일 중간부터 이어 읽으면
    // 경계를 못 봤을 수 있으므로 그럴 때는 0번(경계 미확인) 버킷에 남습니다.
    turn: turn ?? { index: 0, startedAt: null, compactedPending: false },
  };
}

function normalizeUsage(tokens) {
  const input = clampNonNegative(tokens.input);
  const cached = clampNonNegative(tokens.cached);
  const output = clampNonNegative(tokens.output);
  const reasoning = clampNonNegative(tokens.thoughts);
  const tool = clampNonNegative(tokens.tool);
  const total = clampNonNegative(tokens.total);
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    // Gemini 로그에는 캐시 쓰기 필드가 없습니다. 스키마가 숫자를 요구하므로
    // 0 을 넣지만, 등급 표에 키를 두지 않아 "미제공"으로 읽히게 합니다.
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningTokens: reasoning,
    toolTokens: tool,
    totalTokens: total,
  };
}

function applyProjectDirectories(doc, state) {
  const directories = Array.isArray(doc?.directories)
    ? doc.directories.filter((entry) => typeof entry === 'string' && entry)
    : [];
  // 경로가 정확히 하나면 그것이 이 세션의 프로젝트입니다 — 색인(projects.json)
  // 보다 직접적인 근거라 우선합니다. 둘 이상이면 어느 것인지 로그가 말해 주지
  // 않으므로 하나를 고르지 않고 색인 결과를 유지합니다.
  if (directories.length !== 1) return;
  state.session.cwd = directories[0];
  state.session.projectName = projectNameFromCwd(directories[0]);
}

// 두 포맷이 공유하는 메시지 해석. `.json` 의 messages[] 원소와 `.jsonl` 의
// 메시지 줄이 같은 모양입니다(id / timestamp / type / tokens / model / toolCalls).
function messageEvents(message, state) {
  if (!message || typeof message !== 'object') return [];

  if (message.type === 'user') {
    state.turn = {
      index: state.turn.index + 1,
      startedAt: typeof message.timestamp === 'string' ? message.timestamp : null,
      compactedPending: false,
    };
    return [{
      type: 'turn',
      provider: 'gemini',
      sessionId: state.session.sessionId,
      turnIndex: state.turn.index,
      startedAt: state.turn.startedAt,
      // Gemini 로그에서 컴팩션 경계를 가리키는 표시를 찾지 못했습니다.
      // 있는 것처럼 표시하지 않습니다(R7).
      compacted: false,
      parserVersion: GEMINI_PARSER_VERSION,
    }];
  }

  const tokens = message.tokens;
  if (!tokens || typeof tokens !== 'object') {
    if (message.type === 'gemini') state.stats.messagesWithoutTokens += 1;
    return [];
  }

  if (typeof message.model === 'string' && message.model) state.session.model = message.model;

  const usage = normalizeUsage(tokens);
  const identityHolds = usage.inputTokens + usage.outputTokens + usage.reasoningTokens === usage.totalTokens;
  const cacheInsideInput = usage.cachedInputTokens <= usage.inputTokens;
  if (!identityHolds) state.stats.identityMismatches += 1;
  if (!cacheInsideInput) state.stats.cacheOutsideInput += 1;
  if (usage.toolTokens > 0) state.stats.toolTokensSeen += 1;

  const fieldQuality = geminiFieldQuality({ cacheInsideInput, identityHolds });
  const { toolCounts, touchedPaths } = geminiToolActivity(message);
  // 메시지 id 가 전역 중복 제거 키입니다. 실측에서 같은 id 가 여러 파일·여러
  // 줄에 다시 나타났습니다(.json 298건 / .jsonl 636건) — resume 사본입니다.
  const messageId = typeof message.id === 'string' && message.id ? message.id : null;

  return [{
    type: 'usage',
    provider: 'gemini',
    // 누적 스냅샷을 빼는 회계가 아니라 메시지가 이미 요청 단위입니다.
    accounting: 'direct',
    eventTimestamp: typeof message.timestamp === 'string' ? message.timestamp : null,
    session: { ...state.session },
    messageId,
    requestId: null,
    eventKey: messageId ? `gemini|${messageId}` : null,
    delta: usage,
    fieldQuality,
    measurementSource: 'local_log',
    measurementQuality: eventQuality(fieldQuality),
    parserVersion: GEMINI_PARSER_VERSION,
    turnIndex: state.turn.index,
    toolCounts,
    touchedPaths,
    discrepancies: {
      ...(identityHolds ? {} : {
        reportedTotalTokens: usage.totalTokens,
        summedTotalTokens: usage.inputTokens + usage.outputTokens + usage.reasoningTokens,
      }),
      ...(cacheInsideInput ? {} : {
        cachedInputTokens: usage.cachedInputTokens,
        inputTokens: usage.inputTokens,
      }),
    },
  }];
}

// ── 포맷 1: `.json` 문서 스냅샷 ─────────────────────────────────────────────
// 파일이 매번 전체 재작성되므로 바이트 오프셋으로 이어 읽을 수 없습니다.
// 전체를 다시 읽고 메시지 id 로 중복을 걸러냅니다.
export function parseGeminiSessionFile(text, state) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return [{ type: 'parse_error', reason: 'invalid_json' }];
  }
  if (!doc || typeof doc !== 'object') return [{ type: 'parse_error', reason: 'not_an_object' }];

  // doc.sessionId 는 정체로 쓰지 않습니다(위 createGeminiParserState 주석).
  if (typeof doc.startTime === 'string') state.session.startedAt = doc.startTime;
  applyProjectDirectories(doc, state);

  const events = [{ type: 'session', session: { ...state.session } }];
  for (const message of Array.isArray(doc.messages) ? doc.messages : []) {
    events.push(...messageEvents(message, state));
  }
  return events;
}

// ── 포맷 2: `.jsonl` 증분 로그 ──────────────────────────────────────────────
// 줄이 뒤에만 붙으므로 다른 file 기반 provider 와 같은 tail 규칙을 씁니다.
// 줄 종류는 셋입니다.
//   헤더    { sessionId, projectHash, startTime, lastUpdated, kind }
//   메시지  { id, timestamp, type, ... }        ← `.json` 의 messages[] 와 같은 모양
//   패치    { $set: { ... } }
export function parseGeminiLogLine(line, state) {
  if (!line?.trim()) return [];
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return [{ type: 'parse_error', reason: 'invalid_json' }];
  }
  if (!record || typeof record !== 'object') return [];

  if (typeof record.sessionId === 'string' && record.sessionId && typeof record.startTime === 'string') {
    // sessionId 는 정체로 쓰지 않습니다(위 createGeminiParserState 주석).
    state.session.startedAt = record.startTime;
    applyProjectDirectories(record, state);
    return [{ type: 'session', session: { ...state.session } }];
  }

  // $set 은 메타데이터 패치입니다. 여기서는 **아무 이벤트도 만들지 않습니다.**
  //
  // 처음에는 $set.messages 의 사람 메시지를 턴 경계로 받았습니다. 근거는
  // "일반 줄에 한 번도 안 나온 id 가 하나 있다" 였는데, 그 하나를 얻는 대가가
  // 너무 컸습니다 — 실측: $set.messages 안 사람 메시지 1,982건의 **고유 id 는
  // 단 1개**입니다. 같은 프롬프트를 1,982번 다시 적은 것이고, 그때마다 턴
  // 번호를 올리면 턴 경계가 4,869개가 됩니다(실제 고유 프롬프트 2,802개).
  //
  // 토큰은 애초에 여기 실리지 않습니다($set 3,063줄 중 토큰 포함 0건, 그 안의
  // 메시지 객체 1,982개도 키가 content / id / timestamp / type 뿐). 그래서
  // 건너뛰어도 사용량은 하나도 잃지 않습니다.
  if (record.$set) return [];

  return messageEvents(record, state);
}

// `.json` 스냅샷에는 "여기서부터 이어 읽어라"라고 할 바이트 지점이 없어서,
// 사용량 이벤트의 파일 내 순번을 source_offset 으로 씁니다. 메시지는 뒤에만
// 붙으므로 이 순번은 안정적이고, 동일성 판정의 주체는 어차피 event_key
// (메시지 id)입니다 — 순번이 밀려도 합계는 늘지 않습니다.
export function withSourceOffsets(events) {
  const out = [];
  let ordinal = 0;
  for (const event of events) {
    out.push({ event, sourceOffset: ordinal });
    if (event.type === 'usage') ordinal += 1;
  }
  return out;
}
