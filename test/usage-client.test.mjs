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

test('품질 배지 헬퍼는 등급을 라벨로 바꾸고 필드별 근거를 함께 낸다', async () => {
  const { aggregateQuality, qualityBadge, qualityFieldSummary } = await import('../src/shared.js');

  // 실제 코퍼스에서 나온 모양: output 은 대부분 추정(구버전), 나머지는 로컬 관측.
  const quality = {
    overall: 'partial',
    fields: {
      inputTokens: { worst: 'partial', counts: { local_exact: 13755, partial: 2 } },
      outputTokens: { worst: 'partial', counts: { partial: 9418, local_exact: 4339 } },
      reasoningTokens: { worst: 'local_exact', counts: { local_exact: 4341 } },
    },
  };

  assert.deepEqual(qualityBadge(quality), { grade: 'partial', label: '추정', tone: 'partial' });
  assert.equal(qualityBadge(null).label, '관측 대기');

  const summary = qualityFieldSummary(quality);
  const input = summary.find((row) => row.field === 'inputTokens');
  // 이벤트 2건 때문에 필드 전체가 "추정"으로 읽히지 않도록 다수 등급을 먼저 씁니다.
  assert.equal(input.grade, 'local_exact');
  assert.equal(input.text, '비캐시 입력 로컬 관측 (추정 2건)');
  const output = summary.find((row) => row.field === 'outputTokens');
  assert.equal(output.grade, 'partial');
  assert.equal(output.text, '출력 추정 (로컬 관측 4,339건)');
  const reasoning = summary.find((row) => row.field === 'reasoningTokens');
  assert.equal(reasoning.text, '추론 로컬 관측');

  // 합계 등급은 데이터가 있는 provider 중 최저치입니다.
  assert.equal(aggregateQuality([
    { totals: { totalTokens: 100 }, quality: { overall: 'local_exact' } },
    { totals: { totalTokens: 200 }, quality: { overall: 'partial' } },
    // 데이터가 없는 provider 는 등급을 끌어내리지 않습니다.
    { totals: { totalTokens: 0 }, quality: { overall: 'unverified' } },
  ]).grade, 'partial');
  assert.equal(aggregateQuality([]).label, '관측 대기');
});
