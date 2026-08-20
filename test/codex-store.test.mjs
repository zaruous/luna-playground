import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../electron/usage/store.mjs';
import { createCodexParserState, parseCodexRolloutLine } from '../electron/usage/providers/codex/parser.mjs';

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
