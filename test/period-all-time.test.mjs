// "전체 기간"이 화면에서 실제로 전체 기간이어야 합니다.
//
// 이 버그는 세 층이 각자 다른 가정을 해서 생겼고, 그래서 테스트도 세 층을 함께
// 봅니다.
//   1) 뷰      period 'all' → since = null 을 뜻한다고 생각했다
//   2) 전송     null 파라미터를 쿼리에서 지운다 (src/usage-client.js 의 clean)
//   3) 서버     since 가 없으면 이번 달로 되돌린다 (?? defaultSince())
// 결과: '전체' 버튼이 조용히 이번 달로 동작했고, 지난달까지만 쓴 provider 의
// 기록은 화면의 어느 경로로도 볼 수 없었습니다(Gemini 어댑터를 붙이고 드러남).
//
// 한 층만 고치면 다시 어긋나므로 계약을 양쪽에서 못박습니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UsageStore } from '../service/store.mjs';
import { UsageApiServer } from '../service/api-server.mjs';
import { createUsageClient } from '../src/usage-client.js';

const THIS_MONTH_START = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
// 이번 달보다 확실히 이전인 시각. 아래 픽스처의 "옛 기록"입니다.
const LONG_AGO = '2025-03-04T05:06:07.000Z';
const RECENT = new Date().toISOString();

function usageEvent({ sessionId, provider, project, timestamp, total }) {
  return {
    type: 'usage',
    provider,
    session: { provider, sessionId, cwd: `/repo/${project}`, projectName: project, model: 'm-1' },
    eventTimestamp: timestamp,
    delta: {
      inputTokens: total - 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      toolTokens: 0,
      totalTokens: total,
    },
  };
}

// API 서버는 usageEngine 에서 store 와 defaultSince 만 씁니다.
class StoreBackedEngine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.calls = [];
  }

  defaultSince() {
    return THIS_MONTH_START;
  }

  snapshot() {
    return { generatedAt: RECENT };
  }
}

async function withServer(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-period-'));
  const store = new UsageStore(path.join(dir, 'usage.sqlite3'));
  // 옛 provider: 기록이 전부 이번 달 이전입니다(Gemini 가 실제로 그랬습니다).
  store.insertUsageEvent(usageEvent({ sessionId: 'old-1', provider: 'gemini', project: 'legacy-app', timestamp: LONG_AGO, total: 5000 }), '/logs/old.json', 0);
  // 최근 provider: 이번 달에 활동이 있습니다.
  store.insertUsageEvent(usageEvent({ sessionId: 'new-1', provider: 'codex', project: 'current-app', timestamp: RECENT, total: 700 }), '/logs/new.jsonl', 0);

  const engine = new StoreBackedEngine(store);
  const server = new UsageApiServer({ usageEngine: engine, host: '127.0.0.1', port: 0 });
  const baseUrl = await server.start();
  const get = async (query) => {
    const response = await fetch(`${baseUrl}/api/v1${query}`, {
      headers: { 'X-Nyang-Access-Token': server.accessToken },
    });
    assert.equal(response.status, 200, `${query} 가 200 이어야 합니다`);
    return response.json();
  };
  try {
    await run({ get, store });
  } finally {
    await server.stop();
    store.close();
  }
}

test('since 를 생략하면 이번 달로 좁힌다 — 기본값은 그대로 보호막이다', async () => {
  await withServer(async ({ get }) => {
    const sessions = await get('/sessions?limit=10');
    assert.deepEqual(sessions.sessions.map((row) => row.projectName), ['current-app'],
      '생략하면 이번 달만 — 실수로 전 구간을 훑지 않게 하는 기본값입니다');

    const projects = await get('/projects?limit=10');
    assert.deepEqual(projects.projects.map((row) => row.name), ['current-app']);

    const models = await get('/usage/models');
    assert.equal(models.models.reduce((sum, row) => sum + row.tokens.totalTokens, 0), 700);
  });
});

test('all 플래그를 켜면 이번 달 이전 기록까지 함께 나온다', async () => {
  await withServer(async ({ get }) => {
    const sessions = await get('/sessions?limit=10&all=1');
    assert.deepEqual(
      sessions.sessions.map((row) => row.projectName).sort(),
      ['current-app', 'legacy-app'],
      'all=1 이면 옛 기록도 나와야 합니다',
    );

    const projects = await get('/projects?limit=10&all=1');
    assert.deepEqual(projects.projects.map((row) => row.name).sort(), ['current-app', 'legacy-app']);

    const models = await get('/usage/models?all=1');
    assert.equal(models.models.reduce((sum, row) => sum + row.tokens.totalTokens, 0), 5700);

    const series = await get('/usage/timeseries?bucket=month&all=1');
    assert.equal(series.series.length, 2, '옛 달과 이번 달 두 버킷이 나와야 합니다');
  });
});

test('all 이 켜지면 함께 온 since 는 무시한다 — 더 넓은 쪽이 의도다', async () => {
  await withServer(async ({ get }) => {
    const narrowed = await get(`/sessions?limit=10&since=${encodeURIComponent(THIS_MONTH_START)}`);
    assert.deepEqual(narrowed.sessions.map((row) => row.projectName), ['current-app']);

    const widened = await get(`/sessions?limit=10&all=1&since=${encodeURIComponent(THIS_MONTH_START)}`);
    assert.equal(widened.sessions.length, 2, 'all=1 이 since 를 이겨야 합니다');
  });
});

test('all 플래그가 아닌 값은 기본값을 바꾸지 않는다', async () => {
  await withServer(async ({ get }) => {
    for (const value of ['0', 'false', '', 'nope']) {
      const result = await get(`/sessions?limit=10&all=${encodeURIComponent(value)}`);
      assert.deepEqual(result.sessions.map((row) => row.projectName), ['current-app'],
        `all=${JSON.stringify(value)} 는 전체 기간을 뜻하지 않습니다`);
    }
  });
});

test('전송 계층은 null since 를 지우고 all 플래그는 남긴다', () => {
  // 이 버그의 두 번째 층입니다. 뷰가 null 을 보내도 쿼리에서 사라지므로,
  // '전체'는 별도 플래그로 말해야 합니다.
  const urls = [];
  const client = createUsageClient(
    { platform: 'test', runtime: 'browser', transport: { kind: 'http-sse', baseUrl: 'http://127.0.0.1:1', accessToken: 't' } },
    {
      fetchImpl: async (url) => {
        urls.push(String(url));
        return { ok: true, json: async () => ({ sessions: [] }) };
      },
      EventSourceImpl: class {},
    },
  );

  client.sessions.list({ since: null, all: 1, provider: null, limit: 40 });
  const query = urls[0].split('?')[1] ?? '';
  assert.ok(!query.includes('since='), 'null since 는 쿼리에서 지워집니다');
  assert.ok(!query.includes('provider='), 'null provider 도 지워집니다');
  assert.ok(query.includes('all=1'), '전체 기간 플래그는 전선에 실려야 합니다');
  assert.ok(query.includes('limit=40'));

  urls.length = 0;
  client.sessions.list({ since: '2026-01-01T00:00:00.000Z', all: null, limit: 10 });
  const narrowed = urls[0].split('?')[1] ?? '';
  assert.ok(narrowed.includes('since=2026-01-01'), '명시한 since 는 그대로 실립니다');
  assert.ok(!narrowed.includes('all='), 'all 이 null 이면 지워집니다');
});
