import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UsageApiServer } from '../service/api-server.mjs';

class FakeUsageEngine extends EventEmitter {
  constructor() {
    super();
    this.value = 1;
    this.store = { getDiagnostics: () => ({ dbPath: 'test.sqlite3' }) };
  }

  snapshot() {
    return { generatedAt: '2026-08-20T00:00:00.000Z', value: this.value };
  }

  async rescan() {
    this.value += 1;
    const snapshot = this.snapshot();
    this.emit('snapshot', snapshot, { type: 'manual' });
    return snapshot;
  }
}

function snapshotReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next() {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!block.includes('event: snapshot')) continue;
          const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
          return JSON.parse(data);
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE stream ended before a snapshot event');
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
      }
    },
    cancel: () => reader.cancel(),
  };
}

test('HTTP API authenticates commands and SSE streams full snapshots', async () => {
  const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-api-'));
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<html><head></head><body>tracker</body></html>');
  const engine = new FakeUsageEngine();
  const hookCalls = [];
  const hookInstaller = {
    status: async () => ({ installed: false }),
    install: async () => { hookCalls.push('install'); return { installed: true }; },
    uninstall: async () => { hookCalls.push('uninstall'); return { installed: false }; },
  };
  const server = new UsageApiServer({
    usageEngine: engine,
    hookInstaller,
    staticRoot,
    accessToken: 'test-token',
    heartbeatMs: 60_000,
  });
  const baseUrl = await server.start();
  const headers = { 'X-Nyang-Access-Token': 'test-token' };
  const controller = new AbortController();
  let stream;
  try {
    const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal((await fetch(`${baseUrl}/api/v1/snapshot`)).status, 401);

    const page = await fetch(baseUrl).then((response) => response.text());
    assert.match(page, /__NYANG_TRACKER_CONFIG__/);
    assert.match(page, /test-token/);

    const initial = await fetch(`${baseUrl}/api/v1/snapshot`, { headers }).then((response) => response.json());
    assert.equal(initial.value, 1);

    const response = await fetch(`${baseUrl}/api/v1/events?access_token=test-token`, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    stream = snapshotReader(response.body);
    assert.equal((await stream.next()).snapshot.value, 1);

    const rescanned = await fetch(`${baseUrl}/api/v1/rescan`, { method: 'POST', headers }).then((item) => item.json());
    assert.equal(rescanned.value, 2);
    const update = await stream.next();
    assert.equal(update.snapshot.value, 2);
    assert.equal(update.reason.type, 'manual');

    const installed = await fetch(`${baseUrl}/api/v1/providers/codex/hooks`, { method: 'POST', headers }).then((item) => item.json());
    const uninstalled = await fetch(`${baseUrl}/api/v1/providers/codex/hooks`, { method: 'DELETE', headers }).then((item) => item.json());
    assert.equal(installed.installed, true);
    assert.equal(uninstalled.installed, false);
    assert.deepEqual(hookCalls, ['install', 'uninstall']);
  } finally {
    controller.abort();
    await stream?.cancel().catch(() => {});
    await server.stop();
    fs.rmSync(staticRoot, { recursive: true, force: true });
  }
});

test('HTTP API rejects untrusted browser origins before token handling', async () => {
  const server = new UsageApiServer({ usageEngine: new FakeUsageEngine(), accessToken: 'test-token' });
  const baseUrl = await server.start();
  try {
    const response = await fetch(`${baseUrl}/api/v1/snapshot`, {
      headers: { Origin: 'https://untrusted.example', 'X-Nyang-Access-Token': 'test-token' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'origin_not_allowed');
  } finally {
    await server.stop();
  }
});
