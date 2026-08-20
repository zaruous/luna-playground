import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../electron/usage/store.mjs';
import { CodexCollector } from '../electron/usage/providers/codex/collector.mjs';

test('incremental scan keeps session metadata and does not double count', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-collector-'));
  const codexHome = path.join(root, '.codex');
  const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '20');
  const filePath = path.join(sessionDir, 'rollout-33333333-3333-4333-8333-333333333333.jsonl');
  fs.mkdirSync(sessionDir, { recursive: true });
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new CodexCollector({ store, codexHome });

  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ timestamp:'2026-08-20T10:00:00.000Z', type:'session_meta', payload:{ id:'33333333-3333-4333-8333-333333333333', cwd:'/repo/cat-app' } }),
      JSON.stringify({ timestamp:'2026-08-20T10:00:01.000Z', type:'turn_context', payload:{ cwd:'/repo/cat-app', model:'gpt-test' } }),
      JSON.stringify({ timestamp:'2026-08-20T10:00:02.000Z', type:'event_msg', payload:{ type:'token_count', info:{ total_token_usage:{ input_tokens:100, cached_input_tokens:80, output_tokens:20, total_tokens:120 } } } }),
      '',
    ].join('\n'));

    await collector.scanFile(filePath, 'test:first');
    assert.equal(store.getProviderTotals('codex').totalTokens, 120);
    assert.equal(store.getRecentProjects('codex')[0].name, 'cat-app');

    fs.appendFileSync(filePath, `${JSON.stringify({ timestamp:'2026-08-20T10:00:03.000Z', type:'event_msg', payload:{ type:'token_count', info:{ total_token_usage:{ input_tokens:180, cached_input_tokens:120, output_tokens:40, total_tokens:220 } } } })}\n`);
    await collector.scanFile(filePath, 'test:append');
    await collector.scanFile(filePath, 'test:duplicate-scan');

    const totals = store.getProviderTotals('codex');
    assert.equal(totals.totalTokens, 220);
    assert.equal(totals.cachedInputTokens, 120);
    const project = store.getRecentProjects('codex')[0];
    assert.equal(project.name, 'cat-app');
    assert.equal(project.model, 'gpt-test');
    assert.equal(project.totalTokens, 220);
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});
