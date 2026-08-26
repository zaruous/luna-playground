// Cursor 수집기. 여기서 고정하는 것은 넷입니다.
//   1) CLI(store.db)와 IDE(composerHeaders) 둘 다 읽히고, CLI 는 절대 토큰까지 채운다
//   2) 어느 경로로 몇 번 다시 읽어도 cursor_local_activity 행 수·값이 늘지 않는다(멱등)
//   3) 대화 본문·시크릿(cursorAuth/*, agentKv:blob:*)이 SQLite 바이트와 스냅샷에 안 남는다
//   4) usage_events 에는 Cursor 행이 절대 안 생긴다 — 결정 4의 핵심 경계
//      (docs/dev/cursor/decisions.md)
//
// 바이너리 breakdown blob 은 손으로 protobuf 를 인코딩합니다 — probe-cursor.mjs 가
// 실측으로 확인한 필드 경로(5.1/5.2/5.3.3.1/5.3.3.3)와 정확히 같은 모양이어야
// service/providers/cursor/parser.mjs 의 extractBreakdown 이 읽습니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore } from '../service/store.mjs';
import { CursorCollector } from '../service/providers/cursor/collector.mjs';

const SENTINELS = ['SENTINEL-USER-PROMPT', 'SENTINEL-ASSISTANT-TEXT', 'SENTINEL-AUTH-TOKEN'];

function varintBytes(value) {
  const bytes = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}
function tagByte(fieldNum, wireType) { return varintBytes((fieldNum << 3) | wireType); }
function varintField(fieldNum, value) { return Buffer.concat([tagByte(fieldNum, 0), varintBytes(value)]); }
function bytesField(fieldNum, buf) { return Buffer.concat([tagByte(fieldNum, 2), varintBytes(buf.length), buf]); }
function categoryEntry(label, tokens) {
  return Buffer.concat([bytesField(1, Buffer.from(label, 'utf8')), varintField(3, tokens)]);
}
// 5(창 구성) → 1=총토큰 · 2=창크기 · 3(카테고리 묶음) → 3(카테고리 하나, 반복) → 1=키 · 3=토큰수
function breakdownBlob({ total, windowSize, categories }) {
  const categoriesBody = Buffer.concat(categories.map((c) => bytesField(3, categoryEntry(c.label, c.tokens))));
  const field5Body = Buffer.concat([varintField(1, total), varintField(2, windowSize), bytesField(3, categoriesBody)]);
  return bytesField(5, field5Body);
}

const CHAT_ID = 'chat-aaaa1111';
const WORKSPACE_HASH = 'workspace-hash-1';
const CLI_CWD = 'C:\\Users\\dev\\git\\node\\cursor-cli-project';
const COMPOSER_ID = 'composer-bbbb2222';
const IDE_CWD = 'C:\\Users\\dev\\git\\node\\cursor-ide-project';

function writeCliChat(home, { chatId = CHAT_ID, workspaceHash = WORKSPACE_HASH, cwd = CLI_CWD } = {}) {
  const chatDir = path.join(home, 'chats', workspaceHash, chatId);
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, 'meta.json'), JSON.stringify({
    schemaVersion: 1, createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_100_000, cwd, hasConversation: true,
  }));
  const dbPath = path.join(chatDir, 'store.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  insert.run('blob-1', Buffer.from(JSON.stringify({ role: 'user', content: SENTINELS[0] })));
  insert.run('blob-2', Buffer.from(JSON.stringify({ role: 'assistant', content: SENTINELS[1] })));
  // 오래된 관측(작은 rowid) — "최신 관측값 승리" 검증용 대조군입니다.
  insert.run('blob-3', breakdownBlob({
    total: 10_000, windowSize: 200_000,
    categories: [{ label: 'system_prompt', tokens: 500 }, { label: 'conversation', tokens: 9500 }],
  }));
  // 최신 관측(더 큰 rowid) — 이 값이 최종 채택돼야 합니다.
  insert.run('blob-4', breakdownBlob({
    total: 27_766, windowSize: 200_000,
    categories: [
      { label: 'system_prompt', tokens: 517 }, { label: 'tools', tokens: 8079 },
      { label: 'rules', tokens: 3026 }, { label: 'conversation', tokens: 16144 },
    ],
  }));
  db.close();
  return dbPath;
}

function writeIdeComposer(cursorAppData, { composerId = COMPOSER_ID, cwd = IDE_CWD } = {}) {
  const globalStorageDir = path.join(cursorAppData, 'globalStorage');
  fs.mkdirSync(globalStorageDir, { recursive: true });
  const idePath = path.join(globalStorageDir, 'state.vscdb');
  const db = new DatabaseSync(idePath);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT
    );
  `);
  // 어댑터가 절대 열어서는 안 되는 테이블/행. 열면 아래 센티넬 검사가 잡습니다.
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', SENTINELS[2]);
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
    .run('agentKv:blob:deadbeef', Buffer.from(JSON.stringify({ role: 'user', content: SENTINELS[0] })));
  db.prepare(`
    INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value)
    VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)
  `).run(composerId, 'workspace-ide-1', 1_700_000_200_000, 1_700_000_300_000, JSON.stringify({
    type: 'head', composerId, contextUsagePercent: 47.8, totalLinesAdded: 66, totalLinesRemoved: 15,
    workspaceIdentifier: { id: 'workspace-ide-1', configPath: { fsPath: cwd } },
    createdAt: 1_700_000_200_000, lastUpdatedAt: 1_700_000_300_000,
  }));
  db.close();
  return idePath;
}

function writeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-cursor-collector-'));
  writeCliChat(home);
  writeIdeComposer(path.join(home, 'appdata', 'Cursor', 'User'));
  return home;
}

function open(home, { cursorAppData = path.join(home, 'appdata', 'Cursor', 'User') } = {}) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-cursor-db-'));
  const store = new UsageStore(path.join(dbDir, 'usage.sqlite3'));
  const collector = new CursorCollector({ store, cursorHome: home, cursorAppData });
  return { store, collector, dbPath: path.join(dbDir, 'usage.sqlite3') };
}

test('CLI store.db 와 IDE composerHeaders 를 모두 읽어 cursor_local_activity 를 채운다', async () => {
  const home = writeHome();
  const { store, collector } = open(home);
  try {
    const result = await collector.reconcile('test');
    assert.equal(result.files, 2, 'CLI store.db 1개 + IDE state.vscdb 1개');

    const rows = store.db.prepare('SELECT * FROM cursor_local_activity ORDER BY composer_id').all();
    assert.equal(rows.length, 2);

    const cli = rows.find((row) => row.surface === 'cli');
    assert.equal(cli.composer_id, CHAT_ID);
    assert.equal(cli.cwd, CLI_CWD);
    assert.equal(cli.request_count, 1, '평문 blob 중 role=user 만 셉니다');
    assert.equal(cli.context_total_tokens, 27_766, '가장 나중 rowid 의 breakdown 이 최신 관측값입니다');
    assert.equal(cli.context_window_tokens, 200_000);
    assert.deepEqual(JSON.parse(cli.context_breakdown), {
      system_prompt: 517, tools: 8079, rules: 3026, conversation: 16144,
    });

    const ide = rows.find((row) => row.surface === 'ide');
    assert.equal(ide.composer_id, COMPOSER_ID);
    assert.equal(ide.cwd, IDE_CWD);
    assert.equal(ide.context_usage_percent, 47.8);
    assert.equal(ide.context_total_tokens, null, 'IDE 는 절대 토큰을 채우지 않습니다(스코프 결정)');
    assert.equal(ide.lines_added, 66);
    assert.equal(ide.lines_removed, 15);

    // 대시보드 카드가 읽는 요약도 CLI 의 절대 토큰을 우선해야 합니다.
    const summary = store.getCursorContextSummary();
    assert.equal(summary.totalTokens, 27_766);
    assert.equal(summary.windowTokens, 200_000);
    assert.equal(summary.absoluteUnavailable, false);

    assert.equal(collector.getStatus().parseErrors, 0);
  } finally {
    store.close();
  }
});

test('몇 번 다시 스캔해도 행 수와 값이 늘지 않는다', async () => {
  const home = writeHome();
  const { store, collector } = open(home);
  try {
    await collector.reconcile('first');
    const before = store.db.prepare('SELECT * FROM cursor_local_activity ORDER BY composer_id').all();

    await collector.reconcile('second');
    store.db.exec("DELETE FROM provider_scan_state WHERE provider = 'cursor'");
    await collector.reconcile('third-full-rescan');

    const after = store.db.prepare('SELECT * FROM cursor_local_activity ORDER BY composer_id').all();
    const strip = (row) => ({ ...row, observed_at: null }); // observed_at 은 스캔마다 새로 찍혀 당연히 다릅니다.
    assert.equal(after.length, before.length);
    assert.deepEqual(after.map(strip), before.map(strip));
  } finally {
    store.close();
  }
});

test('usage_events 에는 Cursor 행이 절대 생기지 않는다', async () => {
  const home = writeHome();
  const { store, collector } = open(home);
  try {
    await collector.reconcile('test');
    const count = store.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE provider = 'cursor'").get().n;
    assert.equal(count, 0, 'Cursor 행은 cursor_local_activity 에만 씁니다(결정 4)');
  } finally {
    store.close();
  }
});

test('대화 본문 · 시크릿이 SQLite 바이트와 스냅샷에 남지 않는다', async () => {
  const home = writeHome();
  const { store, collector, dbPath } = open(home);
  await collector.reconcile('test');
  const snapshotJson = JSON.stringify({
    activity: store.db.prepare('SELECT * FROM cursor_local_activity').all(),
    context: store.getCursorContextSummary(),
    projects: store.getRecentProjectsAcrossProviders(6),
  });
  store.close();
  const bytes = fs.readFileSync(dbPath);
  for (const sentinel of SENTINELS) {
    assert.ok(!bytes.includes(Buffer.from(sentinel)), `${sentinel} 가 SQLite 파일에 남아 있습니다`);
    assert.ok(!snapshotJson.includes(sentinel), `${sentinel} 가 스냅샷 응답에 남아 있습니다`);
  }
});

test('내용이 그대로인 재작성은 내용 해시로 걸러 CLI 파싱을 건너뛴다', async () => {
  const home = writeHome();
  const { store, collector } = open(home);
  try {
    await collector.reconcile('first');
    const dbPath = path.join(home, 'chats', WORKSPACE_HASH, CHAT_ID, 'store.db');
    const before = collector.getStatus().unchangedByHash;

    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(dbPath, future, future);
    const result = await collector.scanFile(dbPath, 'touched');

    assert.equal(collector.getStatus().unchangedByHash, before + 1);
    assert.equal(result.changed, false);
  } finally {
    store.close();
  }
});

test('로그 위치가 없으면 조용히 미발견으로 남는다', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-cursor-empty-'));
  const { store, collector } = open(empty, { cursorAppData: path.join(empty, 'no-appdata') });
  try {
    const result = await collector.reconcile('test');
    assert.equal(result.files, 0);
    const status = collector.getStatus();
    assert.equal(status.detected, false);
    assert.equal(status.sources.cli.present, false);
    assert.equal(status.sources.ide.present, false);
    assert.equal(status.lastError, null, '로그가 없는 것은 오류가 아닙니다');
  } finally {
    collector.stop();
    store.close();
  }
});

test('CLI 만 있으면 detected 이고 IDE sources 는 미발견으로 보고한다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-cursor-cli-only-'));
  writeCliChat(home);
  const { store, collector } = open(home, { cursorAppData: path.join(home, 'no-appdata') });
  try {
    await collector.detect();
    const status = collector.getStatus();
    assert.equal(status.detected, true);
    assert.equal(status.sources.cli.present, true);
    assert.equal(status.sources.cli.chats, 1);
    assert.equal(status.sources.ide.present, false);
  } finally {
    collector.stop();
    store.close();
  }
});

test('IDE 만 있으면 절대 토큰 없이 컨텍스트 백분율로 대시보드 요약을 대체한다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-cursor-ide-only-'));
  const cursorAppData = path.join(home, 'appdata', 'Cursor', 'User');
  writeIdeComposer(cursorAppData);
  const { store, collector } = open(home, { cursorAppData });
  try {
    const result = await collector.reconcile('test');
    assert.equal(result.files, 1);
    const status = collector.getStatus();
    assert.equal(status.sources.cli.present, false);
    assert.equal(status.sources.ide.present, true);

    const summary = store.getCursorContextSummary();
    assert.equal(summary.absoluteUnavailable, true, 'CLI 관측이 없으면 절대 토큰으로 가짜 환산하지 않습니다');
    assert.equal(summary.contextUsagePercent, 47.8);
    assert.equal(summary.totalTokens, null);
  } finally {
    collector.stop();
    store.close();
  }
});
