import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../service/store.mjs';
import { ClaudeCollector } from '../service/providers/claude/collector.mjs';

const CWD = 'C:\\Users\\dev\\git\\node\\cat-app';
const PROJECT_DIR = 'C--Users-dev-git-node-cat-app';

function makeEnv(prefix = 'nyang-claude-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const claudeHome = path.join(root, '.claude');
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new ClaudeCollector({ store, claudeHomes: [claudeHome] });
  return {
    root,
    claudeHome,
    store,
    collector,
    dispose() {
      collector.stop();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function assistantLine({
  sessionId, messageId, requestId, output, input = 10, cacheRead = 1000, cacheWrite = 100,
  thinking = null, timestamp = '2026-08-21T01:00:00.000Z', cwd = CWD, version = '2.1.232',
  block = 'text', sidechain = false, agentId = null, model = 'claude-opus-5',
}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${messageId}-${block}-${output}`,
    isSidechain: sidechain,
    ...(agentId ? { agentId, attributionAgent: 'Explore' } : {}),
    requestId,
    timestamp,
    sessionId,
    cwd,
    version,
    gitBranch: 'main',
    message: {
      id: messageId,
      role: 'assistant',
      model,
      content: [{ type: block, text: 'SENTINEL-ASSISTANT-TEXT' }],
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
        ...(thinking == null ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
        cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
}

function sessionFile(claudeHome, sessionId, projectDir = PROJECT_DIR) {
  const dir = path.join(claudeHome, 'projects', projectDir);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

test('과거 스캔은 멱등이고 증분 tail 은 증분만 반영한다', async () => {
  const env = makeEnv();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const filePath = sessionFile(env.claudeHome, sessionId);
  try {
    fs.writeFileSync(filePath, `${assistantLine({ sessionId, messageId: 'msg_1', requestId: 'req_1', output: 500, thinking: 200 })}\n`);

    await env.collector.reconcile('test:first');
    const first = env.store.getProviderTotals('claude');
    assert.equal(first.totalTokens, 10 + 1000 + 100 + 500);
    assert.equal(first.reasoningTokens, 200);
    assert.equal(first.eventCount, 1);
    assert.equal(env.store.getRecentProjects('claude')[0].name, 'cat-app');

    // 같은 파일을 다시 읽어도 합계가 늘지 않아야 합니다.
    await env.collector.reconcile('test:idempotent');
    assert.deepEqual(env.store.getProviderTotals('claude'), first);

    fs.appendFileSync(filePath, `${assistantLine({ sessionId, messageId: 'msg_2', requestId: 'req_2', output: 700, thinking: 100 })}\n`);
    await env.collector.reconcile('test:append');
    const second = env.store.getProviderTotals('claude');
    assert.equal(second.eventCount, 2);
    assert.equal(second.totalTokens, first.totalTokens + 10 + 1000 + 100 + 700);
  } finally {
    env.dispose();
  }
});

test('content block 으로 쪼개진 같은 요청은 한 번만, 최종값으로 계상된다', async () => {
  const env = makeEnv();
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const filePath = sessionFile(env.claudeHome, sessionId);
  try {
    // 실측 모양: thinking 블록 레코드가 스트리밍 중간값(output 5)을 담고,
    // 뒤따르는 tool_use 레코드가 최종값(output 301)을 담습니다.
    fs.writeFileSync(filePath, [
      assistantLine({ sessionId, messageId: 'msg_split', requestId: 'req_split', output: 5, block: 'thinking' }),
      assistantLine({ sessionId, messageId: 'msg_split', requestId: 'req_split', output: 301, block: 'tool_use' }),
      '',
    ].join('\n'));

    await env.collector.reconcile('test:split');
    const totals = env.store.getProviderTotals('claude');
    assert.equal(totals.eventCount, 1, '같은 요청이 두 행으로 들어갔습니다');
    assert.equal(totals.outputTokens, 301, 'last-wins 가 아니라 중간값이 남았습니다');
    assert.equal(totals.cachedInputTokens, 1000, '캐시 읽기가 두 번 더해졌습니다');
  } finally {
    env.dispose();
  }
});

test('세션 resume 으로 transcript 가 복사돼도 두 번 세지 않고, 0 인 사본이 실측값을 덮지 않는다', async () => {
  const env = makeEnv();
  const original = '33333333-3333-4333-8333-333333333333';
  const resumed = '44444444-4444-4444-8444-444444444444';
  try {
    fs.writeFileSync(
      sessionFile(env.claudeHome, original),
      `${assistantLine({ sessionId: original, messageId: 'msg_dup', requestId: 'req_dup', output: 858 })}\n`,
    );
    // resume 사본은 같은 message/request id 를 갖지만 사용량이 0 으로 남을 수
    // 있습니다(실측 1건). 파일 순서에 따라 이것이 뒤에 읽혀도 858 이 남아야 합니다.
    fs.writeFileSync(
      sessionFile(env.claudeHome, resumed),
      `${assistantLine({ sessionId: resumed, messageId: 'msg_dup', requestId: 'req_dup', output: 0, input: 0, cacheRead: 0, cacheWrite: 0 })}\n`,
    );

    await env.collector.reconcile('test:resume');
    const totals = env.store.getProviderTotals('claude');
    assert.equal(totals.eventCount, 1, '파일 단위로 중복 제거하면 여기서 부풀어 오릅니다');
    assert.equal(totals.outputTokens, 858);
  } finally {
    env.dispose();
  }
});

test('서브에이전트 사용량은 부모 세션으로 한 번만 계상되고 부모 롤업은 무시된다', async () => {
  const env = makeEnv();
  const parent = '55555555-5555-4555-8555-555555555555';
  try {
    const parentPath = sessionFile(env.claudeHome, parent);
    fs.writeFileSync(parentPath, [
      assistantLine({ sessionId: parent, messageId: 'msg_parent', requestId: 'req_parent', output: 200 }),
      // 부모 transcript 의 서브에이전트 요약. 토큰이 적혀 있지만 계상하면 이중 계상입니다.
      JSON.stringify({
        type: 'user',
        sessionId: parent,
        toolUseResult: {
          status: 'completed',
          prompt: 'SENTINEL-PROMPT',
          agentId: 'a1',
          totalTokens: 99999,
          usage: { input_tokens: 2, cache_creation_input_tokens: 399, cache_read_input_tokens: 102797, output_tokens: 2089 },
        },
      }),
      '',
    ].join('\n'));

    const subDir = path.join(env.claudeHome, 'projects', PROJECT_DIR, parent, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-a1.jsonl'), [
      assistantLine({ sessionId: parent, messageId: 'msg_sub', requestId: 'req_sub', output: 2089, sidechain: true, agentId: 'a1' }),
      '',
    ].join('\n'));

    await env.collector.reconcile('test:subagent');
    const totals = env.store.getProviderTotals('claude');
    assert.equal(totals.eventCount, 2, '서브에이전트 요청 + 부모 요청 = 2건이어야 합니다');
    assert.equal(totals.outputTokens, 200 + 2089);
    // 서브에이전트도 부모 세션·프로젝트로 귀속됩니다.
    const projects = env.store.getRecentProjects('claude');
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'cat-app');
  } finally {
    env.dispose();
  }
});

test('저장된 offset 에서 재시작해도 이중 계상하지 않는다', async () => {
  const env = makeEnv();
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const filePath = sessionFile(env.claudeHome, sessionId);
  try {
    fs.writeFileSync(filePath, `${assistantLine({ sessionId, messageId: 'msg_a', requestId: 'req_a', output: 100 })}\n`);
    await env.collector.reconcile('test:before-restart');

    // 프로세스 재시작을 흉내내: 같은 DB 에 새 수집기를 붙입니다.
    env.collector.stop();
    const restarted = new ClaudeCollector({ store: env.store, claudeHomes: [env.claudeHome] });
    fs.appendFileSync(filePath, `${assistantLine({ sessionId, messageId: 'msg_b', requestId: 'req_b', output: 300 })}\n`);
    await restarted.reconcile('test:after-restart');
    restarted.stop();

    const totals = env.store.getProviderTotals('claude');
    assert.equal(totals.eventCount, 2);
    assert.equal(totals.outputTokens, 400);
  } finally {
    env.dispose();
  }
});

test('불완전한 마지막 줄은 다음 append 까지 버퍼링된다', async () => {
  const env = makeEnv();
  const sessionId = '77777777-7777-4777-8777-777777777777';
  const filePath = sessionFile(env.claudeHome, sessionId);
  try {
    const complete = assistantLine({ sessionId, messageId: 'msg_c1', requestId: 'req_c1', output: 100 });
    const partial = assistantLine({ sessionId, messageId: 'msg_c2', requestId: 'req_c2', output: 250 });
    const cut = partial.slice(0, Math.floor(partial.length / 2));
    fs.writeFileSync(filePath, `${complete}\n${cut}`);

    await env.collector.reconcile('test:partial');
    assert.equal(env.store.getProviderTotals('claude').eventCount, 1);
    assert.equal(env.store.getProviderTotals('claude').outputTokens, 100);
    assert.equal(env.store.getScanState('claude', filePath).byteOffset, Buffer.byteLength(`${complete}\n`));

    fs.writeFileSync(filePath, `${complete}\n${partial}\n`);
    await env.collector.reconcile('test:partial-completed');
    const totals = env.store.getProviderTotals('claude');
    assert.equal(totals.eventCount, 2);
    assert.equal(totals.outputTokens, 350);
  } finally {
    env.dispose();
  }
});

test('파일이 잘리면 안전 재스캔으로 폴백하고 합계가 부풀지 않는다', async () => {
  const env = makeEnv();
  const sessionId = '88888888-8888-4888-8888-888888888888';
  const filePath = sessionFile(env.claudeHome, sessionId);
  try {
    fs.writeFileSync(filePath, [
      assistantLine({ sessionId, messageId: 'msg_t1', requestId: 'req_t1', output: 100 }),
      assistantLine({ sessionId, messageId: 'msg_t2', requestId: 'req_t2', output: 200 }),
      '',
    ].join('\n'));
    await env.collector.reconcile('test:truncate-before');
    assert.equal(env.store.getProviderTotals('claude').eventCount, 2);

    // 로테이션/교체: 파일이 더 짧아졌습니다.
    fs.writeFileSync(filePath, `${assistantLine({ sessionId, messageId: 'msg_t1', requestId: 'req_t1', output: 100 })}\n`);
    await env.collector.reconcile('test:truncate-after');

    const totals = env.store.getProviderTotals('claude');
    // 이미 관측한 두 요청은 원장에 남고, 재스캔이 값을 부풀리지 않습니다.
    assert.equal(totals.eventCount, 2);
    assert.equal(totals.outputTokens, 300);
  } finally {
    env.dispose();
  }
});

test('여러 프로젝트 디렉터리를 각각 귀속하고 감시 대상만 watch 한다', async () => {
  const env = makeEnv();
  try {
    fs.writeFileSync(
      sessionFile(env.claudeHome, 'aaaa1111-1111-4111-8111-111111111111', 'C--Users-dev-git-node-cat-app'),
      `${assistantLine({ sessionId: 'aaaa1111-1111-4111-8111-111111111111', messageId: 'msg_p1', requestId: 'req_p1', output: 100, cwd: 'C:\\Users\\dev\\git\\node\\cat-app' })}\n`,
    );
    fs.writeFileSync(
      sessionFile(env.claudeHome, 'bbbb2222-2222-4222-8222-222222222222', 'C--Users-dev-git-node-dog-app'),
      `${assistantLine({ sessionId: 'bbbb2222-2222-4222-8222-222222222222', messageId: 'msg_p2', requestId: 'req_p2', output: 200, cwd: 'C:\\Users\\dev\\git\\node\\dog-app' })}\n`,
    );

    await env.collector.reconcile('test:multi-project');
    const projects = env.store.getRecentProjects('claude').map((project) => project.name).sort();
    assert.deepEqual(projects, ['cat-app', 'dog-app']);
    const status = env.collector.getStatus();
    assert.equal(status.filesDiscovered, 2);
    assert.equal(status.detected, true);
    assert.equal(status.ledgerAvailable, true);
  } finally {
    env.dispose();
  }
});

test('~/.claude 가 없으면 감지 실패로 남고 원장을 만들지 않는다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-claude-none-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new ClaudeCollector({ store, claudeHomes: [path.join(root, 'nope')] });
  try {
    const result = await collector.reconcile('test:missing');
    assert.equal(result.changed, false);
    assert.equal(result.files, 0);
    assert.equal(collector.getStatus().detected, false);
    assert.equal(collector.getStatus().ledgerAvailable, false);
    assert.equal(store.getProviderTotals('claude').eventCount, 0);
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hook 신호는 재스캔을 유발할 뿐 토큰을 만들지 않는다', async () => {
  const env = makeEnv();
  const sessionId = '99999999-9999-4999-8999-999999999999';
  const filePath = sessionFile(env.claudeHome, sessionId);
  try {
    fs.writeFileSync(filePath, `${assistantLine({ sessionId, messageId: 'msg_h', requestId: 'req_h', output: 400 })}\n`);
    const hookEvents = [];
    env.collector.on('hook', (event) => hookEvents.push(event));

    await env.collector.handleHookSignal({
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: filePath,
      // hook 페이로드에 본문이 실려 와도 저장되지 않아야 합니다.
      prompt: 'SENTINEL-PROMPT',
      last_assistant_message: 'SENTINEL-ASSISTANT',
    });

    const totals = env.store.getProviderTotals('claude');
    assert.equal(totals.eventCount, 1);
    assert.equal(totals.outputTokens, 400);
    assert.equal(hookEvents.length, 1);
    assert.deepEqual(Object.keys(hookEvents[0]).sort(), ['hook_event_name', 'session_id']);

    // 같은 hook 을 또 받아도 늘지 않습니다.
    await env.collector.handleHookSignal({ hook_event_name: 'Stop', transcript_path: filePath });
    assert.equal(env.store.getProviderTotals('claude').eventCount, 1);
  } finally {
    env.dispose();
  }
});

test('tool-results 디렉터리는 아예 읽지 않는다', async () => {
  const env = makeEnv();
  const sessionId = 'cccc3333-3333-4333-8333-333333333333';
  try {
    fs.writeFileSync(
      sessionFile(env.claudeHome, sessionId),
      `${assistantLine({ sessionId, messageId: 'msg_ok', requestId: 'req_ok', output: 100 })}\n`,
    );
    const toolResults = path.join(env.claudeHome, 'projects', PROJECT_DIR, sessionId, 'tool-results');
    fs.mkdirSync(toolResults, { recursive: true });
    fs.writeFileSync(
      path.join(toolResults, 'blob.jsonl'),
      `${assistantLine({ sessionId, messageId: 'msg_tool', requestId: 'req_tool', output: 5000 })}\n`,
    );

    await env.collector.reconcile('test:tool-results');
    assert.equal(env.collector.getStatus().filesDiscovered, 1);
    assert.equal(env.store.getProviderTotals('claude').outputTokens, 100);
  } finally {
    env.dispose();
  }
});

test('reconcile 는 겹친 패스를 합치고 실패 뒤에도 다시 돈다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-claude-reconcile-guard-'));
  const claudeHome = path.join(root, '.claude');
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new ClaudeCollector({ store, claudeHomes: [claudeHome] });
  try {
    await collector.detect();
    assert.equal(collector.getStatus().detected, true);

    let discoverCalls = 0;
    let releaseDiscover;
    let discoverEntered;
    const discoverGate = new Promise((resolve) => { discoverEntered = resolve; });
    collector.discoverFiles = async () => {
      discoverCalls += 1;
      discoverEntered();
      await new Promise((resolve) => { releaseDiscover = resolve; });
      return [];
    };
    collector.refreshWatchers = async () => {};

    const first = collector.reconcile('overlap-a');
    const second = collector.reconcile('overlap-b');
    await discoverGate;
    assert.equal(first, second);
    assert.equal(discoverCalls, 1);

    releaseDiscover();
    await first;

    discoverCalls = 0;
    collector.discoverFiles = async () => { discoverCalls += 1; return []; };
    await collector.reconcile('after-first');
    assert.equal(discoverCalls, 1);

    collector.discoverFiles = async () => { throw new Error('discover failed'); };
    const failed = await collector.reconcile('fail');
    assert.match(failed.error, /discover failed/);

    discoverCalls = 0;
    collector.discoverFiles = async () => { discoverCalls += 1; return []; };
    await collector.reconcile('recover');
    assert.equal(discoverCalls, 1);
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
