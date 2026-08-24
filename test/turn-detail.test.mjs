// 턴 상세(비싼 턴 → 무엇에 썼나) 테스트.
//
// 검사하는 계약은 넷입니다.
//   1. 범주 분해가 원장의 턴 합계와 어긋나지 않는다
//   2. 본문은 응답에 나오지 않는다 (센티넬 문자열 전수 검사)
//   3. 원본 파일이 없으면 지어내지 않고 "원본 없음"으로 답한다
//   4. 아직 붙이지 않은 provider 는 빈 상세가 아니라 "미지원"으로 답한다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UsageApiServer } from '../service/api-server.mjs';
import { UsageStore } from '../service/store.mjs';
import { ClaudeCollector } from '../service/providers/claude/collector.mjs';
import { CodexCollector } from '../service/providers/codex/collector.mjs';
import { readTurnDetail, turnDetailAdapter } from '../service/providers/turn-detail-readers.mjs';
import { claudeMcpToolName } from '../service/providers/claude/turn-detail.mjs';

const CWD = 'C:\\Users\\dev\\git\\node\\detail-app';
const PROJECT_DIR = 'C--Users-dev-git-node-detail-app';
const CLAUDE_SESSION = 'd0d0d0d0-0000-4000-8000-000000000001';
const CODEX_SESSION = 'c0dec0de-0000-4000-8000-000000000002';

// 본문이 응답에 새는지 보려면 본문 자리에 표식을 넣어 두고 응답 전체를
// 문자열로 훑어야 합니다 — claude-privacy.test.mjs 와 같은 방법입니다.
const SENTINELS = [
  'SENTINEL-PROMPT-TEXT',
  'SENTINEL-ASSISTANT-TEXT',
  'SENTINEL-TOOL-INPUT',
  'SENTINEL-TOOL-OUTPUT',
];

function claudeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-turn-detail-'));
  const claudeHome = path.join(root, '.claude');
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new ClaudeCollector({ store, claudeHomes: [claudeHome] });
  return {
    root,
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

function humanPrompt(at) {
  return JSON.stringify({
    type: 'user', sessionId: CLAUDE_SESSION, cwd: CWD, timestamp: at,
    message: { role: 'user', content: [{ type: 'text', text: 'SENTINEL-PROMPT-TEXT' }] },
  });
}

function assistant({ at, messageId, requestId, output = 100, cacheRead = 1000, tools = [] }) {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${messageId}-uuid`,
    requestId,
    timestamp: at,
    sessionId: CLAUDE_SESSION,
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
          input: { command: 'SENTINEL-TOOL-INPUT', file_path: tool.file ?? undefined },
        })),
      ],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
        output_tokens_details: { thinking_tokens: 20 },
      },
    },
  });
}

// 턴 1 = 도구 없는 응답 1 + 내장 도구 2 + MCP 1, 턴 2 = 도구 없는 응답 1.
function writeClaudeTranscript(env) {
  fs.mkdirSync(env.projectDir, { recursive: true });
  fs.writeFileSync(path.join(env.projectDir, `${CLAUDE_SESSION}.jsonl`), [
    humanPrompt('2026-08-22T01:00:00.000Z'),
    assistant({ at: '2026-08-22T01:00:01.000Z', messageId: 'msg_1', requestId: 'req_1', output: 100 }),
    assistant({
      at: '2026-08-22T01:00:02.000Z',
      messageId: 'msg_2',
      requestId: 'req_2',
      output: 200,
      tools: [{ name: 'Read', file: '/repo/src/App.jsx' }, { name: 'Edit', file: '/repo/src/App.jsx' }],
    }),
    assistant({
      at: '2026-08-22T01:00:03.000Z',
      messageId: 'msg_3',
      requestId: 'req_3',
      output: 300,
      tools: [{ name: 'mcp__github__list_issues' }],
    }),
    humanPrompt('2026-08-22T01:10:00.000Z'),
    assistant({ at: '2026-08-22T01:10:01.000Z', messageId: 'msg_4', requestId: 'req_4', output: 50 }),
    '',
  ].join('\n'));
}

test('MCP 도구 이름에서 서버와 도구를 가른다', () => {
  assert.deepEqual(claudeMcpToolName('mcp__github__list_issues'), { server: 'github', tool: 'list_issues' });
  // 서버 이름에 밑줄이 있어도 구분자는 두 겹 밑줄뿐입니다.
  assert.deepEqual(claudeMcpToolName('mcp__Claude_Code_Remote__add_repo'), { server: 'Claude_Code_Remote', tool: 'add_repo' });
  // 내장 도구는 MCP 가 아닙니다 — 억지로 서버를 짜내면 없는 서버가 생깁니다.
  assert.equal(claudeMcpToolName('Read'), null);
  assert.equal(claudeMcpToolName('mcp_single_underscore'), null);
});

test('턴 상세가 채팅·도구·MCP 로 갈리고 합계가 원장과 맞는다', async () => {
  const env = claudeEnv();
  try {
    writeClaudeTranscript(env);
    await env.collector.reconcile('test:detail');

    const source = env.store.getTurnSource({ provider: 'claude', sessionId: CLAUDE_SESSION, turnIndex: 1 });
    assert.ok(source, '턴 1 의 원본 포인터가 있어야 합니다');
    assert.equal(source.sourcePaths.length, 1);
    assert.equal(source.ledger.requestCount, 3);
    assert.equal(source.boundary.startedAt, '2026-08-22T01:00:00.000Z');

    const detail = await readTurnDetail({
      provider: 'claude',
      sourcePaths: source.sourcePaths,
      turnIndex: 1,
    });
    assert.equal(detail.available, true);
    assert.equal(detail.totals.requestCount, 3);

    // 완료 기준: 파일을 다시 읽은 합계 == 원장이 말하는 턴 합계.
    assert.equal(detail.totals.totalTokens, source.ledger.totalTokens);

    const byKey = Object.fromEntries(detail.categories.map((row) => [row.key, row]));
    assert.deepEqual(Object.keys(byKey).sort(), ['chat', 'file', 'mcp', 'tool']);

    // 파이에 들어가는 셋은 서로 겹치지 않고 합이 턴 합계입니다.
    const pie = detail.categories.filter((row) => row.pie);
    assert.equal(pie.reduce((sum, row) => sum + row.tokens, 0), detail.totals.totalTokens);
    assert.ok(Math.abs(pie.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);

    // 도구 없는 응답 하나가 통째로 '채팅' 입니다.
    assert.equal(byKey.chat.calls, 0);
    assert.deepEqual(byKey.chat.children.map((row) => row.label), ['도구 없는 응답']);

    // 내장 도구는 이름별로 갈리고 단계 분류가 붙습니다.
    assert.deepEqual(byKey.tool.children.map((row) => row.label).sort(), ['Edit', 'Read']);
    assert.equal(byKey.tool.calls, 2);
    assert.equal(byKey.tool.children.find((row) => row.label === 'Edit').phase, 'implement');
    assert.equal(byKey.tool.children.find((row) => row.label === 'Read').phase, 'explore');
    // 한 요청에 도구 둘이면 호출 비율로 반씩 나눕니다(인과가 아니라 배분).
    assert.equal(byKey.tool.children[0].tokens, byKey.tool.children[1].tokens);

    // MCP 는 서버 → 도구 두 겹입니다.
    assert.equal(byKey.mcp.calls, 1);
    assert.deepEqual(byKey.mcp.children.map((row) => row.label), ['github']);
    assert.deepEqual(byKey.mcp.children[0].children.map((row) => row.label), ['list_issues']);

    // 파일은 도구 안에서 다시 센 것이라 토큰을 매기지 않습니다.
    assert.equal(byKey.file.tokens, null);
    assert.deepEqual(detail.files.map((row) => row.path), ['src/App.jsx']);
    assert.equal(detail.files[0].calls, 2);
    // 한 요청에 도구가 둘이면 어느 도구가 만졌는지 모릅니다.
    assert.deepEqual(detail.files[0].tools, { '(혼합)': 2 });

    // 메타데이터 로그: 턴 경계 1 + 요청 3.
    assert.equal(detail.records.length, 4);
    assert.equal(detail.records[0].kind, 'turn-start');
    assert.deepEqual(detail.records.slice(1).map((row) => row.category), ['chat', 'tool', 'mcp']);
    assert.equal(detail.records[1].requestId, 'req_1');
    assert.equal(detail.records[2].model, 'claude-opus-5');
    assert.equal(detail.truncated, false);
  } finally {
    env.dispose();
  }
});

test('턴 상세 응답에 대화 본문이 실리지 않는다', async () => {
  const env = claudeEnv();
  try {
    writeClaudeTranscript(env);
    await env.collector.reconcile('test:privacy');
    const source = env.store.getTurnSource({ provider: 'claude', sessionId: CLAUDE_SESSION, turnIndex: 1 });
    const detail = await readTurnDetail({ provider: 'claude', sourcePaths: source.sourcePaths, turnIndex: 1 });
    const serialized = JSON.stringify(detail);
    for (const sentinel of SENTINELS) {
      assert.equal(serialized.includes(sentinel), false, `${sentinel} 이 응답에 새면 안 됩니다`);
    }
  } finally {
    env.dispose();
  }
});

test('다른 턴을 고르면 그 턴만 담긴다', async () => {
  const env = claudeEnv();
  try {
    writeClaudeTranscript(env);
    await env.collector.reconcile('test:turn2');
    const detail = await readTurnDetail({
      provider: 'claude',
      sourcePaths: env.store.getTurnSource({ provider: 'claude', sessionId: CLAUDE_SESSION, turnIndex: 2 }).sourcePaths,
      turnIndex: 2,
    });
    assert.equal(detail.totals.requestCount, 1);
    assert.deepEqual(detail.categories.map((row) => row.key), ['chat']);
    assert.equal(detail.files.length, 0);
  } finally {
    env.dispose();
  }
});

test('원본 파일이 사라지면 상세를 지어내지 않는다', async () => {
  const env = claudeEnv();
  try {
    writeClaudeTranscript(env);
    await env.collector.reconcile('test:missing');
    const source = env.store.getTurnSource({ provider: 'claude', sessionId: CLAUDE_SESSION, turnIndex: 1 });
    fs.rmSync(source.sourcePaths[0]);

    const detail = await readTurnDetail({ provider: 'claude', sourcePaths: source.sourcePaths, turnIndex: 1 });
    assert.equal(detail.supported, true);
    assert.equal(detail.available, false);
    assert.equal(detail.reason, 'source_missing');
    assert.deepEqual(detail.categories, []);
    assert.equal(detail.scanned[0].exists, false);
    // 원장의 숫자는 그대로 남습니다 — 상세만 없는 것입니다.
    assert.ok(source.ledger.totalTokens > 0);
  } finally {
    env.dispose();
  }
});

test('같은 요청이 두 파일에 있어도 상세 합계가 부풀지 않는다', async () => {
  const env = claudeEnv();
  try {
    writeClaudeTranscript(env);
    // 세션을 resume 하면 이전 transcript 가 새 파일로 복사됩니다. 원장은
    // eventKey 로 접어 한 벌만 남기지만, 상세는 파일을 **다시** 읽으므로
    // 같은 기준으로 접지 않으면 "표는 4M, 상세는 8M" 이 됩니다.
    const original = path.join(env.projectDir, `${CLAUDE_SESSION}.jsonl`);
    const copy = path.join(env.projectDir, `${CLAUDE_SESSION}-resume.jsonl`);
    fs.copyFileSync(original, copy);
    await env.collector.reconcile('test:resume');

    const source = env.store.getTurnSource({ provider: 'claude', sessionId: CLAUDE_SESSION, turnIndex: 1 });
    const detail = await readTurnDetail({
      provider: 'claude',
      sourcePaths: [original, copy],
      turnIndex: 1,
    });
    assert.equal(detail.totals.requestCount, 3, '같은 요청을 두 번 세면 안 됩니다');
    assert.equal(detail.totals.totalTokens, source.ledger.totalTokens);
    assert.equal(detail.duplicateCount, 3);
    assert.equal(detail.scanned.length, 2, '읽은 파일은 둘 다 보고합니다');
  } finally {
    env.dispose();
  }
});

test('Codex 턴 상세도 같은 범주로 갈린다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-turn-codex-'));
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new CodexCollector({ store, codexHome: path.join(root, '.codex') });
  try {
    const sessionsDir = path.join(root, '.codex', 'sessions', '2026', '08', '22');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const cumulative = (input, cached, output) => ({
      input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
      output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
    });
    fs.writeFileSync(path.join(sessionsDir, `rollout-${CODEX_SESSION}.jsonl`), [
      { timestamp: '2026-08-22T02:00:00.000Z', type: 'session_meta', payload: { id: CODEX_SESSION, cwd: '/work/detail-app', cli_version: '0.99.0' } },
      { timestamp: '2026-08-22T02:00:01.000Z', type: 'turn_context', payload: { cwd: '/work/detail-app', model: 'gpt-test' } },
      { timestamp: '2026-08-22T02:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'SENTINEL-PROMPT-TEXT' } },
      { timestamp: '2026-08-22T02:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: 'SENTINEL-TOOL-INPUT' } },
      { timestamp: '2026-08-22T02:00:04.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: cumulative(1000, 600, 200), last_token_usage: cumulative(1000, 600, 200) } } },
      { timestamp: '2026-08-22T02:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'mcp__github__get_me' } },
      { timestamp: '2026-08-22T02:00:06.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: cumulative(1400, 800, 300), last_token_usage: cumulative(400, 200, 100) } } },
      '',
    ].map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));

    await collector.reconcile('test:codex-detail');
    const source = store.getTurnSource({ provider: 'codex', sessionId: CODEX_SESSION, turnIndex: 1 });
    assert.ok(source, 'Codex 턴 1 이 원장에 있어야 합니다');

    const detail = await readTurnDetail({ provider: 'codex', sourcePaths: source.sourcePaths, turnIndex: 1 });
    assert.equal(detail.available, true);
    assert.equal(detail.totals.totalTokens, source.ledger.totalTokens);
    const keys = detail.categories.map((row) => row.key);
    assert.ok(keys.includes('tool'));
    assert.ok(keys.includes('mcp'));
    // Codex 파서는 경로를 뽑지 않습니다 — 0개가 아니라 미측정입니다.
    assert.equal(detail.filesMeasured, false);
    assert.equal(detail.files.length, 0);
    assert.equal(JSON.stringify(detail).includes('SENTINEL-TOOL-INPUT'), false);
    assert.equal(JSON.stringify(detail).includes('SENTINEL-PROMPT-TEXT'), false);
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('아직 붙이지 않은 provider 는 빈 상세가 아니라 미지원으로 답한다', async () => {
  for (const [provider, reason] of [['gemini', 'provider_not_implemented'], ['cursor', 'provider_has_no_turns']]) {
    const detail = await readTurnDetail({ provider, sourcePaths: ['/nowhere/x.jsonl'], turnIndex: 1 });
    assert.equal(detail.supported, false, `${provider} 는 아직 미지원이어야 합니다`);
    assert.equal(detail.available, false);
    assert.equal(detail.reason, reason);
    assert.deepEqual(detail.categories, []);
    // 템플릿이라도 등록표에는 있어야 화면이 "모르는 provider" 와 구분합니다.
    assert.ok(turnDetailAdapter(provider));
  }
  assert.equal(turnDetailAdapter('nope'), null);
  assert.equal((await readTurnDetail({ provider: 'nope' })).reason, 'provider_unknown');
});

test('API 가 턴 상세를 내려 주고, 가림된 프로젝트에서는 경로를 싣지 않는다', async () => {
  const env = claudeEnv();
  writeClaudeTranscript(env);
  await env.collector.reconcile('test:api');

  // 이 라우트는 store 만 씁니다 — 엔진의 나머지는 흉내만 냅니다.
  const engine = new EventEmitter();
  engine.store = env.store;
  engine.snapshot = () => ({ generatedAt: '2026-08-22T01:20:00.000Z' });
  const server = new UsageApiServer({ usageEngine: engine, accessToken: 'test-token', heartbeatMs: 60_000 });
  const baseUrl = await server.start();
  const headers = { 'X-Nyang-Access-Token': 'test-token' };
  const url = `${baseUrl}/api/v1/sessions/${CLAUDE_SESSION}/turns/1/detail?provider=claude`;
  try {
    assert.equal((await fetch(url)).status, 401, '토큰 없이 열리면 안 됩니다');

    const payload = await fetch(url, { headers }).then((response) => response.json());
    assert.equal(payload.available, true);
    assert.equal(payload.turnIndex, 1);
    assert.equal(payload.measured.totalTokens, payload.ledger.totalTokens);
    assert.equal(payload.source.files[0].exists, true);
    assert.ok(payload.source.files[0].path, '가리지 않은 프로젝트는 경로를 보여 줍니다');
    assert.ok(payload.categories.some((row) => row.key === 'file'));

    // 없는 턴은 404 입니다 — 빈 상세를 만들어 주지 않습니다.
    assert.equal((await fetch(`${baseUrl}/api/v1/sessions/${CLAUDE_SESSION}/turns/99/detail?provider=claude`, { headers })).status, 404);

    // 가림을 켜면 경로 문자열이 응답에서 빠집니다. 토큰·도구 내역은 남습니다.
    env.store.setProjectAlias({
      provider: 'claude',
      projectKey: payload.projectKey,
      alias: '(가림) 상세앱',
      redacted: true,
    });
    const hidden = await fetch(url, { headers }).then((response) => response.json());
    assert.equal(hidden.redacted, true);
    assert.equal(hidden.source.files[0].path, null);
    assert.deepEqual(hidden.files, []);
    assert.equal(hidden.categories.some((row) => row.key === 'file'), false);
    assert.ok(hidden.categories.some((row) => row.key === 'tool'), '도구 내역은 그대로 남습니다');
    assert.equal(JSON.stringify(hidden).includes('src/App.jsx'), false);
    assert.equal(JSON.stringify(hidden).includes(PROJECT_DIR), false);
  } finally {
    await server.stop();
    env.dispose();
  }
});
