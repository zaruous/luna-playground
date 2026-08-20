import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { UsageStore } from '../service/store.mjs';
import { projectKeyOf } from '../service/utils.mjs';

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-agg-'));
  return { root, store: new UsageStore(path.join(root, 'usage.sqlite3')) };
}

function insert(store, { offset = 0, timestamp = '2026-08-20T03:00:00.000Z', model = 'gpt-5-codex', cwd = '/repo/demo', projectName = 'demo', sessionId = 'session-1' } = {}) {
  store.insertUsageEvent({
    type: 'usage',
    provider: 'codex',
    eventTimestamp: timestamp,
    session: { provider: 'codex', sessionId, cwd, projectName, model },
    delta: { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 5, outputTokens: 20, reasoningTokens: 8, totalTokens: 120 },
  }, '/logs/a.jsonl', offset);
}

test('토큰 종류별 합이 provider 총합과 일치한다', () => {
  const { root, store } = makeStore();
  try {
    insert(store, { offset: 0 });
    insert(store, { offset: 1, model: 'gpt-5', timestamp: '2026-08-21T03:00:00.000Z' });

    const totals = store.getProviderTotals('codex');
    const series = store.getUsageTimeseries({ bucket: 'day' }).series;
    const summed = series.reduce((acc, point) => {
      for (const key of Object.keys(acc)) acc[key] += point.tokens[key];
      return acc;
    }, { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 });

    for (const key of Object.keys(summed)) assert.equal(summed[key], totals[key], `${key} 불일치`);

    const models = store.getModelBreakdown({});
    assert.equal(models.totalTokens, totals.totalTokens);
    assert.equal(models.models.length, 2);
    assert.equal(models.models.reduce((sum, row) => sum + row.share, 0).toFixed(6), '1.000000');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('버킷 경계는 UTC가 아니라 로컬 시간대로 끊긴다', () => {
  // 16:30Z 는 KST(+09:00)에서 다음 날 01:30 입니다. UTC로 끊으면 08-20,
  // 로컬로 끊으면 08-21 — 엔진의 startOfLocalMonthIso()와 기준을 맞춥니다.
  const script = `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { UsageStore } from '${path.resolve('service/store.mjs')}';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-tz-'));
    const store = new UsageStore(path.join(root, 'usage.sqlite3'));
    store.insertUsageEvent({
      type: 'usage', provider: 'codex', eventTimestamp: '2026-08-20T16:30:00.000Z',
      session: { provider: 'codex', sessionId: 's', cwd: '/repo/tz', projectName: 'tz', model: 'm' },
      delta: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 11 },
    }, '/l.jsonl', 0);
    const series = store.getUsageTimeseries({ bucket: 'day' }).series;
    process.stdout.write(series[0].bucketStart);
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  `;
  const seoul = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'Asia/Seoul' },
    encoding: 'utf8',
  }).trim();
  assert.equal(seoul, '2026-08-21', 'KST 기준 버킷이어야 합니다');

  const utc = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
  }).trim();
  assert.equal(utc, '2026-08-20', 'UTC 기준 버킷이어야 합니다');
});

test('프로젝트 키는 경로가 아니라 해시이고, 가림이 응답에서 경로를 지운다', () => {
  const { root, store } = makeStore();
  try {
    insert(store, { offset: 0, cwd: '/repo/secret-client', projectName: 'secret-client' });
    const [project] = store.getProjectBreakdown({});
    const key = projectKeyOf('codex', 'secret-client');

    assert.equal(project.projectKey, key);
    assert.match(key, /^[a-f0-9]{16}$/);
    assert.ok(!key.includes('secret'), '키에 원본 경로가 섞이면 안 됩니다');
    assert.equal(project.cwd, '/repo/secret-client');

    store.setProjectAlias({ provider: 'codex', projectKey: key, alias: '고객사 A', redacted: true });

    const payloads = [
      store.getProjectBreakdown({}),
      store.getRecentProjectsAcrossProviders(6),
      store.getProjectDetail({ projectKey: key }),
    ];
    for (const payload of payloads) {
      const serialized = JSON.stringify(payload);
      assert.ok(!serialized.includes('/repo/secret-client'), '가림 후에도 원본 경로가 응답에 남아 있습니다');
      assert.ok(!serialized.includes('secret-client'), '가림 후에도 원본 이름이 응답에 남아 있습니다');
    }
    assert.equal(store.getProjectBreakdown({})[0].name, '고객사 A');
    assert.equal(store.getProjectBreakdown({})[0].redacted, true);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('한도 이력은 percent만 담고 토큰을 섞지 않는다', () => {
  const { root, store } = makeStore();
  try {
    insert(store, { offset: 0 });
    store.insertRateLimits({
      type: 'rate_limits',
      provider: 'codex',
      eventTimestamp: '2026-08-20T03:00:00.000Z',
      session: { provider: 'codex', sessionId: 'session-1' },
      rateLimits: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 21, windowMinutes: 300, resetsAt: 0 } },
    }, '/l.jsonl', 0);
    const { points } = store.getQuotaHistory({ provider: 'codex' });
    assert.equal(points.length, 1);
    assert.equal(points[0].usedPercent, 21);
    assert.equal(points[0].windowMinutes, 300);
    assert.ok(!Object.keys(points[0]).some((key) => /token/i.test(key)), '한도 이력에 토큰 필드가 있으면 안 됩니다');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('누적 막대 분해는 겹치지 않고 합이 총합과 정확히 일치한다', async () => {
  const { decomposeTokens } = await import('../src/shared.js');

  // Codex 회계: cached·cacheWrite ⊆ input, reasoning ⊆ output, total = input + output
  const codexLike = {
    inputTokens: 23641132,
    cachedInputTokens: 20949124,
    cacheWriteInputTokens: 979433,
    outputTokens: 813590,
    reasoningTokens: 448392,
    totalTokens: 24454722,
  };
  const decomposed = decomposeTokens(codexLike);
  assert.equal(decomposed.nested, true);
  const drawn = decomposed.segments.reduce((sum, segment) => sum + segment.value, 0);
  assert.equal(drawn, codexLike.totalTokens, '그려진 조각의 합이 총합과 달라 이중 계상입니다');
  assert.ok(decomposed.segments.every((segment) => segment.value >= 0));

  // 범주를 그대로 쌓으면 두 배 가까이 부풀어 오르는 것을 함께 못박습니다.
  const naive = codexLike.inputTokens + codexLike.cachedInputTokens + codexLike.cacheWriteInputTokens
    + codexLike.outputTokens + codexLike.reasoningTokens;
  assert.ok(naive > codexLike.totalTokens * 1.8, '이 픽스처는 이중 계상을 드러내야 합니다');

  // 항등식이 깨지면 분해를 포기하고 원래 범주를 그대로 씁니다.
  const additive = { inputTokens: 100, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 130 };
  const fallback = decomposeTokens(additive);
  assert.equal(fallback.nested, false);
  assert.equal(fallback.segments.length, 5);
});
