import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore } from '../service/store.mjs';
import { worstQuality } from '../service/utils.mjs';

function makeStore(prefix = 'nyang-claude-store-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, store: new UsageStore(path.join(root, 'usage.sqlite3')) };
}

function claudeEvent(overrides = {}) {
  return {
    type: 'usage',
    provider: 'claude',
    eventTimestamp: '2026-08-21T02:00:00.000Z',
    session: { provider: 'claude', sessionId: 'sess-1', cwd: '/repo/cat-app', projectName: 'cat-app', model: 'claude-opus-5' },
    eventKey: 'claude|msg_1|req_1',
    requestId: 'req_1',
    parserVersion: 1,
    delta: {
      inputTokens: 10, cachedInputTokens: 1000, cacheWriteInputTokens: 100,
      outputTokens: 500, reasoningTokens: 200, toolTokens: 0, totalTokens: 1610,
    },
    fieldQuality: { inputTokens: 'local_exact', cachedInputTokens: 'local_exact', outputTokens: 'partial' },
    measurementSource: 'local_log',
    measurementQuality: 'partial',
    ...overrides,
  };
}

test('upsert 는 같은 event_key 에 대해 행을 늘리지 않고 값만 갱신한다', () => {
  const { root, store } = makeStore();
  try {
    const first = store.upsertUsageEvent(claudeEvent(), '/t/a.jsonl', 120);
    assert.deepEqual(first, { changed: true, inserted: true, updated: false });

    // 스트리밍 최종 레코드: 같은 키에 더 큰 값.
    const final = store.upsertUsageEvent(claudeEvent({
      delta: { inputTokens: 10, cachedInputTokens: 1000, cacheWriteInputTokens: 100, outputTokens: 900, reasoningTokens: 200, toolTokens: 0, totalTokens: 2010 },
    }), '/t/a.jsonl', 260);
    assert.deepEqual(final, { changed: true, inserted: false, updated: true });

    const totals = store.getProviderTotals('claude');
    assert.equal(totals.eventCount, 1, '행이 늘었습니다 — UNIQUE(provider, event_key) 를 확인하세요');
    assert.equal(totals.outputTokens, 900);
    assert.equal(totals.totalTokens, 2010);

    // source_offset 은 최초 관측값을 유지해야 합니다. 갱신하면
    // UNIQUE(provider, source_path, source_offset) 때문에 새 행이 생깁니다.
    const row = store.db.prepare('SELECT source_offset FROM usage_events WHERE provider = ? AND event_key = ?').get('claude', 'claude|msg_1|req_1');
    assert.equal(Number(row.source_offset), 120);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('뒤에 온 레코드가 더 작으면 실측값을 덮지 않는다', () => {
  const { root, store } = makeStore();
  try {
    store.upsertUsageEvent(claudeEvent(), '/t/original.jsonl', 100);
    const stale = store.upsertUsageEvent(claudeEvent({
      delta: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningTokens: 0, toolTokens: 0, totalTokens: 0 },
    }), '/t/resumed.jsonl', 100);
    assert.deepEqual(stale, { changed: false, inserted: false, updated: false, reason: 'stale' });
    assert.equal(store.getProviderTotals('claude').totalTokens, 1610);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('eventKey 가 없으면 upsert 를 거부한다', () => {
  const { root, store } = makeStore();
  try {
    assert.throws(() => store.upsertUsageEvent(claudeEvent({ eventKey: null }), '/t/a.jsonl', 0), /eventKey/);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upsert 와 insert 는 같은 원장에서 공존한다', () => {
  const { root, store } = makeStore();
  try {
    store.insertUsageEvent({
      type: 'usage', provider: 'codex',
      session: { provider: 'codex', sessionId: 'codex-1', cwd: '/repo/x', projectName: 'x', model: 'gpt-test' },
      eventTimestamp: '2026-08-21T02:00:00.000Z',
      delta: { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 },
    }, '/t/codex.jsonl', 0);
    store.upsertUsageEvent(claudeEvent(), '/t/claude.jsonl', 0);

    assert.equal(store.getProviderTotals('codex').totalTokens, 120);
    assert.equal(store.getProviderTotals('claude').totalTokens, 1610);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('품질 집계는 필드별 최저 등급과 등급별 건수를 함께 낸다', () => {
  const { root, store } = makeStore();
  try {
    store.upsertUsageEvent(claudeEvent(), '/t/a.jsonl', 0);
    store.upsertUsageEvent(claudeEvent({
      eventKey: 'claude|msg_2|req_2',
      measurementQuality: 'local_exact',
      fieldQuality: { inputTokens: 'local_exact', cachedInputTokens: 'local_exact', outputTokens: 'local_exact', reasoningTokens: 'local_exact' },
    }), '/t/a.jsonl', 200);

    const quality = store.getProviderQuality('claude');
    assert.equal(quality.overall, 'partial', '이벤트 하나라도 추정이면 전체는 추정입니다');
    assert.equal(quality.eventCount, 2);
    assert.equal(quality.byQuality.partial.eventCount, 1);
    assert.equal(quality.byQuality.local_exact.eventCount, 1);
    assert.deepEqual(quality.fields.outputTokens, { worst: 'partial', counts: { partial: 1, local_exact: 1 } });
    assert.deepEqual(quality.fields.inputTokens, { worst: 'local_exact', counts: { local_exact: 2 } });
    // 로그가 주지 않은 필드는 아예 등장하지 않습니다(R7).
    assert.ok(!('cacheWriteInputTokens' in quality.fields));
    assert.ok(!quality.reportedFields.includes('toolTokens'));
    assert.deepEqual(quality.sources, { local_log: 2 });
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('등급 사다리는 최저치를 고른다', () => {
  assert.equal(worstQuality('local_exact', 'partial'), 'partial');
  assert.equal(worstQuality('partial', 'unverified'), 'unverified');
  assert.equal(worstQuality('server_verified', 'local_exact'), 'local_exact');
  assert.equal(worstQuality(null, 'partial'), 'partial');
  assert.equal(worstQuality('partial', null), 'partial');
});

test('컬럼이 없는 옛 DB 를 열면 마이그레이션이 컬럼을 추가하고 기존 행을 보존한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-claude-migrate-'));
  const dbPath = path.join(root, 'usage.sqlite3');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_offset INTEGER NOT NULL,
        event_timestamp TEXT,
        observed_at TEXT NOT NULL,
        cwd TEXT,
        project_name TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cumulative_reset INTEGER NOT NULL DEFAULT 0,
        measurement_source TEXT NOT NULL DEFAULT 'local_log',
        measurement_quality TEXT NOT NULL DEFAULT 'observed',
        UNIQUE(provider, source_path, source_offset)
      );
      INSERT INTO usage_events (provider, session_id, source_path, source_offset, observed_at, total_tokens, output_tokens)
      VALUES ('codex', 'legacy-1', '/legacy.jsonl', 0, '2026-08-01T00:00:00.000Z', 500, 100);
    `);
    legacy.close();

    const store = new UsageStore(dbPath);
    try {
      const columns = new Set(store.db.prepare('PRAGMA table_info(usage_events)').all().map((row) => row.name));
      for (const column of ['tool_tokens', 'field_quality', 'parser_version', 'request_id', 'event_key']) {
        assert.ok(columns.has(column), `${column} 컬럼이 추가되지 않았습니다`);
      }
      // 기존 행은 그대로 남고, event_key 가 NULL 인 행이 부분 UNIQUE 인덱스와
      // 충돌하지 않아야 합니다.
      assert.equal(store.getProviderTotals('codex').totalTokens, 500);
      store.insertUsageEvent({
        type: 'usage', provider: 'codex',
        session: { provider: 'codex', sessionId: 'legacy-2', cwd: '/repo/y', projectName: 'y', model: 'm' },
        eventTimestamp: null,
        delta: { inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
      }, '/legacy.jsonl', 1);
      assert.equal(store.getProviderTotals('codex').eventCount, 2);
      // 새 원장 경로도 같은 DB 에서 동작합니다.
      store.upsertUsageEvent(claudeEvent(), '/claude.jsonl', 0);
      assert.equal(store.getProviderTotals('claude').totalTokens, 1610);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('transaction 은 실패 시 되돌린다', () => {
  const { root, store } = makeStore();
  try {
    assert.throws(() => store.transaction(() => {
      store.upsertUsageEvent(claudeEvent(), '/t/a.jsonl', 0);
      throw new Error('boom');
    }), /boom/);
    assert.equal(store.getProviderTotals('claude').eventCount, 0);

    store.transaction(() => {
      store.upsertUsageEvent(claudeEvent(), '/t/a.jsonl', 0);
    });
    assert.equal(store.getProviderTotals('claude').eventCount, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
