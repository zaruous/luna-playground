import { clampNonNegative, extractSessionIdFromPath, projectNameFromCwd } from '../../utils.mjs';

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

export function createCodexParserState({ filePath, previousUsage = null, session = null } = {}) {
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
      contextWindow: Number(info?.model_context_window ?? info?.modelContextWindow) || null,
    });
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
