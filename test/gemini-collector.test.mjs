// Gemini 수집기. 여기서 고정하는 것은 셋입니다.
//   1) 포맷이 둘(`.json` 스냅샷 / `.jsonl` 증분 로그)이고 둘 다 읽힌다
//   2) 어느 경로로 몇 번 다시 읽어도 합계가 늘지 않는다
//   3) 프롬프트·응답·도구 입출력이 SQLite 바이트와 스냅샷에 남지 않는다
//
// `.endsWith('.json')` 이 `.jsonl` 을 잡지 않는다는 점이 이 어댑터에서 실제로
// 놓칠 수 있었던 함정이라(개발 머신에 `.jsonl` 386개가 있었습니다) 두 포맷을
// 한 픽스처에 같이 둡니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../service/store.mjs';
import { GeminiCollector } from '../service/providers/gemini/collector.mjs';
import { UsageApiServer } from '../service/api-server.mjs';

const SENTINELS = [
  'SENTINEL-USER-PROMPT',
  'SENTINEL-MODEL-TEXT',
  'SENTINEL-THOUGHT-TEXT',
  'SENTINEL-TOOL-ARG',
  'SENTINEL-TOOL-RESULT',
  'SENTINEL-SUMMARY',
];

const SLUG_DIR = 'secret-client';
const SLUG_CWD = 'c:\\users\\dev\\git\\node\\secret-client';
const HASH_DIR = 'a'.repeat(64);
const SNAPSHOT_SESSION = '11111111-2222-4333-8444-555555555555';
const LOG_SESSION = '99999999-8888-4777-8666-555555555555';
const NESTED_SESSION = '22222222-3333-4444-8555-666666666666';

function tokens({ input, output, cached = 0, thoughts = 0, tool = 0 }) {
  return { input, output, cached, thoughts, tool, total: input + output + thoughts };
}

function writeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-gemini-collector-'));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
    projects: { [SLUG_CWD]: SLUG_DIR },
  }));
  // 어댑터가 절대 열어서는 안 되는 파일들. 열면 아래 센티넬 검사가 잡습니다.
  fs.writeFileSync(path.join(home, 'oauth_creds.json'), JSON.stringify({ access_token: 'SENTINEL-TOOL-RESULT' }));

  // ── 포맷 1: `.json` 문서 스냅샷 (슬러그 디렉터리 → 경로가 풀린다)
  const snapshotDir = path.join(home, 'tmp', SLUG_DIR, 'chats');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, 'session-2026-01-01T00-00-aaaa1111.json'), JSON.stringify({
    sessionId: SNAPSHOT_SESSION,
    projectHash: SLUG_DIR,
    startTime: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:10:00.000Z',
    summary: SENTINELS[5],
    messages: [
      { id: 'u1', timestamp: '2026-01-01T00:00:01.000Z', type: 'user', content: SENTINELS[0] },
      {
        id: 'g1',
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'gemini',
        model: 'gemini-3-pro-preview',
        content: SENTINELS[1],
        thoughts: [{ subject: SENTINELS[2], description: SENTINELS[2], timestamp: '2026-01-01T00:00:02.000Z' }],
        tokens: tokens({ input: 1000, output: 50, cached: 400, thoughts: 20 }),
        toolCalls: [{
          id: 'call-1',
          name: 'read_file',
          args: { file_path: 'c:\\users\\dev\\git\\node\\secret-client\\src\\app.js', content: SENTINELS[3] },
          result: SENTINELS[4],
          resultDisplay: SENTINELS[4],
          status: 'success',
        }],
      },
    ],
  }));

  // ── 포맷 2: `.jsonl` 증분 로그 (해시 디렉터리 → 경로를 되돌릴 수 없다)
  const logDir = path.join(home, 'tmp', HASH_DIR, 'chats');
  fs.mkdirSync(logDir, { recursive: true });
  const lines = [
    { sessionId: LOG_SESSION, projectHash: HASH_DIR, startTime: '2026-01-02T00:00:00.000Z', lastUpdated: '2026-01-02T00:00:00.000Z', kind: 'main' },
    { id: 'u2', timestamp: '2026-01-02T00:00:01.000Z', type: 'user', content: SENTINELS[0] },
    { $set: { lastUpdated: '2026-01-02T00:00:01.000Z' } },
    { id: 'g2', timestamp: '2026-01-02T00:00:02.000Z', type: 'gemini', model: 'gemini-2.5-flash', content: SENTINELS[1], tokens: tokens({ input: 300, output: 10, cached: 100, thoughts: 5 }) },
    { $set: { lastUpdated: '2026-01-02T00:00:02.000Z' } },
  ];
  fs.writeFileSync(
    path.join(logDir, 'session-2026-01-02T00-00-bbbb2222.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );

  // ── chats 한 단계 아래에 놓인 세션 파일. 실측에 이런 배치가 있었고
  // (chats/<uuid>/<임의이름>.json) 발견 로직이 chats 바로 아래만 보다가
  // 놓쳤습니다. 파일 이름이 session-* 도 아니라 이름 규칙으로도 못 찾습니다.
  const nestedDir = path.join(home, 'tmp', SLUG_DIR, 'chats', 'caeefbb4-6fac-4782-aaf5-7b947dfb02c6');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(nestedDir, 'gxblmq.json'), JSON.stringify({
    sessionId: NESTED_SESSION,
    projectHash: SLUG_DIR,
    startTime: '2026-01-03T00:00:00.000Z',
    lastUpdated: '2026-01-03T00:05:00.000Z',
    messages: [
      { id: 'u3', timestamp: '2026-01-03T00:00:01.000Z', type: 'user', content: SENTINELS[0] },
      { id: 'g3', timestamp: '2026-01-03T00:00:02.000Z', type: 'gemini', content: SENTINELS[1], tokens: tokens({ input: 700, output: 20, cached: 200, thoughts: 10 }) },
    ],
  }));

  // ── 형제 디렉터리 tool-outputs 는 읽지 않아야 합니다. 실측에서 토큰이
  // 0건이었고 내용은 도구 출력 본문입니다. 여기 심은 센티넬이 DB 에 나타나면
  // 아래 프라이버시 검사가 잡습니다.
  const toolOutputs = path.join(home, 'tmp', SLUG_DIR, 'tool-outputs', 'session-deadbeef');
  fs.mkdirSync(toolOutputs, { recursive: true });
  fs.writeFileSync(path.join(toolOutputs, 'out.json'), JSON.stringify({
    messages: [{ id: 'x9', timestamp: '2026-01-04T00:00:00.000Z', type: 'gemini', content: SENTINELS[4], tokens: tokens({ input: 99999, output: 99999 }) }],
  }));

  return home;
}

function open(home) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-gemini-db-'));
  const store = new UsageStore(path.join(dbDir, 'usage.sqlite3'));
  const collector = new GeminiCollector({ store, geminiHomes: [home] });
  return { store, collector, dbPath: path.join(dbDir, 'usage.sqlite3') };
}

test('두 포맷을 모두 읽고 합계가 두 파일의 합과 같다', async () => {
  const home = writeHome();
  const { store, collector } = open(home);
  try {
    const result = await collector.reconcile('test');
    // .json + .jsonl + chats 한 단계 아래의 .json = 3. tool-outputs 는 세지 않습니다.
    assert.equal(result.files, 3, '.json · .jsonl · 하위 디렉터리 파일이 모두 발견돼야 합니다');

    const totals = store.getProviderTotals('gemini');
    assert.equal(totals.eventCount, 3);
    assert.equal(totals.inputTokens, 2000);
    assert.equal(totals.cachedInputTokens, 700);
    assert.equal(totals.outputTokens, 80);
    assert.equal(totals.reasoningTokens, 35);
    assert.equal(totals.totalTokens, 1070 + 315 + 730);
    assert.equal(totals.cacheWriteInputTokens, 0, 'Gemini 로그에는 캐시 쓰기가 없습니다');

    const status = collector.getStatus();
    assert.equal(status.identityMismatches, 0);
    assert.equal(status.cacheOutsideInput, 0);
    assert.equal(status.parseErrors, 0);
  } finally {
    store.close();
  }
});

test('몇 번 다시 스캔해도 합계와 턴 수가 늘지 않는다', async () => {
  const home = writeHome();
  const { store, collector } = open(home);
  try {
    await collector.reconcile('first');
    const before = store.getProviderTotals('gemini');
    const turnsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE provider = 'gemini'").get().n;

    await collector.reconcile('second');
    // 커서를 지우고 강제로 전량 재해석시킨 경로도 확인합니다.
    store.db.exec("DELETE FROM provider_scan_state WHERE provider = 'gemini'");
    await collector.reconcile('third-full-rescan');

    const after = store.getProviderTotals('gemini');
    const turnsAfter = store.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE provider = 'gemini'").get().n;
    assert.deepEqual(after, before);
    assert.equal(turnsAfter, turnsBefore);
    assert.equal(turnsAfter, 3, '픽스처의 사람 메시지는 세션 파일마다 하나입니다');
  } finally {
    store.close();
  }
});

test('내용이 그대로인 재작성은 내용 해시로 걸러 파싱을 건너뛴다', async () => {
  const home = writeHome();
  const { store, collector } = open(home);
  try {
    await collector.reconcile('first');
    const snapshot = path.join(home, 'tmp', SLUG_DIR, 'chats', 'session-2026-01-01T00-00-aaaa1111.json');
    const before = collector.getStatus().unchangedByHash;

    // 내용은 그대로 두고 mtime 만 미래로 밀면 size+mtime 검사는 통과하지
    // 못하고, 내용 해시가 같아서 파싱이 생략돼야 합니다.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(snapshot, future, future);
    const result = await collector.scanFile(snapshot, 'touched');

    assert.equal(collector.getStatus().unchangedByHash, before + 1);
    assert.equal(result.changed, false);
    assert.equal(store.getProviderTotals('gemini').eventCount, 3, '합계는 그대로여야 합니다');
  } finally {
    store.close();
  }
});

test('색인으로 풀리는 프로젝트는 경로를, 못 풀리는 해시는 서로 다른 식별자를 받는다', async () => {
  const home = writeHome();
  const { store, collector } = open(home);
  try {
    await collector.reconcile('test');
    const projects = store.getProjectBreakdown({ provider: 'gemini' });
    const names = projects.map((project) => project.name);

    assert.ok(names.includes('secret-client'), '슬러그는 projects.json 으로 경로까지 풀립니다');
    // 해시는 역매핑이 불가능합니다. 'unknown-project' 로 접으면 서로 다른
    // 프로젝트가 한 줄로 합쳐지므로 디렉터리 이름 앞부분을 식별자로 씁니다.
    const hashed = names.find((name) => name.startsWith('gemini:'));
    assert.equal(hashed, `gemini:${'a'.repeat(12)}`);

    const status = collector.getStatus();
    assert.equal(status.projectsIndexed, 1);
    // 이 카운터는 프로젝트가 아니라 **스캔한 파일**을 셉니다. secret-client 아래
    // 파일이 둘(chats 직하 + chats/<uuid>/)이라 해석 성공이 2 입니다.
    assert.equal(status.projectsResolved, 2);
    assert.equal(status.projectsUnresolved, 1);
  } finally {
    store.close();
  }
});

test('프롬프트 · 응답 · 사고 · 도구 입출력이 SQLite 와 스냅샷에 남지 않는다', async () => {
  const home = writeHome();
  const { store, collector, dbPath } = open(home);
  const apiServer = new UsageApiServer({
    usageEngine: { snapshot: () => ({}), on() {}, off() {} },
  });
  try {
    await collector.reconcile('test');

    // 도구 이름과 경로 뒤 두 조각은 남아야 합니다 — 그것이 세션 흐름의 근거입니다.
    const row = store.db.prepare("SELECT tool_counts, touched_paths, cwd FROM usage_events WHERE provider='gemini' AND tool_counts IS NOT NULL").get();
    assert.ok(row, '도구 이름은 기록돼야 합니다');
    assert.deepEqual(JSON.parse(row.tool_counts), { read_file: 1 });
    assert.deepEqual(JSON.parse(row.touched_paths), { 'src/app.js': 1 });

    const snapshotJson = JSON.stringify({
      totals: store.getProviderTotals('gemini'),
      quality: store.getProviderQuality('gemini'),
      projects: store.getProjectBreakdown({ provider: 'gemini' }),
      sessions: store.getSessionRanking({ provider: 'gemini' }),
      diagnostics: store.getDiagnostics(),
    });
    store.close();
    const bytes = fs.readFileSync(dbPath);

    for (const sentinel of SENTINELS) {
      assert.ok(!bytes.includes(Buffer.from(sentinel)), `${sentinel} 가 SQLite 파일에 남아 있습니다`);
      assert.ok(!snapshotJson.includes(sentinel), `${sentinel} 가 스냅샷 응답에 남아 있습니다`);
    }
  } finally {
    await apiServer.stop();
  }
});

test('로그 위치가 없으면 조용히 미발견으로 남는다', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-gemini-empty-'));
  const prev = process.env.NYANG_ANTIGRAVITY_HOME;
  process.env.NYANG_ANTIGRAVITY_HOME = path.join(empty, 'no-antigravity');
  const { store, collector } = open(empty);
  try {
    const result = await collector.reconcile('test');
    assert.equal(result.files, 0);
    const status = collector.getStatus();
    assert.equal(status.detected, false);
    assert.equal(status.sources.legacyChats.present, false);
    assert.equal(status.sources.antigravity.present, false);
    assert.equal(status.lastError, null, '로그가 없는 것은 오류가 아닙니다');
  } finally {
    if (prev == null) delete process.env.NYANG_ANTIGRAVITY_HOME;
    else process.env.NYANG_ANTIGRAVITY_HOME = prev;
    collector.stop();
    store.close();
  }
});

test('agy conversations 만 있어도 detected 이고 sources 를 보고한다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-gemini-agy-only-'));
  const prev = process.env.NYANG_ANTIGRAVITY_HOME;
  process.env.NYANG_ANTIGRAVITY_HOME = path.join(home, 'antigravity-cli');
  const { store, collector } = open(home);
  try {
    fs.mkdirSync(path.join(home, 'antigravity-cli', 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(home, 'antigravity-cli', 'conversations', 'chat.db'), '');
    await collector.detect();
    const status = collector.getStatus();
    assert.equal(status.detected, true);
    assert.equal(status.sources.legacyChats.present, false);
    assert.equal(status.sources.antigravity.present, true);
    assert.equal(status.sources.antigravity.conversations, 1);
    const result = await collector.reconcile('test:agy-only');
    assert.equal(result.files, 0);
    assert.equal(result.changed, false);
  } finally {
    if (prev == null) delete process.env.NYANG_ANTIGRAVITY_HOME;
    else process.env.NYANG_ANTIGRAVITY_HOME = prev;
    collector.stop();
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('chats 한 단계 아래의 세션 파일도 읽고, 형제 tool-outputs 는 읽지 않는다', async () => {
  // ccusage 대조에서 드러난 실제 누락입니다. chats 바로 아래만 보면 이 파일이
  // 빠지고, 파일 이름이 session-* 도 아니라 이름 규칙으로도 못 찾습니다.
  const home = writeHome();
  const { store, collector } = open(home);
  try {
    await collector.reconcile('test');
    const rows = store.db
      .prepare("SELECT session_id, source_path FROM sessions WHERE provider = 'gemini' ORDER BY session_id")
      .all();
    // 세션 정체는 경로에서 만듭니다 — 로그의 sessionId 는 파일 간에 유일하지
    // 않아서 쓸 수 없습니다(실측: 파일 347개가 한 값을 공유).
    assert.equal(rows.length, 3, '세션 파일 3개가 각자 세션 행을 가져야 합니다');
    assert.equal(new Set(rows.map((row) => row.session_id)).size, 3, '세션 정체가 파일별로 유일해야 합니다');
    assert.ok(rows.every((row) => row.session_id.startsWith('gemini-')));
    assert.ok(
      rows.some((row) => row.source_path.includes('caeefbb4-6fac-4782-aaf5-7b947dfb02c6')),
      '하위 디렉터리 파일도 세션 행을 가져야 합니다',
    );
    assert.ok(!rows.some((row) => row.session_id === NESTED_SESSION), '로그의 sessionId 를 정체로 쓰지 않습니다');

    // tool-outputs 의 파일은 토큰 99999 를 담고 있습니다. 읽혔다면 합계가 튑니다.
    const totals = store.getProviderTotals('gemini');
    assert.equal(totals.totalTokens, 1070 + 315 + 730);
    assert.ok(totals.inputTokens < 99999, 'tool-outputs 를 읽으면 안 됩니다');
  } finally {
    store.close();
  }
});

test('reconcile 는 겹친 패스를 합치고 실패 뒤에도 다시 돈다', async () => {
  const home = writeHome();
  const store = new UsageStore(path.join(home, 'usage.sqlite3'));
  const collector = new GeminiCollector({ store, geminiHomes: [home] });
  try {
    await collector.detect();
    assert.equal(collector.getStatus().detected, true);

    let discoverCalls = 0;
    let releaseDiscover;
    let discoverEntered;
    const discoverGate = new Promise((resolve) => { discoverEntered = resolve; });
    collector.discoverFiles = async () => {
      discoverCalls += 1;
      discoverEntered();
      await new Promise((resolve) => { releaseDiscover = resolve; });
      return [];
    };
    collector.refreshWatchers = async () => {};

    const first = collector.reconcile('overlap-a');
    const second = collector.reconcile('overlap-b');
    await discoverGate;
    assert.equal(first, second);
    assert.equal(discoverCalls, 1);

    releaseDiscover();
    await first;

    discoverCalls = 0;
    collector.discoverFiles = async () => { discoverCalls += 1; return []; };
    await collector.reconcile('after-first');
    assert.equal(discoverCalls, 1);

    collector.discoverFiles = async () => { throw new Error('discover failed'); };
    const failed = await collector.reconcile('fail');
    assert.match(failed.error, /discover failed/);

    discoverCalls = 0;
    collector.discoverFiles = async () => { discoverCalls += 1; return []; };
    await collector.reconcile('recover');
    assert.equal(discoverCalls, 1);
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
