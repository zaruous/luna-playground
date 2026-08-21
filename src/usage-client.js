function trimTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

async function responseJson(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function clean(params) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value != null && value !== ''));
}

export function createUsageClient(config, {
  fetchImpl = globalThis.fetch?.bind(globalThis),
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  const transport = config?.transport;
  if (transport?.kind !== 'http-sse' || !transport.baseUrl || !transport.accessToken || !fetchImpl) return null;
  const baseUrl = trimTrailingSlash(transport.baseUrl);
  const accessToken = transport.accessToken;

  async function request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('X-Nyang-Access-Token', accessToken);
    if (init.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return responseJson(await fetchImpl(`${baseUrl}/api/v1${path}`, { ...init, headers }));
  }

  function subscribe(callback, onError) {
    if (typeof callback !== 'function' || !EventSourceImpl) return () => {};
    const url = new URL(`${baseUrl}/api/v1/events`);
    url.searchParams.set('access_token', accessToken);
    const source = new EventSourceImpl(url.toString());
    const onSnapshot = (event) => {
      try {
        const message = JSON.parse(event.data);
        callback(message.snapshot, message.reason ?? null);
      } catch (error) {
        onError?.(error);
      }
    };
    const onStreamError = (event) => onError?.(event);
    source.addEventListener('snapshot', onSnapshot);
    source.addEventListener('error', onStreamError);
    return () => {
      source.removeEventListener?.('snapshot', onSnapshot);
      source.removeEventListener?.('error', onStreamError);
      source.close();
    };
  }

  return {
    platform: config.platform,
    runtime: config.runtime,
    transport: 'http-sse',
    usage: {
      getSnapshot: () => request('/snapshot'),
      rescan: () => request('/rescan', { method: 'POST' }),
      getDiagnostics: () => request('/diagnostics'),
      // 시계열은 스냅샷에 싣지 않고 필터가 바뀔 때만 당깁니다.
      getTimeseries: (params = {}) => request(`/usage/timeseries?${new URLSearchParams(clean(params))}`),
      getModels: (params = {}) => request(`/usage/models?${new URLSearchParams(clean(params))}`),
      getQuotaHistory: (params = {}) => request(`/quota/history?${new URLSearchParams(clean(params))}`),
      subscribe,
    },
    // 세션 흐름. 목록은 기간·provider 로 필터하고, 상세는 세션을 골랐을 때만
    // 당깁니다 — 스냅샷에 싣지 않는 이유는 시계열과 같습니다.
    sessions: {
      list: (params = {}) => request(`/sessions?${new URLSearchParams(clean(params))}`),
      flow: (sessionId, params = {}) => request(`/sessions/${encodeURIComponent(sessionId)}/flow?${new URLSearchParams(clean(params))}`),
    },
    projects: {
      list: (params = {}) => request(`/projects?${new URLSearchParams(clean(params))}`),
      detail: (projectKey, params = {}) => request(`/projects/${projectKey}?${new URLSearchParams(clean(params))}`),
      setAlias: (projectKey, body) => request(`/projects/${projectKey}/alias`, { method: 'PUT', body: JSON.stringify(body) }),
    },
    // provider 별 hook 설치. 경로가 provider id 로 갈리므로 provider 가 늘어도
    // 클라이언트에 분기가 생기지 않습니다.
    hooks: (providerId) => ({
      getHookStatus: () => request(`/providers/${providerId}/hooks`),
      installHooks: () => request(`/providers/${providerId}/hooks`, { method: 'POST' }),
      uninstallHooks: () => request(`/providers/${providerId}/hooks`, { method: 'DELETE' }),
    }),
    codex: {
      getHookStatus: () => request('/providers/codex/hooks'),
      installHooks: () => request('/providers/codex/hooks', { method: 'POST' }),
      uninstallHooks: () => request('/providers/codex/hooks', { method: 'DELETE' }),
    },
    claude: {
      getHookStatus: () => request('/providers/claude/hooks'),
      installHooks: () => request('/providers/claude/hooks', { method: 'POST' }),
      uninstallHooks: () => request('/providers/claude/hooks', { method: 'DELETE' }),
    },
  };
}
