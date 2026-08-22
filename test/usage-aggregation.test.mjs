import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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

test('버킷 경계는 UTC가 아니라 로컬 시간대로 끊긴다', (t) => {
  // 16:30Z 는 KST(+09:00)에서 다음 날 01:30 입니다. UTC로 끊으면 08-20,
  // 로컬로 끊으면 08-21 — 엔진의 startOfLocalMonthIso()와 기준을 맞춥니다.
  const script = `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { UsageStore } from '${pathToFileURL(path.resolve('service/store.mjs')).href}';
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
  // SQLite 의 'localtime' 은 C 런타임을 통해 TZ 를 읽습니다. glibc 는 IANA
  // 이름을 이해하지만 Windows msvcrt 는 'KST-9' 스타일만 이해하고
  // 'Asia/Seoul' 은 UTC 로 되돌립니다. 그래서 플랫폼에 맞는 표기를 씁니다.
  const kst = process.platform === 'win32' ? 'KST-9' : 'Asia/Seoul';
  const bucketUnder = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  }).trim();

  const seoul = bucketUnder(kst);
  const utc = bucketUnder('UTC');

  // 이 테스트가 검사하려는 것은 "SQLite 가 로컬 시간대로 끊는가"입니다. 그런데
  // 시간대 데이터가 없는 환경(tzdata 없는 musl 컨테이너 등)에서는 TZ 를 줘도
  // 아무 일이 일어나지 않습니다. 그때는 제품 결함이 아니라 환경 한계이므로
  // 가짜 실패를 만들지 않고 건너뜁니다 — 두 값이 같다는 것이 그 신호입니다.
  if (seoul === utc) {
    t.skip(`이 환경에서는 TZ 가 SQLite localtime 에 반영되지 않습니다 (둘 다 ${seoul})`);
    return;
  }

  assert.equal(seoul, '2026-08-21', 'KST 기준 버킷이어야 합니다');
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

test('"최근" 프로젝트 목록은 토큰이 아니라 마지막 활동 순이다', () => {
  const { root, store } = makeStore();
  try {
    // 오래됐지만 큰 프로젝트(120 x 3) 대 오늘 만진 작은 프로젝트(120). offset 과
    // timestamp 를 모두 다르게 줘야 event_key 중복 판정에 삼켜지지 않습니다.
    insert(store, { offset: 0, timestamp: '2026-08-01T03:00:00.000Z', cwd: '/repo/big-old', projectName: 'big-old', sessionId: 'session-old' });
    insert(store, { offset: 1, timestamp: '2026-08-01T04:00:00.000Z', cwd: '/repo/big-old', projectName: 'big-old', sessionId: 'session-old' });
    insert(store, { offset: 2, timestamp: '2026-08-01T05:00:00.000Z', cwd: '/repo/big-old', projectName: 'big-old', sessionId: 'session-old' });
    insert(store, { offset: 3, timestamp: '2026-08-20T09:00:00.000Z', cwd: '/repo/fresh', projectName: 'fresh', sessionId: 'session-new' });

    for (const projects of [store.getRecentProjectsAcrossProviders(6), store.getRecentProjects('codex')]) {
      assert.equal(projects[0].name, 'fresh', '"최근" 패널의 첫 행은 마지막 활동이 가장 최신인 프로젝트여야 합니다');
      assert.equal(projects[1].name, 'big-old', '크고 오래된 프로젝트가 최신 프로젝트를 밀어내면 안 됩니다');
      // 이 픽스처가 두 정렬을 실제로 갈라놓는지 함께 못박습니다. 토큰 순이면 순서가 뒤집힙니다.
      assert.ok(projects[1].totalTokens > projects[0].totalTokens, '픽스처가 토큰 순과 활동 순을 구분하지 못합니다');
    }

    // 프로젝트 화면은 일부러 토큰 순으로 남깁니다 — 두 화면의 정렬이 다른 것이 의도입니다.
    assert.equal(store.getProjectBreakdown({})[0].name, 'big-old');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('마지막 활동이 동률이면 토큰이 아니라 그룹 키 순으로 갈린다', () => {
  // 같은 초에 마지막 이벤트가 찍힌 세 프로젝트. 큰 쪽 이름을 뒤에 둬서 토큰 순
  // 정렬로 되돌아가면 기대 순서가 통째로 뒤집히게 만든 픽스처입니다.
  const rows = [
    { offset: 0, timestamp: '2026-08-20T07:00:00.000Z', cwd: '/repo/zz-big', projectName: 'zz-big', sessionId: 'session-big' },
    { offset: 1, timestamp: '2026-08-20T08:00:00.000Z', cwd: '/repo/zz-big', projectName: 'zz-big', sessionId: 'session-big' },
    { offset: 2, timestamp: '2026-08-20T09:00:00.000Z', cwd: '/repo/zz-big', projectName: 'zz-big', sessionId: 'session-big' },
    { offset: 3, timestamp: '2026-08-20T09:00:00.000Z', cwd: '/repo/aa-small', projectName: 'aa-small', sessionId: 'session-small' },
  ];
  // 넣는 순서를 뒤집어도 같은 목록이어야 합니다. SQLite 가 지금은 우연히 그룹 키
  // 순으로 내주기도 하지만 그건 실행 계획이 바뀌면 사라지는 순서라, 여기서
  // 못박는 것은 그 우연이 아니라 쿼리가 ORDER BY 로 약속한 순서입니다.
  for (const ordered of [rows, [...rows].reverse()]) {
    const { root, store } = makeStore();
    try {
      for (const row of ordered) insert(store, row);
      // provider 동률도 함께 못박습니다. 같은 이름이 두 provider 에 있는 것은
      // 한 저장소를 두 CLI 로 만졌을 때 그대로 생깁니다.
      store.upsertUsageEvent({
        type: 'usage', provider: 'claude', eventTimestamp: '2026-08-20T09:00:00.000Z',
        session: { provider: 'claude', sessionId: 'session-claude', cwd: '/repo/aa-small', projectName: 'aa-small', model: 'claude-opus-5' },
        eventKey: 'claude|msg_tie|req_tie',
        delta: { inputTokens: 10, cachedInputTokens: 30, cacheWriteInputTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 50 },
      }, '/claude.jsonl', 0);

      assert.deepEqual(
        store.getRecentProjectsAcrossProviders(6).map((project) => `${project.provider}|${project.name}`),
        ['claude|aa-small', 'codex|aa-small', 'codex|zz-big'],
      );

      const projects = store.getRecentProjects('codex');
      assert.deepEqual(projects.map((project) => project.name), ['aa-small', 'zz-big']);
      assert.equal(projects[0].lastActivity, projects[1].lastActivity, '픽스처가 동률을 만들지 못했습니다');
      assert.ok(projects[1].totalTokens > projects[0].totalTokens, '토큰 순이면 순서가 뒤집히는 픽스처여야 합니다');
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  // 실제 Codex 회계(ccusage 대조로 확인): input = 비캐시 + 캐시읽기,
  // total = input + output, 캐시 쓰기는 total 밖.
  const codexLike = {
    inputTokens: 906093,
    cachedInputTokens: 817671,
    cacheWriteInputTokens: 34582,
    outputTokens: 53297,
    reasoningTokens: 28188,
    totalTokens: 959390,
  };
  const decomposed = decomposeTokens(codexLike);
  assert.equal(decomposed.nested, true);

  const drawn = decomposed.segments.reduce((sum, segment) => sum + segment.value, 0);
  assert.equal(drawn, codexLike.totalTokens, '그려진 조각의 합이 총합과 달라 이중 계상입니다');
  assert.ok(decomposed.segments.every((segment) => segment.value >= 0));

  // 비캐시 입력은 input - cached 여야 합니다(캐시 쓰기를 빼면 안 됩니다).
  const uncached = decomposed.segments.find((segment) => segment.key === 'inputTokens');
  assert.equal(uncached.value, codexLike.inputTokens - codexLike.cachedInputTokens);

  // 캐시 쓰기는 total 밖이므로 스택이 아니라 extras 로 나옵니다.
  assert.ok(!decomposed.segments.some((segment) => segment.key === 'cacheWriteInputTokens'));
  assert.equal(decomposed.extras[0].value, codexLike.cacheWriteInputTokens);

  // 범주를 그대로 쌓으면 두 배 가까이 부풀어 오르는 것을 함께 못박습니다.
  const naive = codexLike.inputTokens + codexLike.cachedInputTokens + codexLike.cacheWriteInputTokens
    + codexLike.outputTokens + codexLike.reasoningTokens;
  assert.ok(naive > codexLike.totalTokens * 1.8, '이 픽스처는 이중 계상을 드러내야 합니다');

  // Claude 회계는 다릅니다(ccusage 대조로 확인): input 은 비캐시 입력만이고
  // 캐시 읽기·쓰기가 input 밖에 있으며 total 안에 들어옵니다. 아래 값은 실제
  // 로컬 코퍼스(214 파일, 요청 13,757건)의 합계입니다.
  const claudeLike = {
    inputTokens: 280935,
    cachedInputTokens: 3933470648,
    cacheWriteInputTokens: 60164572,
    outputTokens: 13353519,
    reasoningTokens: 1680934,
    totalTokens: 4007269674,
  };
  const claudeDecomposed = decomposeTokens(claudeLike);
  assert.equal(claudeDecomposed.nested, true);
  assert.equal(
    claudeDecomposed.segments.reduce((sum, segment) => sum + segment.value, 0),
    claudeLike.totalTokens,
    '그려진 조각의 합이 총합과 달라 이중 계상입니다',
  );
  assert.ok(claudeDecomposed.segments.every((segment) => segment.value >= 0));
  // 캐시가 input 밖이므로 비캐시 입력에서 캐시를 빼지 않습니다.
  assert.equal(
    claudeDecomposed.segments.find((segment) => segment.key === 'inputTokens').value,
    claudeLike.inputTokens,
  );
  // 캐시 쓰기는 total 안이므로 extras 가 아니라 조각으로 쌓입니다.
  assert.equal(
    claudeDecomposed.segments.find((segment) => segment.key === 'cacheWriteInputTokens').value,
    claudeLike.cacheWriteInputTokens,
  );
  assert.equal(claudeDecomposed.extras.length, 0);
  // 추론은 출력 안에 있으므로 출력 조각에서 빼고 따로 쌓습니다.
  assert.equal(
    claudeDecomposed.segments.find((segment) => segment.key === 'outputTokens').value,
    claudeLike.outputTokens - claudeLike.reasoningTokens,
  );

  // 아는 항등식이 하나도 안 맞으면 분해를 포기하고 원래 범주를 그대로 씁니다.
  const unknownShape = { inputTokens: 100, cachedInputTokens: 10, cacheWriteInputTokens: 5, outputTokens: 20, reasoningTokens: 0, totalTokens: 999 };
  const fallback = decomposeTokens(unknownShape);
  assert.equal(fallback.nested, false);
  assert.equal(fallback.segments.length, 5);
});

test('회계가 다른 provider 를 섞어도 캐시 적중률 분모가 겹치지 않는다', async () => {
  const { UsageEngine } = await import('../service/engine.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-mixed-'));
  const engine = new UsageEngine({
    userDataPath: root,
    codexHome: path.join(root, 'no-codex'),
    claudeHomes: [path.join(root, 'no-claude')],
  });
  try {
    // Codex: cached ⊆ input, total = input + output
    engine.store.insertUsageEvent({
      type: 'usage', provider: 'codex', eventTimestamp: new Date().toISOString(),
      session: { provider: 'codex', sessionId: 'cx-1', cwd: '/repo/a', projectName: 'a', model: 'gpt-test' },
      delta: { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 50, outputTokens: 200, reasoningTokens: 0, totalTokens: 1200 },
    }, '/codex.jsonl', 0);
    // Claude: cached ∩ input = ∅, total = input + cached + cacheWrite + output
    engine.store.upsertUsageEvent({
      type: 'usage', provider: 'claude', eventTimestamp: new Date().toISOString(),
      session: { provider: 'claude', sessionId: 'cl-1', cwd: '/repo/b', projectName: 'b', model: 'claude-opus-5' },
      eventKey: 'claude|msg_mix|req_mix',
      delta: { inputTokens: 10, cachedInputTokens: 9000, cacheWriteInputTokens: 500, outputTokens: 300, reasoningTokens: 100, toolTokens: 0, totalTokens: 9810 },
      fieldQuality: { inputTokens: 'local_exact', cachedInputTokens: 'local_exact', outputTokens: 'local_exact', reasoningTokens: 'local_exact' },
      measurementQuality: 'local_exact',
    }, '/claude.jsonl', 0);

    const snapshot = engine.snapshot();
    const codex = snapshot.providers.find((provider) => provider.id === 'codex');
    const claude = snapshot.providers.find((provider) => provider.id === 'claude');

    assert.equal(codex.tokenAccounting, 'cache_in_input');
    assert.equal(claude.tokenAccounting, 'cache_disjoint');
    // 프롬프트 쪽 토큰: Codex 는 input 이 캐시를 포함하므로 input + 캐시쓰기,
    // Claude 는 캐시가 밖이므로 input + 캐시읽기 + 캐시쓰기.
    assert.equal(codex.totals.promptTokens, 1000 + 50);
    assert.equal(claude.totals.promptTokens, 10 + 9000 + 500);
    assert.equal(snapshot.totals.promptTokens, 1050 + 9510);

    // 옛 정의(cached / input)라면 9800/1010 = 970% 가 나왔습니다.
    assert.equal(snapshot.totals.cacheRate, 9800 / 10560);
    assert.ok(snapshot.totals.cacheRate <= 1, '캐시 적중률이 100%를 넘었습니다 — 분모가 겹칩니다');
  } finally {
    await engine.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
