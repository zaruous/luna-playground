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
  return {
    inputTokens: clampNonNegative(raw.input_tokens ?? raw.inputTokens),
    cachedInputTokens: clampNonNegative(raw.cached_input_tokens ?? raw.cachedInputTokens),
    cacheWriteInputTokens: clampNonNegative(raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens),
    outputTokens: clampNonNegative(raw.output_tokens ?? raw.outputTokens),
    reasoningTokens: clampNonNegative(raw.reasoning_output_tokens ?? raw.reasoningTokens),
    totalTokens: clampNonNegative(raw.total_tokens ?? raw.totalTokens),
  };
}

function usageDelta(current, previous = EMPTY_USAGE) {
  const reset = current.totalTokens < previous.totalTokens;
  const base = reset ? EMPTY_USAGE : previous;
  return {
    reset,
    usage: {
      inputTokens: Math.max(0, current.inputTokens - base.inputTokens),
      cachedInputTokens: Math.max(0, current.cachedInputTokens - base.cachedInputTokens),
      cacheWriteInputTokens: Math.max(0, current.cacheWriteInputTokens - base.cacheWriteInputTokens),
      outputTokens: Math.max(0, current.outputTokens - base.outputTokens),
      reasoningTokens: Math.max(0, current.reasoningTokens - base.reasoningTokens),
      totalTokens: Math.max(0, current.totalTokens - base.totalTokens),
    },
  };
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
    limitId: raw.limit_id ?? raw.limitId ?? null,
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
  if (info?.total_token_usage) {
    const currentUsage = normalizeUsage(info.total_token_usage);
    const { usage, reset } = usageDelta(currentUsage, state.previousUsage);
    state.previousUsage = currentUsage;
    if (usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0) {
      emitted.push({
        type: 'usage',
        eventTimestamp: outerTimestamp,
        session: { ...state.session },
        delta: usage,
        cumulative: currentUsage,
        cumulativeReset: reset,
        contextWindow: Number(info.model_context_window ?? info.modelContextWindow) || null,
      });
    }
  }

  const rateLimits = normalizeRateLimits(payload.rate_limits ?? payload.rateLimits);
  if (rateLimits) {
    emitted.push({
      type: 'rate_limits',
      eventTimestamp: outerTimestamp,
      session: { ...state.session },
      rateLimits,
    });
  }

  return emitted;
}

export { EMPTY_USAGE, normalizeUsage, normalizeRateLimits, usageDelta };
