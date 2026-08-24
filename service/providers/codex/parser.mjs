import { clampNonNegative, extractSessionIdFromPath, projectNameFromCwd } from '../../utils.mjs';

// 1 = 턴 계산 이전, 2 = 턴 경계·도구 이름을 기록하는 버전.
export const CODEX_PARSER_VERSION = 2;

const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

function normalizeUsage(raw = {}) {
  const inputTokens = clampNonNegative(raw.input_tokens ?? raw.inputTokens);
  const outputTokens = clampNonNegative(raw.output_tokens ?? raw.outputTokens);
  const reportedTotal = raw.total_tokens ?? raw.totalTokens;
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, clampNonNegative(
      raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? raw.cachedInputTokens,
    )),
    cacheWriteInputTokens: clampNonNegative(raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens),
    outputTokens,
    reasoningTokens: clampNonNegative(raw.reasoning_output_tokens ?? raw.reasoningTokens),
    totalTokens: reportedTotal == null ? inputTokens + outputTokens : clampNonNegative(reportedTotal),
  };
}

function usageDelta(current, previous = EMPTY_USAGE) {
  const reset = current.totalTokens < previous.totalTokens
    || current.inputTokens < previous.inputTokens
    || current.outputTokens < previous.outputTokens
    || current.cachedInputTokens < previous.cachedInputTokens
    || current.cacheWriteInputTokens < previous.cacheWriteInputTokens
    || current.reasoningTokens < previous.reasoningTokens;
  if (reset) return { reset: true, usage: null };
  return {
    reset: false,
    usage: {
      inputTokens: current.inputTokens - previous.inputTokens,
      cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
      cacheWriteInputTokens: Math.max(0, current.cacheWriteInputTokens - previous.cacheWriteInputTokens),
      outputTokens: current.outputTokens - previous.outputTokens,
      reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
      totalTokens: current.totalTokens - previous.totalTokens,
    },
  };
}

function sameUsage(left, right) {
  return left.inputTokens === right.inputTokens
    && left.cachedInputTokens === right.cachedInputTokens
    && left.cacheWriteInputTokens === right.cacheWriteInputTokens
    && left.outputTokens === right.outputTokens
    && left.reasoningTokens === right.reasoningTokens
    && left.totalTokens === right.totalTokens;
}

function hasUsage(usage) {
  return Boolean(usage && (
    usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0
    || usage.cachedInputTokens > 0 || usage.reasoningTokens > 0
  ));
}

function looksLikeStaleRegression(current, previous, last) {
  if (!hasUsage(last) || current.totalTokens <= 0 || previous.totalTokens <= 0) return false;
  return current.totalTokens * 100 >= previous.totalTokens * 98
    || current.totalTokens + (last.totalTokens * 2) >= previous.totalTokens;
}

function addUsage(left, right) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function usageEventKey(session, timestamp, increment) {
  if (!timestamp) return null;
  const identity = increment.cumulative ?? increment.usage;
  return [
    'codex', session.forkedFromId ?? session.sessionId, timestamp, session.model ?? '',
    identity.inputTokens, identity.cachedInputTokens, identity.cacheWriteInputTokens,
    identity.outputTokens, identity.reasoningTokens, identity.totalTokens,
  ].join('|');
}

function selectUsageIncrement(info, state) {
  const current = info?.total_token_usage ? normalizeUsage(info.total_token_usage) : null;
  const last = info?.last_token_usage ? normalizeUsage(info.last_token_usage) : null;

  if (current && state.hasPreviousUsage) {
    if (sameUsage(current, state.previousUsage)) return null;
    const delta = usageDelta(current, state.previousUsage);
    if (delta.reset) {
      if (looksLikeStaleRegression(current, state.previousUsage, last)) return null;
      state.previousUsage = current;
      if (!hasUsage(last)) return null;
      return { usage: last, cumulative: current, reset: true, source: 'last_token_usage' };
    }
    state.previousUsage = current;
    const usage = hasUsage(last) ? last : delta.usage;
    if (!hasUsage(usage)) return null;
    return { usage, cumulative: current, reset: false, source: hasUsage(last) ? 'last_token_usage' : 'cumulative_delta' };
  }

  if (current) {
    state.previousUsage = current;
    state.hasPreviousUsage = true;
    const usage = hasUsage(last) ? last : current;
    if (!hasUsage(usage)) return null;
    return { usage, cumulative: current, reset: false, source: hasUsage(last) ? 'last_token_usage' : 'initial_cumulative' };
  }

  if (hasUsage(last)) {
    if (state.hasPreviousUsage) state.previousUsage = addUsage(state.previousUsage, last);
    return { usage: last, cumulative: state.hasPreviousUsage ? state.previousUsage : null, reset: false, source: 'last_token_usage' };
  }

  return null;
}

function normalizeRateWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = Number(raw.used_percent ?? raw.usedPercent);
  if (!Number.isFinite(usedPercent)) return null;
  const windowMinutesRaw = raw.window_minutes ?? raw.windowMinutes;
  const resetsAtRaw = raw.resets_at ?? raw.resetsAt;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes: Number.isFinite(Number(windowMinutesRaw)) ? Number(windowMinutesRaw) : null,
    resetsAt: Number.isFinite(Number(resetsAtRaw)) ? Number(resetsAtRaw) : null,
  };
}

function normalizeRateLimits(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const primary = normalizeRateWindow(raw.primary);
  const secondary = normalizeRateWindow(raw.secondary);
  if (!primary && !secondary) return null;
  return {
    limitId: raw.limit_id ?? raw.limitId ?? 'codex',
    limitName: raw.limit_name ?? raw.limitName ?? null,
    primary,
    secondary,
  };
}

// Codex 는 도구 호출을 response_item 에 담습니다. 이름과 경로만 뽑고
// arguments(payload)는 읽지 않습니다 — Claude 어댑터와 같은 경계입니다.
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call']);

function toolNameFromResponseItem(payload) {
  if (!payload || !TOOL_CALL_TYPES.has(payload.type)) return null;
  return payload.name ?? payload.tool_name ?? payload.type;
}

function sessionMetaFromPayload(payload, filePath) {
  const meta = payload?.meta ?? payload ?? {};
  const git = payload?.git ?? meta?.git ?? null;
  const cwd = meta.cwd ?? payload?.cwd ?? null;
  return {
    provider: 'codex',
    sessionId: meta.id ?? meta.session_id ?? meta.sessionId ?? extractSessionIdFromPath(filePath),
    cwd,
    projectName: projectNameFromCwd(cwd),
    modelProvider: meta.model_provider ?? meta.modelProvider ?? 'openai',
    cliVersion: meta.cli_version ?? meta.cliVersion ?? null,
    source: typeof meta.source === 'string' ? meta.source : meta.originator ?? null,
    forkedFromId: meta.forked_from_id ?? meta.forkedFromId ?? null,
    gitSha: git?.commit_hash ?? git?.commitHash ?? null,
    gitBranch: git?.branch ?? null,
    gitOriginUrl: git?.repository_url ?? git?.repositoryUrl ?? null,
    startedAt: meta.timestamp ?? payload?.timestamp ?? null,
  };
}

export function createCodexParserState({ filePath, previousUsage = null, session = null, turn = null } = {}) {
  return {
    filePath,
    session: session ?? {
      provider: 'codex',
      sessionId: extractSessionIdFromPath(filePath),
      cwd: null,
      projectName: 'unknown-project',
      model: null,
      modelProvider: 'openai',
      cliVersion: null,
      source: null,
      gitSha: null,
      gitBranch: null,
      gitOriginUrl: null,
      startedAt: null,
    },
    previousUsage: previousUsage ? normalizeUsage(previousUsage) : { ...EMPTY_USAGE },
    hasPreviousUsage: Boolean(previousUsage),
    // 턴 추적(docs/dev/menus/session.md). Codex 의 턴 경계는
    // event_msg/user_message 이고, 도구 이름은 response_item 에 있습니다.
    // 파일 중간부터 tail 하면 경계를 모를 수 있어 그럴 땐 0번(경계 미확인)입니다.
    turn: turn ?? { index: 0, startedAt: null, compactedPending: false },
    pendingTools: { toolCounts: {}, touchedPaths: {} },
  };
}

export function parseCodexRolloutLine(line, state) {
  if (!line?.trim()) return [];
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    return [{ type: 'parse_error', reason: 'invalid_json' }];
  }

  const emitted = [];
  const outerTimestamp = item.timestamp ?? item.created_at ?? null;
  const payload = item.payload ?? item.data ?? {};

  if (item.type === 'session_meta') {
    state.session = { ...state.session, ...sessionMetaFromPayload(payload, state.filePath) };
    emitted.push({ type: 'session', session: { ...state.session } });
    return emitted;
  }

  if (item.type === 'turn_context') {
    const cwd = payload.cwd ?? state.session.cwd;
    state.session = {
      ...state.session,
      cwd,
      projectName: projectNameFromCwd(cwd),
      model: payload.model ?? state.session.model ?? null,
    };
    emitted.push({ type: 'session', session: { ...state.session } });
    return emitted;
  }

  // 도구 호출. 이름과 경로만 모아 두고, 다음 token_count 이벤트에 붙입니다
  // — Codex 는 도구 호출과 토큰 기록이 별 레코드라 이렇게 잇습니다.
  if (item.type === 'response_item') {
    const toolName = toolNameFromResponseItem(payload);
    if (toolName) {
      state.pendingTools.toolCounts[toolName] = (state.pendingTools.toolCounts[toolName] ?? 0) + 1;
    }
    return emitted;
  }

  if (item.type === 'event_msg' && payload.type === 'user_message') {
    // 턴 경계 = 사람 프롬프트. payload.message(본문)는 읽지 않습니다.
    state.turn = {
      index: state.turn.index + 1,
      startedAt: outerTimestamp,
      compactedPending: state.turn.compactedPending,
    };
    emitted.push({
      type: 'turn',
      provider: 'codex',
      sessionId: state.session.forkedFromId ?? state.session.sessionId,
      turnIndex: state.turn.index,
      startedAt: state.turn.startedAt,
      compacted: state.turn.compactedPending,
      parserVersion: CODEX_PARSER_VERSION,
    });
    state.turn.compactedPending = false;
    return emitted;
  }

  // 컴팩션. 다음 턴에 표시를 붙여 컨텍스트 곡선의 급락을 설명합니다.
  if (item.type === 'compacted' || (item.type === 'event_msg' && payload.type === 'context_compacted')) {
    state.turn.compactedPending = true;
    return emitted;
  }

  if (item.type !== 'event_msg' || payload.type !== 'token_count') return emitted;

  const info = payload.info ?? null;
  const increment = selectUsageIncrement(info, state);
  if (increment) {
    emitted.push({
      type: 'usage',
      provider: 'codex',
      eventTimestamp: outerTimestamp,
      session: { ...state.session },
      eventKey: usageEventKey(state.session, outerTimestamp, increment),
      delta: increment.usage,
      cumulative: increment.cumulative,
      cumulativeReset: increment.reset,
      incrementSource: increment.source,
      measurementSource: 'local_log',
      measurementQuality: 'local_exact',
      parserVersion: CODEX_PARSER_VERSION,
      contextWindow: Number(info?.model_context_window ?? info?.modelContextWindow) || null,
      // 이 요청이 속한 턴과, 앞선 response_item 들이 부른 도구 이름.
      turnIndex: state.turn.index,
      toolCounts: { ...state.pendingTools.toolCounts },
      touchedPaths: { ...state.pendingTools.touchedPaths },
    });
    // 붙였으면 비웁니다 — 다음 token_count 가 같은 도구를 또 세지 않도록.
    state.pendingTools = { toolCounts: {}, touchedPaths: {} };
  }

  const rateLimits = normalizeRateLimits(payload.rate_limits ?? payload.rateLimits);
  if (rateLimits) {
    emitted.push({
      type: 'rate_limits',
      provider: 'codex',
      eventTimestamp: outerTimestamp,
      session: { ...state.session },
      rateLimits,
    });
  }

  return emitted;
}

export { EMPTY_USAGE, normalizeUsage, normalizeRateLimits, usageDelta, selectUsageIncrement };
