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

// Cursor 는 usage_events 에 행이 없습니다(docs/dev/cursor/decisions.md 결정 4) —
// cursor_local_activity 로만 들어옵니다. getRecentProjectsAcrossProviders 는 이
// 테이블을 UNION 으로 더해 같은 프로젝트 목록에 섞습니다.
function cursorEvent({
  composerId = 'composer-1', surface = 'cli', cwd = '/repo/cursor-proj', projectName = 'cursor-proj',
  lastUpdatedAt = '2026-08-20T10:00:00.000Z', requestCount = 3, linesAdded = null, linesRemoved = null,
  contextUsagePercent = null, contextTotalTokens = 5000, contextWindowTokens = 200000,
  contextBreakdown = { conversation: 5000 },
} = {}) {
  return {
    composerId, surface, workspaceId: null, cwd, projectName,
    createdAt: lastUpdatedAt, lastUpdatedAt,
    requestCount, linesAdded, linesRemoved,
    contextUsagePercent, contextTotalTokens, contextWindowTokens,
    contextBreakdown, parserVersion: 1,
  };
}

test('최근 프로젝트 목록에는 Cursor 도 마지막 활동 기준으로 섞인다', () => {
  const { root, store } = makeStore();
  try {
    insert(store, { offset: 0, timestamp: '2026-08-01T03:00:00.000Z', cwd: '/repo/old-codex', projectName: 'old-codex' });
    store.upsertCursorActivity(cursorEvent({ lastUpdatedAt: '2026-08-20T10:00:00.000Z' }));

    const projects = store.getRecentProjectsAcrossProviders(6);
    assert.equal(projects[0].provider, 'cursor');
    assert.equal(projects[0].name, 'cursor-proj');
    assert.equal(projects[0].cwd, '/repo/cursor-proj');
    // 있지도 않은 요청 델타를 지어내면 R7 위반입니다 — 0으로 고정합니다.
    assert.equal(projects[0].totalTokens, 0);
    assert.equal(projects[1].provider, 'codex');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('since 필터는 Cursor 활동에도 last_updated_at 기준으로 적용된다', () => {
  const { root, store } = makeStore();
  try {
    store.upsertCursorActivity(cursorEvent({ composerId: 'composer-old', lastUpdatedAt: '2026-07-01T00:00:00.000Z', projectName: 'cursor-old' }));
    store.upsertCursorActivity(cursorEvent({ composerId: 'composer-new', lastUpdatedAt: '2026-08-20T00:00:00.000Z', projectName: 'cursor-new' }));

    const recent = store.getRecentProjectsAcrossProviders(6, '2026-08-01T00:00:00.000Z');
    assert.deepEqual(recent.map((project) => project.name), ['cursor-new']);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 프로젝트 화면(getProjectBreakdown)은 일부러 토큰 순을 유지합니다(위
// "'최근' 프로젝트 목록은..." 테스트와 대비되는 지점) — Cursor 는 비교 가능한
// 토큰이 없어(R7) 그 순위에 안 섞이고 뒤에 자기 그룹(최근 순)으로 붙습니다.
test('getProjectBreakdown 은 Cursor 를 토큰 순위에 안 섞고 뒤에 별도로 붙인다', () => {
  const { root, store } = makeStore();
  try {
    insert(store, { offset: 0, cwd: '/repo/big-old', projectName: 'big-old', sessionId: 'session-old' });
    insert(store, { offset: 1, cwd: '/repo/big-old', projectName: 'big-old', sessionId: 'session-old' });
    store.upsertCursorActivity(cursorEvent({ composerId: 'c1', projectName: 'cursor-proj', requestCount: 5 }));
    store.upsertCursorActivity(cursorEvent({ composerId: 'c2', projectName: 'cursor-proj', requestCount: 2, lastUpdatedAt: '2026-08-19T00:00:00.000Z' }));

    const rows = store.getProjectBreakdown({});
    assert.equal(rows[0].provider, 'codex', '토큰 순 1위는 그대로 codex 여야 합니다');
    const cursorRow = rows.find((row) => row.provider === 'cursor');
    assert.ok(cursorRow, 'Cursor 프로젝트도 목록에 나타나야 합니다');
    assert.equal(cursorRow.totalTokens, null, '있지도 않은 토큰을 0으로 지어내지 않습니다(R7)');
    assert.equal(cursorRow.modelCount, null);
    assert.equal(cursorRow.sessionCount, 2, '컴포저(대화) 수 — c1·c2 두 개');
    assert.equal(cursorRow.requestCount, 7, '요청 수는 컴포저 전체 합계(5+2)');
    assert.equal(cursorRow.lastActivity, '2026-08-20T10:00:00.000Z', '컴포저 중 가장 최근 관측');

    // provider 를 codex 로 명시하면 Cursor 가 섞이지 않아야 합니다(회귀 방지).
    const codexOnly = store.getProjectBreakdown({ provider: 'codex' });
    assert.ok(!codexOnly.some((row) => row.provider === 'cursor'));
    // provider 를 cursor 로 명시하면 usage_events 를 아예 안 봐야 합니다.
    const cursorOnly = store.getProjectBreakdown({ provider: 'cursor' });
    assert.ok(cursorOnly.every((row) => row.provider === 'cursor'));
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getProjectDetail 은 Cursor projectKey 도 찾아 다른 모양의 상세를 준다', () => {
  const { root, store } = makeStore();
  try {
    store.upsertCursorActivity(cursorEvent({
      composerId: 'c1', projectName: 'cursor-proj', requestCount: 4, linesAdded: 30, linesRemoved: 5,
      contextTotalTokens: 27766, contextWindowTokens: 200000, lastUpdatedAt: '2026-08-20T09:00:00.000Z',
    }));
    store.upsertCursorActivity(cursorEvent({
      composerId: 'c2', projectName: 'cursor-proj', requestCount: 1, linesAdded: 10, linesRemoved: 0,
      contextTotalTokens: 12000, contextWindowTokens: 200000, lastUpdatedAt: '2026-08-19T09:00:00.000Z',
    }));
    const key = projectKeyOf('cursor', 'cursor-proj');

    const detail = store.getProjectDetail({ projectKey: key });
    assert.ok(detail, 'usage_events 뿐 아니라 cursor_local_activity 프로젝트 이름도 찾아야 합니다');
    assert.equal(detail.project.provider, 'cursor');
    assert.equal(detail.project.totalTokens, null);
    // 요청 단위 개념(모델·세션 표+턴 분석)은 기능적용가능성.md 에서 이미
    // X 로 배제된 항목입니다 — 지어내지 않고 빈 배열로 남깁니다.
    assert.deepEqual(detail.models, []);
    assert.deepEqual(detail.sessions, []);
    // (신규) "Cursor 활동" 카드 — 실제로 있는 신호는 합산해서 줍니다.
    assert.equal(detail.cursorActivity.composerCount, 2);
    assert.equal(detail.cursorActivity.requestCount, 5);
    assert.equal(detail.cursorActivity.linesAdded, 40);
    assert.equal(detail.cursorActivity.linesRemoved, 5);
    assert.equal(detail.cursorActivity.lastObserved.composerId, 'c1', '가장 최근 컴포저여야 합니다');
    assert.equal(detail.cursorActivity.lastObserved.contextTotalTokens, 27766);

    // 존재하지 않는 Cursor 프로젝트 이름은 여전히 null 이어야 합니다(404 유지).
    assert.equal(store.getProjectDetail({ projectKey: projectKeyOf('cursor', 'no-such-project') }), null);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Cursor 프로젝트도 별칭·경로 가림이 별도 구현 없이 자동 적용된다', () => {
  const { root, store } = makeStore();
  try {
    store.upsertCursorActivity(cursorEvent({ composerId: 'c1', cwd: '/repo/secret-cursor-client', projectName: 'secret-cursor-client' }));
    const key = projectKeyOf('cursor', 'secret-cursor-client');
    store.setProjectAlias({ provider: 'cursor', projectKey: key, alias: '고객사 C', redacted: true });

    const [row] = store.getProjectBreakdown({ provider: 'cursor' });
    assert.equal(row.name, '고객사 C');
    assert.equal(row.redacted, true);
    assert.equal(row.cwd, null, '가림이 켜지면 경로는 응답에서 지워집니다');

    const detail = store.getProjectDetail({ projectKey: key });
    assert.equal(detail.project.name, '고객사 C');
    assert.equal(detail.project.redacted, true);

    const serialized = JSON.stringify([row, detail]);
    assert.ok(!serialized.includes('secret-cursor-client'), '가림 후에도 원본 이름이 응답에 남아 있습니다');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// cwd 없는 컴포저는 project_name 이 빈 문자열이 아니라 SQL NULL 입니다
// (parser.mjs — cwd 가 없으면 projectNameFromCwd 를 안 거치고 null 을 그대로
// 씁니다). getProjectBreakdown 은 이걸 '(미분류)' 로 묶어 보여주므로, 상세
// 카드(getCursorProjectActivity)도 같은 행을 찾아야 sessionCount 와 모순되지
// 않습니다 — 회귀 재발 방지(review wf_c73a866f-909 Finding 1).
test('cwd 없는 Cursor 컴포저도 "(미분류)" 프로젝트 상세에서 0으로 안 보인다', () => {
  const { root, store } = makeStore();
  try {
    store.upsertCursorActivity(cursorEvent({ composerId: 'c1', cwd: null, projectName: null, requestCount: 4 }));
    store.upsertCursorActivity(cursorEvent({ composerId: 'c2', cwd: null, projectName: null, requestCount: 1, lastUpdatedAt: '2026-08-19T09:00:00.000Z' }));

    const [row] = store.getProjectBreakdown({ provider: 'cursor' });
    assert.equal(row.name, '(미분류)');
    assert.equal(row.sessionCount, 2, '목록에는 두 컴포저가 정상 집계됩니다');

    const detail = store.getProjectDetail({ projectKey: row.projectKey });
    assert.ok(detail, '프로젝트 목록이 준 키로 상세가 열려야 합니다');
    // 여기가 회귀 지점이었습니다 — project_name = '' 로 필터링하면 NULL 행을
    // 하나도 못 찾아 이 카드 전체가 조용히 0/—으로 나왔습니다(R7 위반).
    assert.equal(detail.cursorActivity.composerCount, 2, '목록의 sessionCount(2)와 일치해야 합니다');
    assert.equal(detail.cursorActivity.requestCount, 5);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// getRecentProjectsAcrossProviders(대시보드·상세 내역의 "최근 프로젝트")와
// getProjectBreakdown(프로젝트 화면 자체 목록)이 cwd 없는 Cursor 컴포저를
// 같은 projectKey 로 가리켜야 클릭 이동이 성립합니다 — 두 자리표시자
// ('unknown-project' vs '(미분류)')가 갈리면 있는 프로젝트인데도 다른 화면에서
// 404/"찾지 못했어요"가 됩니다(review wf_c73a866f-909 Finding 2).
test('cwd 없는 Cursor 프로젝트는 "최근 프로젝트" 목록과 프로젝트 화면이 같은 키를 가리킨다', () => {
  const { root, store } = makeStore();
  try {
    store.upsertCursorActivity(cursorEvent({ composerId: 'c1', cwd: null, projectName: null }));

    const [recent] = store.getRecentProjectsAcrossProviders(6).filter((row) => row.provider === 'cursor');
    const [listed] = store.getProjectBreakdown({ provider: 'cursor' });
    assert.equal(recent.name, listed.name, '두 화면이 같은 자리표시자 이름을 써야 키가 갈리지 않습니다');

    const key = projectKeyOf('cursor', recent.name);
    assert.equal(key, listed.projectKey, '"최근 프로젝트"가 주는 키가 프로젝트 화면 자체 키와 같아야 합니다');
    assert.ok(store.getProjectDetail({ projectKey: key }), '그 키로 상세가 실제로 열려야 합니다(404 회귀 방지)');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// usage 화면의 "Cursor — 컨텍스트 구성" 패널 전용 쿼리.
test('getCursorContextBreakdown 은 breakdown 있는 CLI 행만 내고 IDE 행 수는 따로 센다', () => {
  const { root, store } = makeStore();
  try {
    store.upsertCursorActivity(cursorEvent({
      composerId: 'cli-1', surface: 'cli', contextBreakdown: { system_prompt: 500, conversation: 4500 },
      contextTotalTokens: 5000, contextWindowTokens: 200000, lastUpdatedAt: '2026-08-20T01:00:00.000Z',
    }));
    // IDE 행은 절대 토큰 breakdown 이 없습니다(파서 스코프 결정) — contextBreakdown: null.
    store.upsertCursorActivity(cursorEvent({
      composerId: 'ide-1', surface: 'ide', contextBreakdown: null, contextTotalTokens: null,
      contextWindowTokens: null, contextUsagePercent: 47.8, lastUpdatedAt: '2026-08-20T02:00:00.000Z',
    }));

    const result = store.getCursorContextBreakdown({});
    assert.equal(result.composers.length, 1);
    assert.equal(result.composers[0].composerId, 'cli-1');
    assert.equal(result.composers[0].surface, 'cli');
    assert.deepEqual(result.composers[0].breakdown, { system_prompt: 500, conversation: 4500 });
    assert.equal(result.composers[0].totalTokens, 5000);
    assert.equal(result.composers[0].windowTokens, 200000);
    assert.equal(result.ideExcluded, 1, 'IDE 행이 조용히 사라지지 않고 개수로 드러나야 합니다');

    const sinceLater = store.getCursorContextBreakdown({ since: '2026-08-21T00:00:00.000Z' });
    assert.equal(sinceLater.composers.length, 0, 'since 필터가 last_updated_at 기준으로 걸려야 합니다');
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
