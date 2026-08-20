import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexParserState, parseCodexRolloutLine } from '../service/providers/codex/parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/codex-rollout.jsonl'), 'utf8').trim().split('\n');

test('Codex parser normalizes metadata, cumulative deltas, cache write and rate limits', () => {
  const state = createCodexParserState({ filePath: '/tmp/rollout-11111111-1111-4111-8111-111111111111.jsonl' });
  const events = fixture.flatMap((line) => parseCodexRolloutLine(line, state));
  const usage = events.filter((event) => event.type === 'usage');
  const rates = events.filter((event) => event.type === 'rate_limits');
  assert.equal(state.session.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(state.session.projectName, 'nyangtracker');
  assert.equal(state.session.model, 'gpt-test');
  assert.equal(usage.length, 2);
  assert.deepEqual(usage[0].delta, {
    inputTokens: 1000,
    cachedInputTokens: 600,
    cacheWriteInputTokens: 100,
    outputTokens: 200,
    reasoningTokens: 50,
    totalTokens: 1200,
  });
  assert.deepEqual(usage[1].delta, {
    inputTokens: 500,
    cachedInputTokens: 300,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningTokens: 25,
    totalTokens: 600,
  });
  assert.equal(rates[1].rateLimits.primary.usedPercent, 22);
  assert.equal(rates[1].rateLimits.secondary.windowMinutes, 10080);
});

test('Duplicate cumulative token_count emits no duplicate usage event', () => {
  const state = createCodexParserState({ filePath: '/tmp/session.jsonl' });
  const line = fixture[2];
  const first = parseCodexRolloutLine(line, state).filter((event) => event.type === 'usage');
  const second = parseCodexRolloutLine(line, state).filter((event) => event.type === 'usage');
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test('Rate-limit-only refresh does not replay stale last_token_usage', () => {
  const state = createCodexParserState({ filePath: '/tmp/session.jsonl' });
  const usage = { input_tokens:100, cached_input_tokens:40, output_tokens:20, total_tokens:120 };
  const first = {
    timestamp:'2026-08-20T10:00:00.000Z', type:'event_msg',
    payload:{ type:'token_count', info:{ total_token_usage:usage, last_token_usage:usage }, rate_limits:{ primary:{ used_percent:10, window_minutes:300 } } },
  };
  const refreshed = {
    ...first,
    timestamp:'2026-08-20T10:00:01.000Z',
    payload:{ ...first.payload, rate_limits:{ primary:{ used_percent:11, window_minutes:300 } } },
  };
  const events = [first, refreshed].flatMap((item) => parseCodexRolloutLine(JSON.stringify(item), state));
  assert.equal(events.filter((event) => event.type === 'usage').length, 1);
  assert.equal(events.filter((event) => event.type === 'rate_limits').length, 2);
});

test('Small cumulative regression is treated as a stale snapshot', () => {
  const state = createCodexParserState({ filePath: '/tmp/session.jsonl' });
  const tokenLine = (timestamp, total, last) => JSON.stringify({
    timestamp, type:'event_msg', payload:{ type:'token_count', info:{
      total_token_usage:{ input_tokens:total - 20, output_tokens:20, total_tokens:total },
      last_token_usage:{ input_tokens:last, output_tokens:0, total_tokens:last },
    } },
  });
  const events = [
    tokenLine('2026-08-20T10:00:00.000Z', 1000, 1000),
    tokenLine('2026-08-20T10:00:01.000Z', 990, 10),
    tokenLine('2026-08-20T10:00:02.000Z', 1010, 10),
  ].flatMap((line) => parseCodexRolloutLine(line, state)).filter((event) => event.type === 'usage');
  assert.equal(events.length, 2);
  assert.equal(events[1].delta.totalTokens, 10);
  assert.equal(events[1].cumulativeReset, false);
});

test('Large cumulative reset counts only the reported last increment', () => {
  const state = createCodexParserState({ filePath: '/tmp/session.jsonl' });
  const first = JSON.stringify({ timestamp:'2026-08-20T10:00:00.000Z', type:'event_msg', payload:{ type:'token_count', info:{
    total_token_usage:{ input_tokens:900, output_tokens:100, total_tokens:1000 },
    last_token_usage:{ input_tokens:900, output_tokens:100, total_tokens:1000 },
  } } });
  const reset = JSON.stringify({ timestamp:'2026-08-20T10:01:00.000Z', type:'event_msg', payload:{ type:'token_count', info:{
    total_token_usage:{ input_tokens:80, output_tokens:20, total_tokens:100 },
    last_token_usage:{ input_tokens:15, output_tokens:5, total_tokens:20 },
  } } });
  parseCodexRolloutLine(first, state);
  const event = parseCodexRolloutLine(reset, state).find((item) => item.type === 'usage');
  assert.equal(event.delta.totalTokens, 20);
  assert.equal(event.cumulativeReset, true);
  assert.equal(event.incrementSource, 'last_token_usage');
});
