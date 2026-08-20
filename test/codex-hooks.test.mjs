import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCodexHooks, removeNyangCodexHooks } from '../service/providers/codex/hooks.mjs';

const command = "'/Applications/NyangTracker' --nyangtracker-hook";

test('hook merge preserves existing handlers and is idempotent', () => {
  const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] } };
  const once = mergeCodexHooks(existing, command);
  const twice = mergeCodexHooks(once, command);
  assert.equal(twice.hooks.Stop.length, 2);
  assert.equal(twice.hooks.Stop[0].hooks[0].command, 'echo keep-me');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    assert.equal(twice.hooks[event].filter((group) => group.hooks.some((hook) => hook.command?.includes('--nyangtracker-hook'))).length, 1);
  }
});

test('hook removal removes only NyangTracker handlers', () => {
  const merged = mergeCodexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] } }, command);
  const removed = removeNyangCodexHooks(merged);
  assert.equal(removed.hooks.Stop.length, 1);
  assert.equal(removed.hooks.Stop[0].hooks[0].command, 'echo keep-me');
  assert.equal(removed.hooks.SessionStart.length, 0);
});
