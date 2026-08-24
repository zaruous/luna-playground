import path from 'node:path';
import { clampNonNegative, projectNameFromCwd, worstQuality } from '../../utils.mjs';

// 파서 버전. 로그 포맷이 바뀌어 해석 규칙을 고치면 올리고, 그 뒤에는 이 버전으로
// 들어온 레코드만 골라 재파싱합니다(docs/dev/store-extensions.md §1).
// 2 = 턴 경계·도구 이름 계산을 시작한 버전. 1 로 읽은 파일은 턴 정보가
// 없어 수집기가 한 번 다시 읽습니다.
export const CLAUDE_PARSER_VERSION = 2;

// ---------------------------------------------------------------------------
// 버전 게이트
//
// docs/claude-code-adapter.md §7 은 "픽스처·근거가 있는 범위에만" 호환성 표를
// 두라고 요구합니다. 아래 두 경계는 이 기계의 실제 로그(2.1.143~2.1.232,
// assistant 레코드 30,777건)에서 확인한 것만 담습니다.
//
//  - output_tokens_details.thinking_tokens 는 2.1.228 부터 등장합니다.
//    그 이전 버전 로그에는 필드 자체가 없어 thinking 이 output 에 포함됐는지
//    확인할 수 없습니다 → output 은 partial, reasoning 은 "미제공"(R7).
//  - input_tokens 는 2.1.143 이상에서 신뢰할 수 있습니다. 조사 문서가 인용한
//    "항목 75%가 0/1 플레이스홀더"는 이 범위에서 재현되지 않습니다
//    (실측 8.9%, 그중 98.8%는 캐시가 프롬프트를 거의 다 흡수한 정상 케이스).
//    범위 밖이거나 버전을 모르면 unverified 로 남깁니다.
export const THINKING_DETAIL_MIN_VERSION = '2.1.228';
export const INPUT_VALIDATED_MIN_VERSION = '2.1.143';

export function compareCliVersion(left, right) {
  if (!left || !right) return null;
  const parse = (value) => String(value).split('.').map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return null;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function atLeast(version, floor) {
  const compared = compareCliVersion(version, floor);
  return compared != null && compared >= 0;
}

function cacheCreationBreakdown(raw = {}) {
  const breakdown = raw.cache_creation ?? raw.cacheCreation ?? null;
  if (!breakdown || typeof breakdown !== 'object') return null;
  const values = Object.entries(breakdown)
    .filter(([key]) => /input_tokens$|InputTokens$/.test(key))
    .map(([, value]) => clampNonNegative(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

// Claude 는 Codex 와 달리 캐시 읽기가 input 밖에 있습니다. Anthropic API 회계로
//   프롬프트 = input(비캐시) + cache_read + cache_creation
// 이므로 min(input, cached) 로 깎으면 캐시 읽기를 통째로 잃습니다. Codex 파서의
// normalizeUsage 를 재사용하면 안 되는 이유가 여기 있습니다.
export function normalizeClaudeUsage(raw = {}) {
  const inputTokens = clampNonNegative(raw.input_tokens ?? raw.inputTokens);
  const cachedInputTokens = clampNonNegative(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens);
  const reportedCacheWrite = clampNonNegative(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens);
  // 상위 cache_creation_input_tokens 와 TTL 내역(cache_creation.ephemeral_*)이
  // 어긋나는 레코드가 있습니다 — 상위가 0 인데 내역은 수백~수천이었습니다
  // (실측 레코드 13건, 중복 제거 후 합계 차이 2,561 토큰). 둘 다 provider 가 쓴 값이므로 더
  // 완전한 쪽을 쓰되, 조용히 바꿔치우지 않고 해당 필드를 partial 로 내리고
  // 불일치 횟수를 수집 상태 카운터에 남깁니다.
  const breakdownCacheWrite = cacheCreationBreakdown(raw);
  const cacheWriteInputTokens = breakdownCacheWrite == null
    ? reportedCacheWrite
    : Math.max(reportedCacheWrite, breakdownCacheWrite);
  const outputTokens = clampNonNegative(raw.output_tokens ?? raw.outputTokens);
  const details = raw.output_tokens_details ?? raw.outputTokensDetails ?? null;
  const hasThinkingDetail = Boolean(details && (details.thinking_tokens != null || details.thinkingTokens != null));
  // thinking 은 output 의 부분 집합입니다(실측 9,176/9,176 건에서 thinking ≤ output).
  const reasoningTokens = hasThinkingDetail
    ? Math.min(outputTokens, clampNonNegative(details.thinking_tokens ?? details.thinkingTokens))
    : 0;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningTokens,
    toolTokens: 0,
    // docs/claude-code-adapter.md §5 의 observed_total. 네 범주는 서로 겹치지
    // 않으므로 그대로 더합니다(reasoning 은 output 안에 있으니 제외).
    totalTokens: inputTokens + cachedInputTokens + cacheWriteInputTokens + outputTokens,
    hasThinkingDetail,
    reportedCacheWriteTokens: reportedCacheWrite,
    breakdownCacheWriteTokens: breakdownCacheWrite,
  };
}

function hasAnyUsage(usage) {
  return usage.inputTokens > 0 || usage.cachedInputTokens > 0
    || usage.cacheWriteInputTokens > 0 || usage.outputTokens > 0;
}

// iterations 는 한 message 안에서 실제로 몇 번 API 를 호출했는지 남깁니다.
// 실측: 상위 usage 는 iterations 의 합이 아니라 **마지막 항목**과 같습니다
// (다중 iteration 9건 전부). 즉 상위 값은 앞선 iteration 의 토큰을 빠뜨립니다.
// 값을 조용히 바꿔치우지 않고(§5) 불일치만 표시합니다.
function iterationDiscrepancy(raw = {}, usage) {
  const iterations = raw.iterations;
  if (!Array.isArray(iterations) || iterations.length < 2) return null;
  const sum = iterations.reduce((acc, iteration) => {
    const normalized = normalizeClaudeUsage(iteration ?? {});
    return {
      inputTokens: acc.inputTokens + normalized.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + normalized.cachedInputTokens,
      cacheWriteInputTokens: acc.cacheWriteInputTokens + normalized.cacheWriteInputTokens,
      outputTokens: acc.outputTokens + normalized.outputTokens,
      totalTokens: acc.totalTokens + normalized.totalTokens,
    };
  }, { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, totalTokens: 0 });
  if (sum.totalTokens <= usage.totalTokens) return null;
  return { iterationCount: iterations.length, iterationsTotalTokens: sum.totalTokens };
}

// 사람이 친 프롬프트인지 판별합니다. 도구 결과(toolUseResult)와 시스템 주입은
// 턴 경계가 아닙니다. 본문을 읽지 않기 위해 문자열 내용은 보지 않고 **모양만**
// 봅니다 — text 문자열인가, 아니면 text 블록이 들어 있는가.
function isHumanPrompt(record) {
  if (record.toolUseResult) return false;
  if (record.message?.role !== 'user') return false;
  const content = record.message.content;
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'text');
}

// 도구 호출의 **이름**과 건드린 파일 경로만 뽑습니다. block.input 은 도구
// payload(명령어·문서 내용)이므로 경로 세 키 외에는 손대지 않습니다
// (docs/dev/menus/session.md 의 경계 표).
//
// 경로는 마지막 단과 그 부모 디렉터리만 남깁니다 — "이 파일을 58번 고쳤다"는
// 인사이트는 지키면서, 전체 절대 경로를 요청마다 저장하지 않기 위해서입니다.
export function toolActivity(record) {
  const toolCounts = {};
  const touchedPaths = {};
  for (const block of record.message?.content ?? []) {
    if (block?.type !== 'tool_use' || !block.name) continue;
    toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1;
    const target = block.input?.file_path ?? block.input?.path ?? block.input?.notebook_path;
    if (typeof target !== 'string' || !target) continue;
    const suffix = target.split(/[\\/]+/).filter(Boolean).slice(-2).join('/');
    if (suffix) touchedPaths[suffix] = (touchedPaths[suffix] ?? 0) + 1;
  }
  return { toolCounts, touchedPaths };
}

// 필드별 신뢰도(R2). "없는 값은 0이 아니라 미확인"이므로(R7) 로그가 주지 않은
// 필드는 키 자체를 넣지 않습니다 — UI 는 키가 없으면 "미제공"으로 읽습니다.
export function claudeFieldQuality({ usage, raw, cliVersion, iterationIssue, cacheWriteIssue }) {
  const quality = {
    cachedInputTokens: 'local_exact',
    cacheWriteInputTokens: cacheWriteIssue ? 'partial' : 'local_exact',
    inputTokens: atLeast(cliVersion, INPUT_VALIDATED_MIN_VERSION) ? 'local_exact' : 'unverified',
  };

  if (usage.hasThinkingDetail) {
    quality.outputTokens = 'local_exact';
    quality.reasoningTokens = 'local_exact';
  } else {
    // thinking 이 output 에 들어 있는지 이 로그로는 증명할 수 없습니다.
    quality.outputTokens = 'partial';
    // reasoningTokens 키를 넣지 않는 것이 "미제공" 표시입니다.
  }

  if (iterationIssue) {
    for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens']) {
      if (quality[field]) quality[field] = worstQuality(quality[field], 'partial');
    }
  }

  if (raw?.cache_read_input_tokens == null && raw?.cacheReadInputTokens == null) delete quality.cachedInputTokens;
  if (raw?.cache_creation_input_tokens == null && raw?.cacheCreationInputTokens == null) delete quality.cacheWriteInputTokens;
  if (raw?.input_tokens == null && raw?.inputTokens == null) delete quality.inputTokens;
  if (raw?.output_tokens == null && raw?.outputTokens == null) delete quality.outputTokens;

  return quality;
}

function eventQuality(fieldQuality) {
  let overall = null;
  for (const grade of Object.values(fieldQuality)) overall = worstQuality(overall, grade);
  return overall ?? 'unverified';
}

// 프로젝트 귀속(docs/claude-code-adapter.md §14): cwd 가 1순위입니다. cwd 가
// 없으면 Claude 의 저장 레이아웃이 만든 디렉터리 이름을 그대로 씁니다 — 경로를
// 되살리려 하지 않습니다(구분자·유니코드가 '-' 로 뭉개져 복원이 불가능합니다).
export function claudeProjectName(cwd, projectDirName) {
  if (cwd) return projectNameFromCwd(cwd);
  const trimmed = String(projectDirName ?? '').trim();
  return trimmed || 'unknown-project';
}

// 세션 파일과 서브에이전트 파일 모두 sessionId 에 **부모 세션 id** 를 담습니다
// (실측). 그래서 서브에이전트 사용량은 부모 세션·프로젝트로 자연히 귀속됩니다.
export function claudeSessionIdFromPath(filePath) {
  const base = path.basename(String(filePath), '.jsonl');
  if (!base.startsWith('agent-')) return base;
  const parts = String(filePath).split(/[\\/]+/);
  const subagentsIndex = parts.lastIndexOf('subagents');
  if (subagentsIndex > 0) return parts[subagentsIndex - 1];
  return base;
}

export function claudeProjectDirName(filePath, projectsRoot) {
  if (!projectsRoot) return null;
  const relative = path.relative(projectsRoot, String(filePath));
  if (!relative || relative.startsWith('..')) return null;
  const [first] = relative.split(/[\\/]+/);
  return first || null;
}

export function createClaudeParserState({ filePath, projectsRoot = null, session = null, turn = null } = {}) {
  const projectDirName = claudeProjectDirName(filePath, projectsRoot);
  return {
    filePath,
    projectsRoot,
    projectDirName,
    // 서브에이전트·워크플로 transcript 는 sessionId 가 부모와 같습니다. 여기서
    // 턴을 세면 메인 대화의 턴 번호와 충돌하므로, 턴은 **메인 transcript 만**
    // 정의합니다. 서브에이전트 요청은 0번(경계 미확인) 버킷으로 갑니다.
    subagentFile: /[\\/]subagents[\\/]/.test(String(filePath)),
    session: session ?? {
      provider: 'claude',
      sessionId: claudeSessionIdFromPath(filePath),
      cwd: null,
      projectName: claudeProjectName(null, projectDirName),
      model: null,
      modelProvider: 'anthropic',
      cliVersion: null,
      source: null,
      gitSha: null,
      gitBranch: null,
      gitOriginUrl: null,
      startedAt: null,
    },
    stats: {
      emptyUsageRecords: 0,
      syntheticRecords: 0,
      iterationDiscrepancies: 0,
      cacheWriteDiscrepancies: 0,
    },
    // 턴 추적(docs/dev/menus/session.md). 경계 이후의 요청은 그 턴에
    // 매달립니다. 파일 중간부터 tail 하면 경계를 모를 수 있으니,
    // 그럴 땐 0번(경계 미확인) 버킷에 남읍니다.
    turn: turn ?? { index: 0, startedAt: null, compactedPending: false },
  };
}

function sessionFromRecord(record, state) {
  const cwd = record.cwd ?? state.session.cwd ?? null;
  return {
    ...state.session,
    sessionId: record.sessionId ?? record.session_id ?? state.session.sessionId,
    cwd,
    projectName: claudeProjectName(cwd, state.projectDirName),
    model: record.message?.model ?? state.session.model ?? null,
    modelProvider: 'anthropic',
    cliVersion: record.version ?? state.session.cliVersion ?? null,
    source: record.entrypoint ?? state.session.source ?? null,
    gitBranch: record.gitBranch ?? state.session.gitBranch ?? null,
    startedAt: state.session.startedAt ?? record.timestamp ?? null,
  };
}

// 같은 요청이 content block 단위로 여러 줄에 걸쳐 기록되고, 세션을 resume 하면
// 이전 transcript 가 새 파일로 복사됩니다. 그래서 중복 제거 키는 파일이 아니라
// **요청**을 가리켜야 합니다 — 파일 단위로 끊으면 실측에서 output 이 8.4%
// 부풀었습니다.
export function claudeEventKey(record) {
  const messageId = record.message?.id ?? null;
  const requestId = record.requestId ?? record.request_id ?? null;
  if (messageId) return `claude|${messageId}|${requestId ?? ''}`;
  if (requestId) return `claude|${requestId}`;
  // 안정적인 id 가 하나도 없으면 레코드 자체의 uuid 로 떨어집니다. 값이 같은
  // 두 요청을 합치지 않기 위해서입니다(§6).
  const uuid = record.uuid ?? null;
  if (uuid) return `claude|uuid:${uuid}`;
  return null;
}

export function parseClaudeTranscriptLine(line, state) {
  if (!line?.trim()) return [];
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return [{ type: 'parse_error', reason: 'invalid_json' }];
  }

  // 컴팩션 경계. 다음 턴에 표시를 붙여 컨텍스트 곡선의 급락 지점을 설명할 수
  // 있게 합니다. 요약문(본문)은 읽지 않습니다.
  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    state.turn.compactedPending = true;
    return [];
  }

  // 턴 경계 = 사람 프롬프트. **존재와 시각만** 쓰고 본문은 건드리지 않습니다.
  if (record.type === 'user') {
    if (!state.subagentFile && isHumanPrompt(record)) {
      // 직전에 컴팩션이 있었다면 그 표시는 **이 턴**에 붙습니다. 새 턴 객체를
      // 만들면서 플래그를 잃지 않도록 먼저 꺼내 둡니다.
      const compacted = state.turn.compactedPending;
      state.turn = {
        index: state.turn.index + 1,
        startedAt: record.timestamp ?? null,
        compactedPending: false,
      };
      return [{
        type: 'turn',
        provider: 'claude',
        sessionId: record.sessionId ?? record.session_id ?? state.session.sessionId,
        turnIndex: state.turn.index,
        startedAt: state.turn.startedAt,
        compacted,
        parserVersion: CLAUDE_PARSER_VERSION,
      }];
    }
    return [];
  }

  // 프롬프트/응답 본문을 담은 레코드는 아예 건드리지 않습니다. 토큰은
  // assistant 레코드에만 붙어 있고, 부모의 toolUseResult 요약(서브에이전트
  // 롤업)은 계상하면 이중 계상이 됩니다(§3.3).
  if (record.type !== 'assistant') return [];

  const usageRaw = record.message?.usage;
  if (!usageRaw || typeof usageRaw !== 'object') return [];

  state.session = sessionFromRecord(record, state);

  // 로컬에서 만들어진 오류 자리표시자입니다. API 응답이 아니라 토큰이 없습니다.
  if (record.message?.model === '<synthetic>' || record.isApiErrorMessage) {
    state.stats.syntheticRecords += 1;
    return [{ type: 'session', session: { ...state.session } }];
  }

  const usage = normalizeClaudeUsage(usageRaw);
  if (!hasAnyUsage(usage)) {
    // 네 범주가 모두 0 이면 측정값이 아니라 "미확인"입니다(R7). 0 토큰 이벤트로
    // 넣으면 resume 복사본이 실측값을 덮을 수도 있습니다.
    state.stats.emptyUsageRecords += 1;
    return [{ type: 'session', session: { ...state.session } }];
  }

  const cacheWriteIssue = usage.breakdownCacheWriteTokens != null
    && usage.breakdownCacheWriteTokens !== usage.reportedCacheWriteTokens;
  const iterationIssue = iterationDiscrepancy(usageRaw, usage);
  if (cacheWriteIssue) state.stats.cacheWriteDiscrepancies += 1;
  if (iterationIssue) state.stats.iterationDiscrepancies += 1;

  const fieldQuality = claudeFieldQuality({
    usage,
    raw: usageRaw,
    cliVersion: state.session.cliVersion,
    iterationIssue,
    cacheWriteIssue,
  });

  const eventKey = claudeEventKey(record);
  const { toolCounts, touchedPaths } = toolActivity(record);

  return [{
    type: 'usage',
    provider: 'claude',
    // Codex 처럼 누적 스냅샷을 빼는 것이 아니라 레코드가 이미 요청 단위입니다.
    // 잘못된 회계 모델이 섞이지 않도록 명시해 둡니다(§4).
    accounting: 'direct',
    eventTimestamp: record.timestamp ?? null,
    session: { ...state.session },
    messageId: record.message?.id ?? null,
    requestId: record.requestId ?? record.request_id ?? null,
    agentId: record.agentId ?? null,
    sidechain: Boolean(record.isSidechain),
    eventKey,
    delta: {
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      toolTokens: usage.toolTokens,
      totalTokens: usage.totalTokens,
    },
    fieldQuality,
    measurementSource: 'local_log',
    measurementQuality: eventQuality(fieldQuality),
    parserVersion: CLAUDE_PARSER_VERSION,
    // 이 요청이 속한 턴과, 그 요청이 부른 도구 이름·건드린 경로.
    //
    // 서브에이전트 transcript 는 부모와 sessionId 가 같지만 어느 부모 턴에서
    // 시작됐는지는 이 파일만 봐서는 알 수 없습니다. 스캔 순서로 아무 턴에
    // 붙이면 거짓이 되므로 0번(경계 미확인) 버킷에 남깁니다 — 부모 턴 연결은
    // agentId 대조가 필요한 후속 과제입니다(docs/dev/menus/session.md).
    turnIndex: state.subagentFile ? 0 : state.turn.index,
    toolCounts,
    touchedPaths,
    discrepancies: {
      ...(iterationIssue ?? {}),
      ...(cacheWriteIssue ? {
        reportedCacheWriteTokens: usage.reportedCacheWriteTokens,
        breakdownCacheWriteTokens: usage.breakdownCacheWriteTokens,
      } : {}),
    },
  }];
}
