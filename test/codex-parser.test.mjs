import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexParserState, parseCodexRolloutLine } from '../electron/usage/providers/codex/parser.mjs';

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
