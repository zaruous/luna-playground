import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_HOOK_EVENTS,
  ClaudeHookInstaller,
  mergeClaudeHooks,
  removeNyangClaudeHooks,
} from '../service/providers/claude/hooks.mjs';
import { normalizeHookSignal } from '../service/hook-invocation.mjs';

const COMMAND = 'node /app/scripts/claude-hook.mjs --nyangtracker-hook';

function makeInstaller() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-claude-hooks-'));
  const claudeHome = path.join(root, '.claude');
  return {
    root,
    claudeHome,
    installer: new ClaudeHookInstaller({ claudeHomes: [claudeHome], command: COMMAND }),
    settingsPath: path.join(claudeHome, 'settings.json'),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('빈 설정에 설치하면 권고 이벤트 다섯 개가 들어간다', async () => {
  const env = makeInstaller();
  try {
    const before = await env.installer.status();
    assert.equal(before.installed, false);
    assert.equal(before.state, 'not_installed');

    const after = await env.installer.install();
    assert.equal(after.installed, true);
    assert.deepEqual(after.installedEvents, CLAUDE_HOOK_EVENTS);
    // UserPromptSubmit 은 prompt 본문을 받게 되므로 넣지 않습니다.
    assert.ok(!CLAUDE_HOOK_EVENTS.includes('UserPromptSubmit'));

    const config = JSON.parse(fs.readFileSync(env.settingsPath, 'utf8'));
    assert.deepEqual(Object.keys(config.hooks).sort(), [...CLAUDE_HOOK_EVENTS].sort());
    assert.equal(config.hooks.Stop[0].hooks[0].command, COMMAND);
    assert.equal(config.hooks.Stop[0].hooks[0].type, 'command');
  } finally {
    env.dispose();
  }
});

test('기존 설정과 사용자 hook 을 보존하며 병합하고, 반복 설치가 멱등이다', async () => {
  const env = makeInstaller();
  try {
    fs.mkdirSync(env.claudeHome, { recursive: true });
    fs.writeFileSync(env.settingsPath, `${JSON.stringify({
      model: 'claude-opus-5',
      theme: 'dark',
      env: { FOO: 'bar' },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop-hook' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-pre' }] }],
      },
    }, null, 2)}\n`);

    await env.installer.install();
    await env.installer.install();
    await env.installer.install();

    const config = JSON.parse(fs.readFileSync(env.settingsPath, 'utf8'));
    assert.equal(config.model, 'claude-opus-5');
    assert.equal(config.theme, 'dark');
    assert.deepEqual(config.env, { FOO: 'bar' });
    assert.equal(config.hooks.PreToolUse[0].hooks[0].command, 'echo user-pre');
    // 사용자 Stop hook 이 남고 우리 항목이 하나만 추가돼야 합니다.
    assert.equal(config.hooks.Stop.length, 2);
    assert.equal(config.hooks.Stop[0].hooks[0].command, 'echo user-stop-hook');
    assert.equal(config.hooks.Stop.filter((group) => group.hooks.some((handler) => handler.command === COMMAND)).length, 1);

    // 원본은 백업됩니다.
    const backup = JSON.parse(fs.readFileSync(`${env.settingsPath}.nyangtracker.bak`, 'utf8'));
    assert.equal(backup.hooks.Stop.length, 1);
  } finally {
    env.dispose();
  }
});

test('해제는 우리 항목만 지우고 나머지는 그대로 둔다', async () => {
  const env = makeInstaller();
  try {
    fs.mkdirSync(env.claudeHome, { recursive: true });
    fs.writeFileSync(env.settingsPath, `${JSON.stringify({
      model: 'claude-sonnet-5',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop-hook' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'echo user-notify' }] }],
      },
    }, null, 2)}\n`);

    await env.installer.install();
    const status = await env.installer.uninstall();
    assert.equal(status.installed, false);
    assert.deepEqual(status.installedEvents, []);

    const config = JSON.parse(fs.readFileSync(env.settingsPath, 'utf8'));
    assert.equal(config.model, 'claude-sonnet-5');
    assert.equal(config.hooks.Stop.length, 1);
    assert.equal(config.hooks.Stop[0].hooks[0].command, 'echo user-stop-hook');
    assert.equal(config.hooks.Notification[0].hooks[0].command, 'echo user-notify');
    // 우리 항목만 있던 이벤트는 빈 배열이 아니라 키 자체가 사라집니다.
    assert.ok(!('SubagentStop' in config.hooks));
  } finally {
    env.dispose();
  }
});

test('우리 항목만 있었다면 해제 후 hooks 껍데기를 남기지 않는다', () => {
  const merged = mergeClaudeHooks({ model: 'x' }, COMMAND);
  const cleaned = removeNyangClaudeHooks(merged);
  assert.deepEqual(cleaned, { model: 'x' });
});

test('settings.json 이 깨져 있으면 conflict 로 보고하고 덮어쓰지 않는다', async () => {
  const env = makeInstaller();
  try {
    fs.mkdirSync(env.claudeHome, { recursive: true });
    fs.writeFileSync(env.settingsPath, '{ this is not json');
    const status = await env.installer.status();
    assert.equal(status.installed, false);
    assert.equal(status.state, 'conflict');
    assert.match(status.error, /settings\.json/);
    await assert.rejects(() => env.installer.install(), /settings\.json/);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), '{ this is not json');
  } finally {
    env.dispose();
  }
});

test('일부만 설치된 상태는 partial 로 보고한다', async () => {
  const env = makeInstaller();
  try {
    fs.mkdirSync(env.claudeHome, { recursive: true });
    fs.writeFileSync(env.settingsPath, `${JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: COMMAND }] }] },
    }, null, 2)}\n`);
    const status = await env.installer.status();
    assert.equal(status.state, 'partial');
    assert.deepEqual(status.installedEvents, ['Stop']);
  } finally {
    env.dispose();
  }
});

test('hook 페이로드는 provider 를 실어 보내고 본문 필드는 버린다', () => {
  const signal = normalizeHookSignal({
    hook_event_name: 'Stop',
    session_id: 'sess-1',
    transcript_path: '/home/dev/.claude/projects/p/sess-1.jsonl',
    cwd: '/repo/cat-app',
    prompt: 'SENTINEL-PROMPT',
    last_assistant_message: 'SENTINEL-ASSISTANT',
    tool_input: { command: 'SENTINEL-COMMAND' },
  }, 'claude');

  assert.equal(signal.provider, 'claude');
  assert.equal(signal.hook_event_name, 'Stop');
  assert.equal(signal.transcript_path, '/home/dev/.claude/projects/p/sess-1.jsonl');
  const serialized = JSON.stringify(signal);
  assert.ok(!serialized.includes('SENTINEL'), '본문 필드가 신호에 실려 나갔습니다');
  assert.deepEqual(
    Object.keys(signal).sort(),
    ['cwd', 'hook_event_name', 'model', 'provider', 'session_id', 'transcript_path', 'turn_id'],
  );
});
