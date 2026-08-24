// 로컬 데이터 백업 · 초기화.
//
// 이 기능의 값은 편의가 아니라 **안전성**에 있습니다. 되돌릴 수 없는 동작이므로
// 단정하는 것도 "동작한다"가 아니라 "잘못 동작할 수 없다" 쪽입니다.
//   - 확인 문자열 없이는 비우지 않는다
//   - 백업이 실패하면 비우지 않는다
//   - 사람이 만든 별칭은 기본으로 살아남는다
//   - 백업은 수집 중에도 찢어지지 않는다
//   - 비운 뒤 다시 스캔하면 같은 값이 돌아온다

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore } from '../service/store.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function usageEvent({ sessionId = 's-1', provider = 'codex', total = 100, timestamp = '2026-08-01T00:00:00.000Z', turnIndex = 3 } = {}) {
  return {
    type: 'usage',
    provider,
    session: { provider, sessionId, cwd: '/repo/demo', projectName: 'demo', model: 'm-1' },
    eventTimestamp: timestamp,
    eventKey: `${provider}|${sessionId}|${timestamp}|${total}`,
    delta: {
      inputTokens: total - 10,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningTokens: 2,
      toolTokens: 7,
      totalTokens: total,
    },
    turnIndex,
    toolCounts: { read_file: 2 },
    fieldQuality: { outputTokens: 'exact' },
    parserVersion: 9,
    requestId: 'req-1',
  };
}

test('insertUsageEvent 도 tool_tokens · field_quality · parser_version · request_id 를 남긴다', () => {
  const dir = tempDir('nyang-insert-cols-');
  const store = new UsageStore(path.join(dir, 'usage.sqlite3'));
  try {
    assert.equal(store.insertUsageEvent(usageEvent(), '/logs/a.jsonl', 0), true);
    const row = store.db.prepare('SELECT * FROM usage_events').get();
    // 이 넷이 이 목록에서 빠져 있던 동안, 이 경로를 쓰는 provider 의 행은
    // 파서가 값을 실어 보냈는데도 전부 NULL 이었습니다.
    assert.equal(row.tool_tokens, 7, 'tool_tokens 가 기본값 0 으로 덮이지 않아야 합니다');
    assert.equal(row.parser_version, 9, '어느 파서가 쓴 행인지 남아야 합니다');
    assert.equal(row.request_id, 'req-1');
    assert.deepEqual(JSON.parse(row.field_quality), { outputTokens: 'exact' });
    assert.equal(row.turn_index, 3);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('백업은 수집 중에도 정합 사본을 만든다 — 파일 복사가 아니라 VACUUM INTO', () => {
  const dir = tempDir('nyang-backup-');
  const store = new UsageStore(path.join(dir, 'usage.sqlite3'));
  try {
    for (let index = 0; index < 40; index += 1) {
      store.insertUsageEvent(usageEvent({ sessionId: `s-${index}`, total: 100 + index }), '/logs/a.jsonl', index);
    }
    const dest = path.join(dir, 'backup.sqlite3');
    store.backupTo(dest);
    assert.ok(fs.statSync(dest).size > 0);

    // 사본을 독립적으로 열어 같은 원장이 들어 있는지 봅니다. WAL 이 열린 채로
    // 파일만 복사하면 이 단정이 깨집니다.
    const copy = new DatabaseSync(dest, { readOnly: true });
    const mine = store.db.prepare('SELECT COUNT(*) n, SUM(total_tokens) t FROM usage_events').get();
    const theirs = copy.prepare('SELECT COUNT(*) n, SUM(total_tokens) t FROM usage_events').get();
    copy.close();
    assert.equal(theirs.n, mine.n);
    assert.equal(theirs.t, mine.t);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearLedger 는 원장을 비우고 커서까지 지운다 — 다시 스캔할 수 있어야 한다', () => {
  const dir = tempDir('nyang-clear-');
  const store = new UsageStore(path.join(dir, 'usage.sqlite3'));
  try {
    store.insertUsageEvent(usageEvent(), '/logs/a.jsonl', 0);
    store.upsertTurn({ provider: 'codex', sessionId: 's-1', turnIndex: 1, startedAt: '2026-08-01T00:00:00.000Z' });
    store.saveScanState({
      provider: 'codex', sourcePath: '/logs/a.jsonl', byteOffset: 999, fileSize: 999, mtimeMs: 1,
      previousUsage: { inputTokens: 90, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 10, reasoningTokens: 2, totalTokens: 100 },
      sessionId: 's-1',
    });

    const before = store.getDiagnostics();
    assert.equal(before.usageEvents, 1);
    assert.equal(before.scanFiles, 1);

    const result = store.clearLedger();
    assert.equal(result.after.usageEvents, 0);
    assert.equal(result.after.sessions, 0);
    // 커서가 남으면 재스캔이 "이미 다 읽었다"고 판단해 원장이 영구히 빈 채로
    // 남습니다. 비우기와 커서 삭제는 갈라질 수 없습니다.
    assert.equal(result.after.scanFiles, 0, '커서도 함께 지워져야 재측정이 가능합니다');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM turns').get().n, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('초기화는 사람이 만든 별칭·가림을 기본으로 남긴다', () => {
  const dir = tempDir('nyang-alias-keep-');
  const store = new UsageStore(path.join(dir, 'usage.sqlite3'));
  try {
    store.insertUsageEvent(usageEvent(), '/logs/a.jsonl', 0);
    const projectKey = store.getProjectBreakdown({ since: null }).projects?.[0]?.projectKey
      ?? store.getProjectBreakdown({ since: null })[0]?.projectKey;
    assert.ok(projectKey, '프로젝트 키를 얻어야 합니다');
    store.setProjectAlias({ provider: 'codex', projectKey, alias: '내 프로젝트', redacted: true });
    assert.equal(store.getProjectAliases().length, 1);

    // 측정값은 로그에서 다시 만들 수 있지만 별칭은 되살릴 방법이 없습니다.
    store.clearLedger();
    assert.equal(store.getProjectAliases().length, 1, '기본값은 별칭 보존입니다');

    store.clearLedger({ keepAliases: false });
    assert.equal(store.getProjectAliases().length, 0, '명시하면 별칭도 지웁니다');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('비우고 같은 로그를 다시 넣으면 같은 합계가 돌아온다', () => {
  const dir = tempDir('nyang-remeasure-');
  const store = new UsageStore(path.join(dir, 'usage.sqlite3'));
  try {
    const events = [];
    for (let index = 0; index < 25; index += 1) {
      events.push({ event: usageEvent({ sessionId: `s-${index}`, total: 100 + index }), offset: index });
    }
    for (const { event, offset } of events) store.insertUsageEvent(event, '/logs/a.jsonl', offset);
    const first = store.getDiagnostics();
    const firstTotal = store.db.prepare('SELECT SUM(total_tokens) t FROM usage_events').get().t;

    store.clearLedger();
    for (const { event, offset } of events) store.insertUsageEvent(event, '/logs/a.jsonl', offset);

    const second = store.getDiagnostics();
    const secondTotal = store.db.prepare('SELECT SUM(total_tokens) t FROM usage_events').get().t;
    assert.equal(second.usageEvents, first.usageEvents, '재측정이 행을 늘리거나 줄이지 않습니다');
    assert.equal(secondTotal, firstTotal, '같은 로그는 같은 합계를 냅니다');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 안전 장치 두 개 ────────────────────────────────────────────────────
// 되돌릴 수 없는 동작이므로 "실수로 도달할 수 없음"을 단정합니다.

test('확인 문자열이 틀리면 400 이고 원장은 그대로다', async () => {
  const { UsageApiServer } = await import('../service/api-server.mjs');
  const { EventEmitter } = await import('node:events');
  const dir = tempDir('nyang-reset-guard-');
  const store = new UsageStore(path.join(dir, 'usage.sqlite3'));
  store.insertUsageEvent(usageEvent(), '/logs/a.jsonl', 0);

  let resetCalls = 0;
  class FakeEngine extends EventEmitter {
    constructor() { super(); this.store = store; }
    defaultSince() { return null; }
    snapshot() { return { generatedAt: '2026-08-22T00:00:00.000Z' }; }
    dataStatus() { return { diagnostics: store.getDiagnostics(), backupDir: dir, backups: [], backupContainsRawPaths: true }; }
    async resetData() { resetCalls += 1; return {}; }
  }
  const server = new UsageApiServer({ usageEngine: new FakeEngine(), host: '127.0.0.1', port: 0 });
  const baseUrl = await server.start();
  const post = (body) => fetch(`${baseUrl}/api/v1/data/reset`, {
    method: 'POST',
    headers: { 'X-Nyang-Access-Token': server.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    for (const body of [{}, { confirm: '' }, { confirm: 'reset' }, { confirm: '네' }, { confirm: 'RESET ' }]) {
      const response = await post(body);
      assert.equal(response.status, 400, `${JSON.stringify(body)} 는 거절돼야 합니다`);
      assert.equal((await response.json()).error, 'confirmation_required');
    }
    assert.equal(resetCalls, 0, '거절된 요청은 엔진까지 가지 않습니다');
    assert.equal(store.getDiagnostics().usageEvents, 1, '원장이 그대로여야 합니다');

    const ok = await post({ confirm: 'RESET' });
    assert.equal(ok.status, 200);
    assert.equal(resetCalls, 1, '정확한 확인 문자열만 통과합니다');
  } finally {
    await server.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('백업이 실패하면 원장을 비우지 않는다 — 순서가 안전성이다', async () => {
  const { UsageEngine } = await import('../service/engine.mjs');
  const dir = tempDir('nyang-reset-order-');
  const empty = tempDir('nyang-reset-empty-');
  const engine = new UsageEngine({ userDataPath: dir, codexHome: empty, claudeHomes: [empty], geminiHomes: [empty] });
  try {
    engine.store.insertUsageEvent(usageEvent(), '/logs/a.jsonl', 0);
    assert.equal(engine.store.getDiagnostics().usageEvents, 1);

    // 디스크가 가득 찼거나 경로에 쓸 수 없는 상황을 그대로 흉내냅니다.
    engine.store.backupTo = () => { throw new Error('디스크에 쓸 수 없습니다'); };

    await assert.rejects(() => engine.resetData({ backupFirst: true }), /디스크에 쓸 수 없습니다/);
    assert.equal(engine.store.getDiagnostics().usageEvents, 1,
      '백업이 실패했으면 원장은 손대지 않은 상태여야 합니다');
    assert.equal(engine.resetting, false, '실패 후에도 잠금이 풀려야 합니다');
  } finally {
    engine.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('같은 순간에 두 번 백업해도 실패하지 않는다 — VACUUM INTO 는 덮어쓰지 않는다', async () => {
  const { UsageEngine } = await import('../service/engine.mjs');
  const dir = tempDir('nyang-backup-collide-');
  const empty = tempDir('nyang-backup-collide-empty-');
  const engine = new UsageEngine({ userDataPath: dir, codexHome: empty, claudeHomes: [empty], geminiHomes: [empty] });
  try {
    engine.store.insertUsageEvent(usageEvent(), '/logs/a.jsonl', 0);
    // 실제로 겪은 결함입니다. 이름이 초 단위였을 때, 백업 버튼을 누른 직후
    // 초기화를 하면 자동 백업이 "output file already exists" 로 던지고 그
    // 실패가 초기화까지 막았습니다 — 사용자에게는 이유가 안 보입니다.
    const names = new Set();
    for (let index = 0; index < 5; index += 1) {
      const entry = engine.createBackup();
      assert.ok(fs.existsSync(entry.path), `${entry.name} 이 만들어져야 합니다`);
      names.add(entry.name);
    }
    assert.equal(names.size, 5, '백업 이름이 서로 달라야 합니다');
    assert.equal(engine.listBackups().length, 5);
    // 덮어쓰지 않는다는 것도 함께 못박습니다 — 백업을 지우는 판단은 사람이 합니다.
    for (const name of names) assert.ok(fs.existsSync(path.join(dir, 'backups', name)));
  } finally {
    engine.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
