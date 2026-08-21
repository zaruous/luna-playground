import { EventEmitter } from 'node:events';

export const PROVIDER_CATALOG = Object.freeze([
  Object.freeze({ id: 'codex', name: 'Codex', order: 10, integration: 'connected' }),
  Object.freeze({ id: 'claude', name: 'Claude', order: 20, integration: 'planned' }),
  Object.freeze({ id: 'cursor', name: 'Cursor', order: 30, integration: 'planned' }),
  Object.freeze({ id: 'gemini', name: 'Gemini', order: 40, integration: 'planned' }),
]);

const REQUIRED_METHODS = ['start', 'stop', 'reconcile', 'getStatus'];

export function assertProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('Provider adapter is required');
  if (!adapter.id || typeof adapter.id !== 'string') throw new TypeError('Provider adapter id is required');
  if (!adapter.name || typeof adapter.name !== 'string') throw new TypeError(`Provider ${adapter.id} name is required`);
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`Provider ${adapter.id} must implement ${method}()`);
    }
  }
  if (typeof adapter.on !== 'function') throw new TypeError(`Provider ${adapter.id} must emit lifecycle events`);
  return adapter;
}

export class UsageProviderAdapter extends EventEmitter {
  constructor({ id, name, measurement = 'local_observed', capabilities = {} }) {
    super();
    this.id = id;
    this.name = name;
    this.measurement = measurement;
    this.capabilities = Object.freeze({
      localLedger: false,
      serverQuota: false,
      hooks: false,
      ...capabilities,
    });
  }

  async start() {}

  stop() {}

  // 전량 스캔(백필)과 주기 감시를 따로 켤 수 있게 열어 둡니다. 서버는 화면을
  // 먼저 띄우고 백필을 뒤에서 돌리므로 이 둘의 시점이 갈립니다.
  async backfill() {
    return { changed: false, files: 0 };
  }

  startWatching() {}

  async reconcile() {
    return { changed: false };
  }

  getStatus() {
    return { provider: this.id, detected: false };
  }
}

export class UsageProviderRegistry extends EventEmitter {
  constructor({ adapters = [], catalog = PROVIDER_CATALOG } = {}) {
    super();
    this.catalog = [...catalog].sort((a, b) => a.order - b.order);
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    assertProviderAdapter(adapter);
    if (this.adapters.has(adapter.id)) throw new Error(`Provider ${adapter.id} is already registered`);
    this.adapters.set(adapter.id, adapter);
    adapter.on('updated', (event) => this.emit('updated', { provider: adapter.id, ...event }));
    adapter.on('hook', (event) => this.emit('hook', { provider: adapter.id, ...event }));
    adapter.on('error-state', (event) => this.emit('error-state', { provider: adapter.id, ...event }));
    return adapter;
  }

  get(id) {
    return this.adapters.get(id) ?? null;
  }

  list() {
    return [...this.adapters.values()];
  }

  async startAll(options = {}) {
    for (const adapter of this.list()) await adapter.start(options);
  }

  stopAll() {
    for (const adapter of this.list()) adapter.stop();
  }

  async reconcileAll(reason = 'manual') {
    const results = [];
    for (const adapter of this.list()) {
      results.push({ provider: adapter.id, ...(await adapter.reconcile(reason)) });
    }
    return results;
  }

  describe() {
    return this.catalog.map((definition) => {
      const adapter = this.get(definition.id);
      return {
        ...definition,
        integration: adapter ? 'connected' : definition.integration,
        measurement: adapter?.measurement ?? null,
        capabilities: adapter?.capabilities ?? null,
        collector: adapter?.getStatus() ?? { provider: definition.id, detected: false, watching: false },
      };
    });
  }
}
