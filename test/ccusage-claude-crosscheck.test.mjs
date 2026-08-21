// ccusage 교차 검증 — Claude Code transcript.
//
// ccusage(https://github.com/ccusage/ccusage)는 같은 ~/.claude/projects 로그를
// 읽는 독립 구현입니다. 런타임 의존성이 아니고(devDependency), 우리 수집 경로는
// ccusage 를 호출하지 않습니다. 같은 입력에 대해 두 구현이 무엇에 합의하고
// 어디서 갈라지는지 고정해두면 파서가 조용히 틀어지는 것을 잡을 수 있습니다.
//
// 이 픽스처에는 실제 로그에서 확인한 함정을 일부러 넣었습니다:
//   1. 같은 요청이 content block 단위로 3줄로 쪼개지고, 앞 줄은 스트리밍 중간값
//   2. 세션 resume 으로 같은 요청이 다른 파일에 복사됨
//   3. 서브에이전트 transcript 와 부모의 toolUseResult 롤업이 함께 존재
//   4. thinking_tokens 를 담은 신버전 레코드와 담지 않은 구버전 레코드가 섞임
//
// 실행하려면 ccusage 가 필요합니다(선택). 없으면 이 파일은 통째로 skip 됩니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { UsageStore } from '../service/store.mjs';
import { ClaudeCollector } from '../service/providers/claude/collector.mjs';

const require = createRequire(import.meta.url);

function findCcusageCli() {
  try {
    const pkgPath = require.resolve('ccusage/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.ccusage;
    if (!bin) return null;
    const cli = path.join(path.dirname(pkgPath), bin);
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

const ccusageCli = findCcusageCli();
const skip = ccusageCli ? false : 'ccusage 미설치 — npm i -D ccusage 후 실행하세요';

const PROJECT_DIR = 'C--Users-dev-git-node-crosscheck';
const CWD = 'C:\\Users\\dev\\git\\node\\crosscheck';
const MAIN_SESSION = 'c1000000-0000-4000-8000-000000000001';
const RESUMED_SESSION = 'c1000000-0000-4000-8000-000000000002';

function assistant({
  sessionId, messageId, requestId, output, input, cacheRead, cacheWrite,
  thinking = null, version = '2.1.232', block = 'text', timestamp,
  model = 'claude-sonnet-5', sidechain = false,
}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${messageId}-${block}-${output}`,
    isSidechain: sidechain,
    requestId,
    timestamp,
    sessionId,
    cwd: CWD,
    version,
    gitBranch: 'main',
    message: {
      id: messageId,
      role: 'assistant',
      model,
      content: [{ type: block, text: 'x' }],
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
        ...(thinking == null ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
        cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 },
        service_tier: 'standard',
      },
    },
  });
}

// 두 구현이 같은 값에 도달해야 하는 요청들. 합계를 손으로 적어 두면 어느 쪽이
// 틀렸을 때 무엇이 기대값인지 바로 보입니다.
const REQUESTS = [
  { messageId: 'msg_x1', requestId: 'req_x1', input: 14, cacheRead: 120_000, cacheWrite: 3_500, output: 620, thinking: 260, version: '2.1.232' },
  { messageId: 'msg_x2', requestId: 'req_x2', input: 2, cacheRead: 240_500, cacheWrite: 900, output: 1_450, thinking: 700, version: '2.1.232' },
  // thinking_tokens 가 없는 구버전 레코드. 토큰 값 자체는 두 구현이 같아야 합니다.
  { messageId: 'msg_x3', requestId: 'req_x3', input: 31, cacheRead: 88_000, cacheWrite: 1_200, output: 310, thinking: null, version: '2.1.220' },
];
const SUBAGENT_REQUEST = { messageId: 'msg_x4', requestId: 'req_x4', input: 5, cacheRead: 64_000, cacheWrite: 400, output: 880, thinking: 300, version: '2.1.232' };

function expectedTotals() {
  const all = [...REQUESTS, SUBAGENT_REQUEST];
  return {
    inputTokens: all.reduce((sum, request) => sum + request.input, 0),
    cachedInputTokens: all.reduce((sum, request) => sum + request.cacheRead, 0),
    cacheWriteInputTokens: all.reduce((sum, request) => sum + request.cacheWrite, 0),
    outputTokens: all.reduce((sum, request) => sum + request.output, 0),
    reasoningTokens: all.reduce((sum, request) => sum + (request.thinking ?? 0), 0),
  };
}

function writeFixture(claudeHome) {
  const projectDir = path.join(claudeHome, 'projects', PROJECT_DIR);
  fs.mkdirSync(projectDir, { recursive: true });

  const lines = [];
  REQUESTS.forEach((request, index) => {
    const stamp = (minute) => `2026-08-11T0${index + 1}:${String(minute).padStart(2, '0')}:00.000Z`;
    // 1) content block 분할: thinking 줄이 스트리밍 중간값(output 5)을 담고,
    //    이어지는 두 줄이 최종값을 담습니다. first-wins 면 5 가 남습니다.
    lines.push(assistant({ sessionId: MAIN_SESSION, ...request, output: 5, thinking: null, block: 'thinking', timestamp: stamp(10) }));
    lines.push(assistant({ sessionId: MAIN_SESSION, ...request, block: 'text', timestamp: stamp(11) }));
    lines.push(assistant({ sessionId: MAIN_SESSION, ...request, block: 'tool_use', timestamp: stamp(12) }));
  });

  // 2) 부모의 서브에이전트 롤업. 토큰이 적혀 있지만 계상하면 이중 계상입니다.
  lines.push(JSON.stringify({
    type: 'user',
    sessionId: MAIN_SESSION,
    cwd: CWD,
    toolUseResult: {
      status: 'completed',
      prompt: 'x',
      agentId: 'agent-x',
      totalTokens: 65_285,
      usage: {
        input_tokens: SUBAGENT_REQUEST.input,
        cache_creation_input_tokens: SUBAGENT_REQUEST.cacheWrite,
        cache_read_input_tokens: SUBAGENT_REQUEST.cacheRead,
        output_tokens: SUBAGENT_REQUEST.output,
      },
    },
  }));
  fs.writeFileSync(path.join(projectDir, `${MAIN_SESSION}.jsonl`), `${lines.join('\n')}\n`);

  // 3) 서브에이전트 transcript — sessionId 는 부모입니다.
  const subagentDir = path.join(projectDir, MAIN_SESSION, 'subagents');
  fs.mkdirSync(subagentDir, { recursive: true });
  fs.writeFileSync(path.join(subagentDir, 'agent-x.jsonl'), `${assistant({
    sessionId: MAIN_SESSION, ...SUBAGENT_REQUEST, sidechain: true, timestamp: '2026-08-11T04:00:00.000Z',
  })}\n`);

  // 4) resume 사본 — 같은 요청이 다른 세션 파일에 다시 나타납니다.
  fs.writeFileSync(
    path.join(projectDir, `${RESUMED_SESSION}.jsonl`),
    `${REQUESTS.map((request, index) => assistant({
      sessionId: RESUMED_SESSION, ...request, block: 'text', timestamp: `2026-08-11T0${index + 1}:11:00.000Z`,
    })).join('\n')}\n`,
  );
}

test('ccusage 와 같은 Claude transcript 를 읽어 네 범주와 총합이 일치한다', { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-cc-claude-'));
  const claudeHome = path.join(root, '.claude');
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new ClaudeCollector({ store, claudeHomes: [claudeHome] });

  try {
    writeFixture(claudeHome);
    await collector.reconcile('test:crosscheck');

    const raw = execFileSync(process.execPath, [ccusageCli, 'claude', 'monthly', '--json', '--offline'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const monthly = JSON.parse(raw).monthly ?? [];
    assert.ok(monthly.length > 0, 'ccusage 가 픽스처를 읽지 못했습니다');

    const theirs = monthly.reduce((acc, month) => ({
      inputTokens: acc.inputTokens + month.inputTokens,
      cacheReadTokens: acc.cacheReadTokens + month.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + month.cacheCreationTokens,
      outputTokens: acc.outputTokens + month.outputTokens,
      totalTokens: acc.totalTokens + month.totalTokens,
    }), { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, totalTokens: 0 });
    const ours = store.getProviderTotals('claude');
    const expected = expectedTotals();

    // 먼저 우리 값이 손으로 적은 기대값과 같은지 확인합니다. 두 구현이 같은
    // 방식으로 틀리는 경우를 걸러내기 위해서입니다.
    assert.equal(ours.eventCount, 4, '요청 4건(본 세션 3 + 서브에이전트 1)이어야 합니다');
    assert.equal(ours.inputTokens, expected.inputTokens);
    assert.equal(ours.cachedInputTokens, expected.cachedInputTokens);
    assert.equal(ours.cacheWriteInputTokens, expected.cacheWriteInputTokens);
    assert.equal(ours.outputTokens, expected.outputTokens);
    assert.equal(ours.reasoningTokens, expected.reasoningTokens);

    // 합의하는 것: 프롬프트 쪽 세 범주는 두 구현이 정확히 같아야 합니다.
    assert.equal(ours.inputTokens, theirs.inputTokens, '비캐시 입력이 다릅니다');
    assert.equal(ours.cachedInputTokens, theirs.cacheReadTokens, '캐시 읽기가 다릅니다');
    assert.equal(ours.cacheWriteInputTokens, theirs.cacheCreationTokens, '캐시 쓰기가 다릅니다');

    // 출력은 중복 제거 정책이 갈리면 달라지는 유일한 축입니다. 우리는
    // last-wins(R1)이므로 first-wins 구현보다 **작을 수는 없습니다**.
    // ccusage 20.0.20 은 실측상 우리와 같은 값을 냅니다.
    assert.ok(
      ours.outputTokens >= theirs.outputTokens,
      `우리 출력이 ccusage 보다 작습니다(${ours.outputTokens} < ${theirs.outputTokens}). last-wins 가 깨졌습니다`,
    );
    assert.equal(
      ours.outputTokens, theirs.outputTokens,
      'ccusage 가 중복 제거 정책을 바꿨거나 우리 last-wins 가 깨졌습니다 — 어느 쪽인지 확인하세요',
    );

    // total 은 네 범주의 합입니다(캐시가 input 밖에 있는 회계).
    assert.equal(ours.totalTokens, theirs.totalTokens, '총합이 다릅니다');
    assert.equal(
      ours.totalTokens,
      ours.inputTokens + ours.cachedInputTokens + ours.cacheWriteInputTokens + ours.outputTokens,
      '회계 항등식이 깨졌습니다',
    );

    // 의도적으로 갈라지는 것: 우리는 output_tokens_details.thinking_tokens 를
    // 추론 토큰으로 따로 보고합니다. ccusage 는 이 값을 보고하지 않습니다.
    assert.ok(ours.reasoningTokens > 0, '추론 토큰을 잃었습니다');
    assert.ok(
      monthly.every((month) => month.reasoningOutputTokens == null),
      'ccusage 가 Claude 추론 토큰을 보고하기 시작했습니다 — 이제 대조 항목에 넣을 수 있습니다',
    );
    // 추론은 출력 안에 있으므로 총합에 다시 더하지 않습니다.
    assert.ok(ours.reasoningTokens < ours.outputTokens);
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
