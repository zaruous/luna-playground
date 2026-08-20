import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore } from '../service/store.mjs';
import { createCodexParserState, parseCodexRolloutLine } from '../service/providers/codex/parser.mjs';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyangtracker-test-'));
  return { dir, store: new UsageStore(path.join(dir, 'usage.sqlite3')) };
}

test('store aggregates delta usage and flags server-only movement', () => {
  const { dir, store } = tempStore();
  try {
    const filePath = path.join(dir, 'rollout-22222222-2222-4222-8222-222222222222.jsonl');
    const state = createCodexParserState({ filePath });
    const lines = [
      { timestamp:'2026-08-20T10:00:00.000Z', type:'session_meta', payload:{ id:'22222222-2222-4222-8222-222222222222', cwd:'/work/a' } },
      { timestamp:'2026-08-20T10:00:01.000Z', type:'event_msg', payload:{ type:'token_count', info:{ total_token_usage:{ input_tokens:100, cached_input_tokens:40, output_tokens:20, reasoning_output_tokens:5, total_tokens:120 } }, rate_limits:{ primary:{ used_percent:10, window_minutes:300, resets_at:99 } } } },
      { timestamp:'2026-08-20T10:00:02.000Z', type:'event_msg', payload:{ type:'token_count', info:{ total_token_usage:{ input_tokens:150, cached_input_tokens:60, output_tokens:30, reasoning_output_tokens:8, total_tokens:180 } }, rate_limits:{ primary:{ used_percent:11, window_minutes:300, resets_at:99 } } } },
    ];
    let offset = 0;
    for (const raw of lines) {
      offset += 100;
      for (const event of parseCodexRolloutLine(JSON.stringify(raw), state)) {
        if (event.type === 'session') store.upsertSession(event.session, filePath, '2026-08-20T10:00:00.000Z');
        if (event.type === 'usage') store.insertUsageEvent(event, filePath, offset, raw.timestamp);
        if (event.type === 'rate_limits') store.insertRateLimits(event, filePath, offset, raw.timestamp);
      }
    }
    const totals = store.getProviderTotals('codex');
    assert.equal(totals.totalTokens, 180);
    assert.equal(totals.cachedInputTokens, 60);
    const recent = store.getRecentReconciliation('codex');
    assert.equal(recent[0].classification, 'MATCHED_ACTIVITY');

    store.insertRateLimits({
      session: state.session,
      eventTimestamp: '2026-08-20T10:05:00.000Z',
      rateLimits: { limitId:null, limitName:null, primary:{ usedPercent:14, windowMinutes:300, resetsAt:99 }, secondary:null },
    }, filePath, 999, '2026-08-20T10:05:00.000Z');
    assert.equal(store.getRecentReconciliation('codex')[0].classification, 'SERVER_ONLY_CHANGE');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('store keeps multiple Codex limit ids isolated', () => {
  const { dir, store } = tempStore();
  try {
    const session = { provider:'codex', sessionId:'limits-session', projectName:'limits', model:'gpt-test' };
    store.insertRateLimits({
      provider:'codex', session, eventTimestamp:'2026-08-20T10:00:00.000Z',
      rateLimits:{ limitId:'codex', limitName:'Codex', primary:{ usedPercent:20, windowMinutes:300, resetsAt:100 }, secondary:null },
    }, '/tmp/limits.jsonl', 100, '2026-08-20T10:00:00.000Z');
    store.insertRateLimits({
      provider:'codex', session, eventTimestamp:'2026-08-20T10:00:01.000Z',
      rateLimits:{ limitId:'codex-spark', limitName:'Codex Spark', primary:{ usedPercent:70, windowMinutes:300, resetsAt:200 }, secondary:null },
    }, '/tmp/limits.jsonl', 200, '2026-08-20T10:00:01.000Z');
    const rateLimits = store.getLatestRateLimits('codex');
    assert.equal(rateLimits.limits.length, 2);
    assert.equal(rateLimits.primary.usedPercent, 20);
    assert.equal(rateLimits.limits.find((limit) => limit.limitId === 'codex_spark').windows.primary.usedPercent, 70);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('common store accepts normalized usage from another provider', () => {
  const { dir, store } = tempStore();
  try {
    store.insertUsageEvent({
      provider:'claude', eventTimestamp:'2026-08-20T11:00:00.000Z',
      session:{ provider:'claude', sessionId:'claude-session', projectName:'shared-app', model:'claude-test' },
      delta:{ inputTokens:100, cachedInputTokens:20, cacheWriteInputTokens:10, outputTokens:30, reasoningTokens:0, totalTokens:130 },
      measurementQuality:'local_exact',
    }, '/tmp/claude.jsonl', 100, '2026-08-20T11:00:00.000Z');
    assert.equal(store.getProviderTotals('claude').totalTokens, 130);
    assert.equal(store.getRecentProjectsAcrossProviders()[0].provider, 'claude');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('store upgrades the legacy reconciliation and scan-state schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyangtracker-migrate-'));
  const dbPath = path.join(dir, 'usage.sqlite3');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE reconciliation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      window_type TEXT NOT NULL,
      from_observed_at TEXT NOT NULL,
      to_observed_at TEXT NOT NULL,
      server_usage_delta REAL,
      local_token_delta INTEGER NOT NULL DEFAULT 0,
      classification TEXT NOT NULL,
      confidence TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(provider, window_type, from_observed_at, to_observed_at)
    );
    CREATE TABLE scan_state (
      source_path TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      mtime_ms REAL,
      last_input_tokens INTEGER NOT NULL DEFAULT 0,
      last_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      last_cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
      last_output_tokens INTEGER NOT NULL DEFAULT 0,
      last_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      last_total_tokens INTEGER NOT NULL DEFAULT 0,
      last_session_id TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO scan_state (source_path, byte_offset, file_size, updated_at)
    VALUES ('legacy.jsonl', 10, 10, '2026-08-20T00:00:00.000Z');
  `);
  legacy.close();
  const store = new UsageStore(dbPath);
  try {
    const columns = store.db.prepare('PRAGMA table_info(reconciliation_events)').all().map((row) => row.name);
    assert.ok(columns.includes('limit_id'));
    assert.ok(columns.includes('window_minutes'));
    assert.equal(store.getScanState('codex', 'legacy.jsonl').byteOffset, 10);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});
