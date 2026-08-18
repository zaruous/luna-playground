import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from '../src/server.js';

async function withServer(run) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('GET /health reports service health', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});

test('GET /api/hello uses Luna as the default name', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hello`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Hello, Luna!' });
  });
});

test('GET /api/hello accepts a name query parameter', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hello?name=Youngjun`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Hello, Youngjun!' });
  });
});

test('unknown routes return JSON 404', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });
});
