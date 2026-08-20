import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageClient } from '../src/usage-client.js';

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instance = this;
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  removeEventListener(name) {
    this.listeners.delete(name);
  }

  emit(name, data) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) });
  }

  close() {
    this.closed = true;
  }
}

test('HTTP/SSE client maps REST commands and snapshot events to the UI contract', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ ok: true, url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createUsageClient({
    platform: 'win32',
    runtime: 'browser',
    transport: { kind: 'http-sse', baseUrl: 'http://127.0.0.1:4000/', accessToken: 'secret token' },
  }, { fetchImpl, EventSourceImpl: FakeEventSource });

  await client.usage.getSnapshot();
  await client.usage.rescan();
  await client.codex.installHooks();
  assert.equal(requests[0].url, 'http://127.0.0.1:4000/api/v1/snapshot');
  assert.equal(requests[0].init.headers.get('X-Nyang-Access-Token'), 'secret token');
  assert.equal(requests[1].init.method, 'POST');

  let received;
  const unsubscribe = client.usage.subscribe((snapshot, reason) => { received = { snapshot, reason }; });
  assert.equal(new URL(FakeEventSource.instance.url).searchParams.get('access_token'), 'secret token');
  FakeEventSource.instance.emit('snapshot', { snapshot: { total: 42 }, reason: { type: 'test' } });
  assert.deepEqual(received, { snapshot: { total: 42 }, reason: { type: 'test' } });
  unsubscribe();
  assert.equal(FakeEventSource.instance.closed, true);
});
