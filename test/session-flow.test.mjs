// 세션 흐름 계층(턴 원장 · 단계 분류 · 컨텍스트 곡선) 테스트.
// 설계는 docs/dev/menus/session.md 이고, 이 파일이 그 완료 기준을 검사합니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../service/store.mjs';
import { ClaudeCollector } from '../service/providers/claude/collector.mjs';
import { CodexCollector } from '../service/providers/codex/collector.mjs';
import { CLAUDE_PARSER_VERSION } from '../service/providers/claude/parser.mjs';
import {
  PHASES,
  dominantPhase,
  phaseOfTool,
  splitTokensByPhase,
} from '../service/providers/tool-phases.mjs';

const CWD = 'C:\\Users\\dev\\git\\node\\flow-app';
const PROJECT_DIR = 'C--Users-dev-git-node-flow-app';
const SESSION = 'f10a0000-0000-4000-8000-000000000001';

function claudeEnv(prefix = 'nyang-flow-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const claudeHome = path.join(root, '.claude');
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new ClaudeCollector({ store, claudeHomes: [claudeHome] });
  return {
    root,
    claudeHome,
    store,
    collector,
    projectDir: path.join(claudeHome, 'projects', PROJECT_DIR),
    dispose() {
      collector.stop();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function humanPrompt(at, text = 'SENTINEL-PROMPT') {
  return JSON.stringify({
    type: 'user', sessionId: SESSION, cwd: CWD, timestamp: at,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function toolResult(at) {
  return JSON.stringify({
    type: 'user', sessionId: SESSION, cwd: CWD, timestamp: at,
    toolUseResult: { stdout: 'SENTINEL-TOOL-OUTPUT' },
    message: { role: 'user', content: [{ type: 'tool_result', content: 'SENTINEL-TOOL-OUTPUT' }] },
  });
}

function compactBoundary(at) {
  return JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: SESSION, timestamp: at });
}

function assistant({ at, messageId, requestId, output = 100, cacheRead = 1000, tools = [] }) {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${messageId}-${output}`,
    requestId,
    timestamp: at,
    sessionId: SESSION,
    cwd: CWD,
    version: '2.1.232',
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-opus-5',
      content: [
        { type: 'text', text: 'SENTINEL-ASSISTANT-TEXT' },
        ...tools.map((tool, index) => ({
          type: 'tool_use',
          id: `t${index}`,
          name: tool.name,
          // input 은 도구 payload 입니다. 파서는 경로 세 키만 봐야 합니다.
          input: { command: 'SENTINEL-TOOL-INPUT', file_path: tool.file ?? undefined },
        })),
      ],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
        output_tokens_details: { thinking_tokens: 20 },
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
}

test('사람 프롬프트가 턴을 열고 도구 결과는 턴을 열지 않는다', async () => {
  const env = claudeEnv();
  try {
    fs.mkdirSync(env.projectDir, { recursive: true });
    fs.writeFileSync(path.join(env.projectDir, `${SESSION}.jsonl`), [
      humanPrompt('2026-08-21T01:00:00.000Z'),
      assistant({ at: '2026-08-21T01:00:01.000Z', messageId: 'msg_1', requestId: 'req_1', output: 100, tools: [{ name: 'Read', file: '/repo/a/one.md' }] }),
      toolResult('2026-08-21T01:00:02.000Z'),
      assistant({ at: '2026-08-21T01:00:03.000Z', messageId: 'msg_2', requestId: 'req_2', output: 200, tools: [{ name: 'Edit', file: '/repo/a/one.md' }] }),
      humanPrompt('2026-08-21T01:05:00.000Z'),
      assistant({ at: '2026-08-21T01:05:01.000Z', messageId: 'msg_3', requestId: 'req_3', output: 300, tools: [{ name: 'Bash' }] }),
      '',
    ].join('\n'));

    await env.collector.reconcile('test:turns');
    const flow = env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION });

    // 프롬프트 2개 → 턴 2개. 도구 결과는 경계가 아닙니다.
    assert.equal(flow.session.turnCount, 2);
    assert.equal(flow.turns.length, 2);
    assert.deepEqual(flow.turns.map((turn) => turn.turnIndex), [1, 2]);
    assert.equal(flow.turns[0].requestCount, 2, '턴 1 에 두 요청이 붙어야 합니다');
    assert.equal(flow.turns[1].requestCount, 1);
    assert.equal(flow.turns[0].startedAt, '2026-08-21T01:00:00.000Z');

    // 완료 기준: 턴 토큰 합 == 세션 토큰 합
    const turnSum = flow.turns.reduce((sum, turn) => sum + turn.totalTokens, 0);
    assert.equal(turnSum, flow.session.promptTokens + flow.session.tokens.outputTokens);

    // 도구 이름은 남고 개수가 맞아야 합니다.
    assert.deepEqual(flow.turns[0].toolCounts, { Read: 1, Edit: 1 });
    assert.deepEqual(flow.turns[1].toolCounts, { Bash: 1 });
    assert.equal(flow.turns[1].phase, 'verify');
  } finally {
    env.dispose();
  }
});

test('컴팩션 경계가 다음 턴에 표시되고 곡선에도 실린다', async () => {
  const env = claudeEnv();
  try {
    fs.mkdirSync(env.projectDir, { recursive: true });
    fs.writeFileSync(path.join(env.projectDir, `${SESSION}.jsonl`), [
      humanPrompt('2026-08-21T02:00:00.000Z'),
      assistant({ at: '2026-08-21T02:00:01.000Z', messageId: 'msg_a', requestId: 'req_a', cacheRead: 90000 }),
      compactBoundary('2026-08-21T02:01:00.000Z'),
      humanPrompt('2026-08-21T02:01:30.000Z'),
      assistant({ at: '2026-08-21T02:01:31.000Z', messageId: 'msg_b', requestId: 'req_b', cacheRead: 1000 }),
      '',
    ].join('\n'));

    await env.collector.reconcile('test:compact');
    const flow = env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION });
    assert.equal(flow.turns.length, 2);
    assert.equal(flow.turns[0].compacted, false);
    assert.equal(flow.turns[1].compacted, true, '컴팩션 뒤에 열린 턴에 표시가 붙어야 합니다');
    assert.equal(flow.session.compactionCount, 1);
    assert.ok(flow.curve.some((point) => point.compacted), '곡선에 컴팩션 지점이 있어야 합니다');
    // 컴팩션 직후 프롬프트가 실제로 줄었는지 — 곡선이 설명하려는 현상입니다.
    assert.ok(flow.curve[flow.curve.length - 1].promptTokens < flow.curve[0].promptTokens);
  } finally {
    env.dispose();
  }
});

test('재스캔해도 턴 수와 턴 토큰이 늘지 않는다', async () => {
  const env = claudeEnv();
  try {
    fs.mkdirSync(env.projectDir, { recursive: true });
    fs.writeFileSync(path.join(env.projectDir, `${SESSION}.jsonl`), [
      humanPrompt('2026-08-21T03:00:00.000Z'),
      assistant({ at: '2026-08-21T03:00:01.000Z', messageId: 'msg_1', requestId: 'req_1', tools: [{ name: 'Read' }] }),
      humanPrompt('2026-08-21T03:01:00.000Z'),
      assistant({ at: '2026-08-21T03:01:01.000Z', messageId: 'msg_2', requestId: 'req_2', tools: [{ name: 'Edit' }] }),
      '',
    ].join('\n'));

    await env.collector.reconcile('test:first');
    const first = env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION });
    await env.collector.reconcile('test:second');
    await env.collector.reconcile('test:third');
    const again = env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION });

    assert.equal(again.turns.length, first.turns.length);
    assert.deepEqual(
      again.turns.map((turn) => [turn.turnIndex, turn.totalTokens, turn.requestCount, turn.toolCalls]),
      first.turns.map((turn) => [turn.turnIndex, turn.totalTokens, turn.requestCount, turn.toolCalls]),
    );
  } finally {
    env.dispose();
  }
});

test('증분 tail 이 턴 중간을 갈라도 번호가 되감기지 않는다', async () => {
  const env = claudeEnv();
  const filePath = () => path.join(env.projectDir, `${SESSION}.jsonl`);
  try {
    fs.mkdirSync(env.projectDir, { recursive: true });
    fs.writeFileSync(filePath(), [
      humanPrompt('2026-08-21T04:00:00.000Z'),
      assistant({ at: '2026-08-21T04:00:01.000Z', messageId: 'msg_1', requestId: 'req_1', output: 100, tools: [{ name: 'Read' }] }),
      '',
    ].join('\n'));
    await env.collector.reconcile('test:tail-1');

    // 같은 턴이 이어지고, 그 뒤에 새 턴이 열립니다.
    fs.appendFileSync(filePath(), [
      assistant({ at: '2026-08-21T04:00:05.000Z', messageId: 'msg_2', requestId: 'req_2', output: 150, tools: [{ name: 'Edit' }] }),
      humanPrompt('2026-08-21T04:02:00.000Z'),
      assistant({ at: '2026-08-21T04:02:01.000Z', messageId: 'msg_3', requestId: 'req_3', output: 200, tools: [{ name: 'Bash' }] }),
      '',
    ].join('\n'));
    await env.collector.reconcile('test:tail-2');

    const flow = env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION });
    assert.deepEqual(flow.turns.map((turn) => turn.turnIndex), [1, 2], '턴 번호가 1,2 여야 합니다');
    assert.equal(flow.turns[0].requestCount, 2, '이어진 요청이 턴 1 에 붙어야 합니다');
    assert.equal(flow.turns[1].requestCount, 1);
    assert.deepEqual(flow.turns[0].toolCounts, { Read: 1, Edit: 1 });
    const turnSum = flow.turns.reduce((sum, turn) => sum + turn.totalTokens, 0);
    assert.equal(turnSum, flow.session.promptTokens + flow.session.tokens.outputTokens);
  } finally {
    env.dispose();
  }
});

test('서브에이전트 요청은 부모 턴에 억지로 붙이지 않고 0번 버킷에 남는다', async () => {
  const env = claudeEnv();
  try {
    fs.mkdirSync(env.projectDir, { recursive: true });
    fs.writeFileSync(path.join(env.projectDir, `${SESSION}.jsonl`), [
      humanPrompt('2026-08-21T05:00:00.000Z'),
      assistant({ at: '2026-08-21T05:00:01.000Z', messageId: 'msg_main', requestId: 'req_main', output: 100, tools: [{ name: 'Agent' }] }),
      '',
    ].join('\n'));
    const subDir = path.join(env.projectDir, SESSION, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-x.jsonl'), [
      // 서브에이전트도 자기 transcript 안에 user 레코드를 갖지만, 부모 세션의
      // 턴 번호를 늘려서는 안 됩니다.
      humanPrompt('2026-08-21T05:00:02.000Z'),
      assistant({ at: '2026-08-21T05:00:03.000Z', messageId: 'msg_sub', requestId: 'req_sub', output: 500, tools: [{ name: 'Read' }] }),
      '',
    ].join('\n'));

    await env.collector.reconcile('test:subagent');
    const flow = env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION });

    assert.equal(flow.session.turnCount, 1, '메인 transcript 의 프롬프트만 턴을 만들어야 합니다');
    const unassigned = flow.turns.find((turn) => turn.turnIndex === 0);
    assert.ok(unassigned, '서브에이전트 요청이 0번 버킷에 있어야 합니다');
    assert.equal(unassigned.boundary, false);
    assert.equal(unassigned.requestCount, 1);
    // 합계는 여전히 세션 전체와 일치해야 합니다.
    const turnSum = flow.turns.reduce((sum, turn) => sum + turn.totalTokens, 0);
    assert.equal(turnSum, flow.session.promptTokens + flow.session.tokens.outputTokens);
    assert.equal(flow.source.transcriptCount, 2);
    assert.match(String(flow.source.mainSourcePath), new RegExp(`${SESSION}\\.jsonl$`));
  } finally {
    env.dispose();
  }
});

test('도구 이름은 저장되고 도구 입력은 SQLite 바이트에 없다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-flow-privacy-'));
  const claudeHome = path.join(root, '.claude');
  const dbPath = path.join(root, 'usage.sqlite3');
  const store = new UsageStore(dbPath);
  const collector = new ClaudeCollector({ store, claudeHomes: [claudeHome] });
  try {
    const projectDir = path.join(claudeHome, 'projects', PROJECT_DIR);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), [
      humanPrompt('2026-08-21T06:00:00.000Z'),
      assistant({ at: '2026-08-21T06:00:01.000Z', messageId: 'msg_p', requestId: 'req_p', tools: [{ name: 'Bash', file: '/repo/secret/notes.md' }] }),
      '',
    ].join('\n'));

    await collector.reconcile('test:privacy');
    const flow = store.getSessionFlow({ provider: 'claude', sessionId: SESSION });
    // 이름과 경로 접미는 남습니다 — 이것이 절차를 보는 근거입니다.
    assert.deepEqual(flow.turns[0].toolCounts, { Bash: 1 });

    collector.stop();
    store.close();

    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (!fs.existsSync(target)) continue;
      const bytes = fs.readFileSync(target, 'latin1');
      assert.ok(bytes.includes('Bash'), '도구 이름은 남아야 합니다');
      assert.ok(!bytes.includes('SENTINEL-TOOL-INPUT'), '도구 입력이 DB 에 남았습니다');
      assert.ok(!bytes.includes('SENTINEL-PROMPT'), '프롬프트가 DB 에 남았습니다');
      assert.ok(!bytes.includes('SENTINEL-ASSISTANT-TEXT'), '응답 본문이 DB 에 남았습니다');
      assert.ok(!bytes.includes('SENTINEL-TOOL-OUTPUT'), '도구 출력이 DB 에 남았습니다');
    }
  } finally {
    try { collector.stop(); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex 는 user_message 로 턴을 열고 response_item 에서 도구 이름을 가져온다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-flow-codex-'));
  const codexHome = path.join(root, '.codex');
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new CodexCollector({ store, codexHome });
  const sessionId = 'c0dec000-0000-4000-8000-000000000001';
  try {
    const dir = path.join(codexHome, 'sessions', '2026', '08', '21');
    fs.mkdirSync(dir, { recursive: true });
    const line = (value) => JSON.stringify(value);
    fs.writeFileSync(path.join(dir, `rollout-${sessionId}.jsonl`), [
      line({ timestamp: '2026-08-21T07:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd: '/repo/flow-app' } }),
      line({ timestamp: '2026-08-21T07:00:01.000Z', type: 'turn_context', payload: { cwd: '/repo/flow-app', model: 'gpt-test' } }),
      line({ timestamp: '2026-08-21T07:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'SENTINEL-PROMPT' } }),
      line({ timestamp: '2026-08-21T07:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: 'SENTINEL-TOOL-INPUT' } }),
      line({ timestamp: '2026-08-21T07:00:04.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 } } } }),
      line({ timestamp: '2026-08-21T07:01:00.000Z', type: 'event_msg', payload: { type: 'context_compacted' } }),
      line({ timestamp: '2026-08-21T07:01:10.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'SENTINEL-PROMPT' } }),
      line({ timestamp: '2026-08-21T07:01:11.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch' } }),
      line({ timestamp: '2026-08-21T07:01:12.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1600, cached_input_tokens: 1200, output_tokens: 90, total_tokens: 1690 } } } }),
      '',
    ].join('\n'));

    await collector.reconcile('test:codex-turns');
    const flow = store.getSessionFlow({ provider: 'codex', sessionId });
    assert.equal(flow.session.turnCount, 2);
    assert.deepEqual(flow.turns.map((turn) => turn.turnIndex), [1, 2]);
    assert.deepEqual(flow.turns[0].toolCounts, { shell_command: 1 });
    assert.deepEqual(flow.turns[1].toolCounts, { apply_patch: 1 });
    assert.equal(flow.turns[0].phase, 'verify');
    assert.equal(flow.turns[1].phase, 'implement');
    assert.equal(flow.turns[1].compacted, true);
    // Codex 회계는 cached ⊆ input 이므로 프롬프트 토큰이 input 을 넘지 않습니다.
    assert.equal(flow.turns[0].promptTokens, 1000);
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('세션 순위는 파생 지표를 정의대로 낸다', async () => {
  const env = claudeEnv();
  try {
    fs.mkdirSync(env.projectDir, { recursive: true });
    fs.writeFileSync(path.join(env.projectDir, `${SESSION}.jsonl`), [
      humanPrompt('2026-08-21T08:00:00.000Z'),
      assistant({ at: '2026-08-21T08:00:01.000Z', messageId: 'msg_1', requestId: 'req_1', output: 100, cacheRead: 9000, tools: [{ name: 'Bash' }, { name: 'Bash' }, { name: 'Read' }] }),
      '',
    ].join('\n'));

    await env.collector.reconcile('test:ranking');
    const [row] = env.store.getSessionRanking({ provider: 'claude' });
    assert.equal(row.sessionId, SESSION);
    assert.equal(row.projectName, 'flow-app');
    assert.equal(row.requestCount, 1);
    assert.equal(row.turnCount, 1);
    assert.equal(row.unassignedRequests, 0);
    // 프롬프트 = 비캐시 입력 + 캐시 읽기 + 캐시 쓰기
    assert.equal(row.promptTokens, 10 + 9000 + 100);
    // 재독 배수 = 캐시 읽기 / (비캐시 입력 + 출력)
    assert.equal(row.reuseMultiple, 9000 / (10 + 100));
    assert.equal(row.promptPerRequest, 9110);
    assert.deepEqual(row.toolCounts, { Bash: 2, Read: 1 });
    assert.equal(row.dominantPhase, 'verify');
    assert.equal(row.transcriptCount, 1);
  } finally {
    env.dispose();
  }
});

test('턴 원장이 비어 있어도 기존 집계는 그대로 동작한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-flow-empty-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  try {
    // turns 테이블을 건드리지 않고 원장에만 이벤트를 넣습니다.
    store.insertUsageEvent({
      type: 'usage', provider: 'codex', eventTimestamp: '2026-08-21T09:00:00.000Z',
      session: { provider: 'codex', sessionId: 'no-turns', cwd: '/repo/x', projectName: 'x', model: 'm' },
      delta: { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 120 },
    }, '/x.jsonl', 0);

    assert.equal(store.getProviderTotals('codex').totalTokens, 120);
    const [row] = store.getSessionRanking({ provider: 'codex' });
    assert.equal(row.turnCount, 0, '턴이 없으면 0 이어야 합니다');
    assert.equal(row.unassignedRequests, 1, '경계 미확인 요청으로 세어야 합니다');
    const flow = store.getSessionFlow({ provider: 'codex', sessionId: 'no-turns' });
    assert.equal(flow.turns.length, 1);
    assert.equal(flow.turns[0].turnIndex, 0);
    assert.equal(flow.turns[0].boundary, false);
    assert.equal(flow.session.turnCount, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('없는 세션은 null 을 돌려준다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-flow-404-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  try {
    assert.equal(store.getSessionFlow({ provider: 'claude', sessionId: 'nope' }), null);
    assert.equal(store.getSessionFlow({ provider: 'claude', sessionId: null }), null);
    assert.deepEqual(store.getSessionRanking({ provider: 'claude' }), []);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('도구→단계 매핑은 provider 별이고 모르는 도구는 other 로 떨어진다', () => {
  assert.equal(phaseOfTool('claude', 'Bash'), 'verify');
  assert.equal(phaseOfTool('claude', 'Edit'), 'implement');
  assert.equal(phaseOfTool('claude', 'Read'), 'explore');
  assert.equal(phaseOfTool('codex', 'shell_command'), 'verify');
  assert.equal(phaseOfTool('codex', 'apply_patch'), 'implement');
  // 같은 이름이 provider 를 넘어 통하지 않습니다 — 어휘가 다르기 때문입니다.
  assert.equal(phaseOfTool('codex', 'Bash'), 'other');
  assert.equal(phaseOfTool('claude', 'apply_patch'), 'other');
  // 아직 어휘를 확인하지 않은 provider 는 전부 other 입니다(정직한 미분류).
  assert.equal(phaseOfTool('gemini', 'anything'), 'other');
  assert.equal(phaseOfTool('claude', null), 'other');
  assert.equal(PHASES.length, 6);
});

test('한 턴에 단계가 섞이면 호출 비율로 토큰을 나눈다', () => {
  const split = splitTokensByPhase('claude', { Bash: 3, Read: 1 }, 1000);
  assert.equal(split.get('verify'), 750);
  assert.equal(split.get('explore'), 250);
  assert.equal([...split.values()].reduce((sum, value) => sum + value, 0), 1000, '배분 합이 원래 토큰과 같아야 합니다');

  // 도구를 안 쓴 턴은 no-tool 로 모읍니다 — 0 으로 흘리지 않습니다.
  const none = splitTokensByPhase('claude', {}, 500);
  assert.deepEqual([...none.entries()], [['no-tool', 500]]);
  assert.equal(dominantPhase('claude', {}), 'no-tool');
  assert.equal(dominantPhase('claude', { Bash: 1, Read: 5 }), 'explore');
});

test('파서 버전이 올라가면 이전 버전으로 읽은 파일을 한 번 다시 해석한다', async () => {
  const env = claudeEnv();
  const filePath = () => path.join(env.projectDir, `${SESSION}.jsonl`);
  try {
    fs.mkdirSync(env.projectDir, { recursive: true });
    fs.writeFileSync(filePath(), [
      humanPrompt('2026-08-21T10:00:00.000Z'),
      assistant({ at: '2026-08-21T10:00:01.000Z', messageId: 'msg_1', requestId: 'req_1', tools: [{ name: 'Read' }] }),
      '',
    ].join('\n'));
    await env.collector.reconcile('test:v-current');
    assert.equal(env.store.getScanState('claude', filePath()).parserVersion, CLAUDE_PARSER_VERSION);

    // 옛 버전으로 읽은 것처럼 커서를 되돌리고 턴을 지웁니다.
    env.store.db.prepare('UPDATE provider_scan_state SET parser_version = 1 WHERE provider = ?').run('claude');
    env.store.resetTurns('claude', SESSION);
    env.store.db.prepare('UPDATE usage_events SET turn_index = NULL, tool_counts = NULL WHERE provider = ?').run('claude');
    assert.equal(env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION }).session.turnCount, 0);

    await env.collector.reconcile('test:v-upgrade');
    const flow = env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION });
    assert.equal(flow.session.turnCount, 1, '재해석으로 턴이 복구돼야 합니다');
    assert.deepEqual(flow.turns[0].toolCounts, { Read: 1 });
    // 재해석이 합계를 늘리지 않아야 합니다.
    assert.equal(env.store.getProviderTotals('claude').eventCount, 1);
  } finally {
    env.dispose();
  }
});

test('버전 도장만 찍히고 턴이 비어 있으면 원장 상태를 보고 다시 해석한다', async () => {
  const env = claudeEnv();
  const filePath = () => path.join(env.projectDir, `${SESSION}.jsonl`);
  try {
    fs.mkdirSync(env.projectDir, { recursive: true });
    fs.writeFileSync(filePath(), [
      humanPrompt('2026-08-21T11:00:00.000Z'),
      assistant({ at: '2026-08-21T11:00:01.000Z', messageId: 'msg_1', requestId: 'req_1', tools: [{ name: 'Bash' }] }),
      '',
    ].join('\n'));
    await env.collector.reconcile('test:first');
    assert.equal(env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION }).session.turnCount, 1);

    // 결함 있던 중간 버전이 만든 상태를 재현합니다: 버전은 최신인데 원장에
    // 턴이 안 붙어 있는 상태. 버전만 보면 재해석이 걸리지 않습니다.
    env.store.resetTurns('claude', SESSION);
    env.store.db.prepare('UPDATE usage_events SET turn_index = NULL, tool_counts = NULL WHERE provider = ?').run('claude');
    assert.equal(env.store.getScanState('claude', filePath()).parserVersion, CLAUDE_PARSER_VERSION);
    assert.equal(env.store.hasUnattributedTurns('claude', filePath()), true);

    await env.collector.reconcile('test:self-heal');
    const flow = env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION });
    assert.equal(flow.session.turnCount, 1, '원장 상태를 보고 스스로 복구해야 합니다');
    assert.deepEqual(flow.turns[0].toolCounts, { Bash: 1 });
    assert.equal(env.store.hasUnattributedTurns('claude', filePath()), false, '복구 후에는 조건이 풀려 루프가 없어야 합니다');

    // 한 번 더 돌려도 재해석이 반복되지 않아야 합니다.
    const before = env.collector.status.reparsedFiles;
    await env.collector.reconcile('test:no-loop');
    assert.equal(env.collector.status.reparsedFiles, before, '재해석이 매 스캔마다 반복되면 안 됩니다');
    assert.equal(env.store.getProviderTotals('claude').eventCount, 1);
  } finally {
    env.dispose();
  }
});

test('컴팩션 표시는 그 턴의 첫 요청에만 붙는다', async () => {
  const env = claudeEnv();
  try {
    fs.mkdirSync(env.projectDir, { recursive: true });
    fs.writeFileSync(path.join(env.projectDir, `${SESSION}.jsonl`), [
      humanPrompt('2026-08-21T12:00:00.000Z'),
      assistant({ at: '2026-08-21T12:00:01.000Z', messageId: 'msg_1', requestId: 'req_1', cacheRead: 90000 }),
      compactBoundary('2026-08-21T12:01:00.000Z'),
      humanPrompt('2026-08-21T12:01:30.000Z'),
      // 컴팩션 뒤 같은 턴에서 요청이 여럿 이어집니다.
      assistant({ at: '2026-08-21T12:01:31.000Z', messageId: 'msg_2', requestId: 'req_2', cacheRead: 1000 }),
      assistant({ at: '2026-08-21T12:01:32.000Z', messageId: 'msg_3', requestId: 'req_3', cacheRead: 1200 }),
      assistant({ at: '2026-08-21T12:01:33.000Z', messageId: 'msg_4', requestId: 'req_4', cacheRead: 1400 }),
      '',
    ].join('\n'));

    await env.collector.reconcile('test:compact-mark');
    const flow = env.store.getSessionFlow({ provider: 'claude', sessionId: SESSION });
    // 턴은 컴팩션됨으로 표시되지만, 곡선에서는 점 하나만 표시돼야 합니다.
    assert.equal(flow.turns[1].compacted, true);
    assert.equal(flow.turns[1].requestCount, 3);
    assert.equal(
      flow.curve.filter((point) => point.compacted).length,
      1,
      '턴 안의 모든 요청에 표시가 붙으면 곡선이 세로선으로 덮입니다',
    );
    // 표시는 그 턴의 첫 요청 위치에 있어야 합니다.
    assert.equal(flow.curve.findIndex((point) => point.compacted), 1);
  } finally {
    env.dispose();
  }
});

test('upsertTurn 은 같은 경계를 다시 쓰면 changed 가 아니다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-turn-idempotent-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  try {
    const turn = {
      provider: 'claude',
      sessionId: SESSION,
      turnIndex: 1,
      startedAt: '2026-08-21T01:00:00.000Z',
      compacted: false,
      parserVersion: 'test-v1',
    };
    assert.deepEqual(store.upsertTurn(turn), { changed: true, inserted: true, updated: false });
    assert.deepEqual(store.upsertTurn(turn), { changed: false, inserted: false, updated: false });
    assert.deepEqual(
      store.upsertTurn({ ...turn, compacted: true }),
      { changed: true, inserted: false, updated: true },
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
