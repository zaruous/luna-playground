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
      subscribe,
    },
    codex: {
      getHookStatus: () => request('/providers/codex/hooks'),
      installHooks: () => request('/providers/codex/hooks', { method: 'POST' }),
      uninstallHooks: () => request('/providers/codex/hooks', { method: 'DELETE' }),
    },
  };
}
