// Claude transcript 는 대화 전문·도구 입출력·파일 내용을 그대로 담고 있고,
// 우리는 그중 토큰 회계에 필요한 좁은 부분만 필요합니다
// (docs/claude-code-adapter.md §17). 이 파일은 그 경계를 실제로 검사합니다:
// 센티넬 문자열이 SQLite 파일 바이트와 HTTP/SSE 스냅샷 어디에도 나타나면 안 됩니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../service/store.mjs';
import { ClaudeCollector } from '../service/providers/claude/collector.mjs';
import { UsageEngine } from '../service/engine.mjs';
import { UsageApiServer } from '../service/api-server.mjs';

const SENTINELS = [
  'SENTINEL-USER-PROMPT',
  'SENTINEL-ASSISTANT-TEXT',
  'SENTINEL-THINKING-TEXT',
  'SENTINEL-TOOL-INPUT',
  'SENTINEL-TOOL-OUTPUT',
  'SENTINEL-FILE-CONTENT',
  'SENTINEL-SUBAGENT-PROMPT',
];

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROJECT_DIR = 'C--Users-dev-git-node-secret-client';
const CWD = 'C:\\Users\\dev\\git\\node\\secret-client';

function writeTranscript(claudeHome) {
  const projectDir = path.join(claudeHome, 'projects', PROJECT_DIR);
  fs.mkdirSync(projectDir, { recursive: true });

  const usage = {
    input_tokens: 24,
    cache_creation_input_tokens: 3000,
    cache_read_input_tokens: 120000,
    output_tokens: 900,
    output_tokens_details: { thinking_tokens: 400 },
    cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 0 },
  };

  const lines = [
    { type: 'user', sessionId: SESSION_ID, cwd: CWD, message: { role: 'user', content: [{ type: 'text', text: SENTINELS[0] }] } },
    { type: 'last-prompt', prompt: SENTINELS[0] },
    { type: 'attachment', content: SENTINELS[5] },
    {
      type: 'assistant',
      uuid: 'u-1',
      requestId: 'req_secret_1',
      timestamp: '2026-08-21T03:00:00.000Z',
      sessionId: SESSION_ID,
      cwd: CWD,
      version: '2.1.232',
      gitBranch: 'main',
      message: {
        id: 'msg_secret_1',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'thinking', thinking: SENTINELS[2] },
          { type: 'text', text: SENTINELS[1] },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: SENTINELS[3] } },
        ],
        usage,
      },
    },
    {
      type: 'user',
      sessionId: SESSION_ID,
      cwd: CWD,
      toolUseResult: {
        status: 'completed',
        prompt: SENTINELS[6],
        agentId: 'agent-1',
        content: SENTINELS[4],
        totalTokens: 999999,
        usage,
      },
    },
  ];
  fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

  const subagentDir = path.join(projectDir, SESSION_ID, 'subagents');
  fs.mkdirSync(subagentDir, { recursive: true });
  fs.writeFileSync(path.join(subagentDir, 'agent-1.jsonl'), `${JSON.stringify({
    type: 'assistant',
    uuid: 'u-2',
    isSidechain: true,
    agentId: 'agent-1',
    requestId: 'req_secret_2',
    timestamp: '2026-08-21T03:01:00.000Z',
    sessionId: SESSION_ID,
    cwd: CWD,
    version: '2.1.232',
    message: {
      id: 'msg_secret_2',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: SENTINELS[1] }],
      usage,
    },
  })}\n`);
}

function assertNoSentinels(haystack, label) {
  for (const sentinel of SENTINELS) {
    assert.ok(!haystack.includes(sentinel), `${label} 에 ${sentinel} 가 남았습니다`);
  }
}

test('프롬프트·응답·도구 본문은 SQLite 파일 바이트에 남지 않는다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-claude-privacy-'));
  const claudeHome = path.join(root, '.claude');
  const dbPath = path.join(root, 'usage.sqlite3');
  const store = new UsageStore(dbPath);
  const collector = new ClaudeCollector({ store, claudeHomes: [claudeHome] });
  try {
    writeTranscript(claudeHome);
    await collector.reconcile('test:privacy');

    // 토큰은 실제로 수집됐어야 합니다 — 아무것도 안 읽어서 통과하면 안 됩니다.
    const totals = store.getProviderTotals('claude');
    assert.equal(totals.eventCount, 2, '서브에이전트 1건 + 본 세션 1건이 들어와야 합니다');
    assert.equal(totals.outputTokens, 1800);
    assert.equal(totals.reasoningTokens, 800);

    collector.stop();
    store.close();

    // WAL 까지 포함해 DB 파일 전체를 훑습니다.
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (!fs.existsSync(target)) continue;
      assertNoSentinels(fs.readFileSync(target, 'latin1'), path.basename(target));
    }
  } finally {
    try { collector.stop(); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP 스냅샷과 SSE 페이로드에도 대화 본문이 실리지 않는다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-claude-privacy-api-'));
  const claudeHome = path.join(root, '.claude');
  writeTranscript(claudeHome);

  const engine = new UsageEngine({
    userDataPath: root,
    codexHome: path.join(root, 'no-codex'),
    claudeHomes: [claudeHome],
  });
  const server = new UsageApiServer({ usageEngine: engine, host: '127.0.0.1', port: 0 });
  try {
    await engine.claude.reconcile('test:privacy-api');
    const baseUrl = await server.start();
    const headers = { 'X-Nyang-Access-Token': server.accessToken };

    const snapshotText = await (await fetch(`${baseUrl}/api/v1/snapshot`, { headers })).text();
    assertNoSentinels(snapshotText, '스냅샷');
    const snapshot = JSON.parse(snapshotText);
    const claude = snapshot.providers.find((provider) => provider.id === 'claude');
    assert.equal(claude.totals.outputTokens, 1800);
    assert.equal(claude.quality.overall, 'local_exact');

    const projectsText = await (await fetch(`${baseUrl}/api/v1/projects`, { headers })).text();
    assertNoSentinels(projectsText, '프로젝트 목록');

    const timeseriesText = await (await fetch(`${baseUrl}/api/v1/usage/timeseries?since=2026-01-01T00:00:00.000Z`, { headers })).text();
    assertNoSentinels(timeseriesText, '시계열');

    const diagnosticsText = await (await fetch(`${baseUrl}/api/v1/diagnostics`, { headers })).text();
    assertNoSentinels(diagnosticsText, '진단');
  } finally {
    await server.stop();
    await engine.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
