// 상세 내역(프로젝트 → 세션 → 도구, 토큰량) 테스트.
//
// 검사하는 계약은 넷입니다(docs/dev/menus/detail.md 의 완료 기준).
//   1. 도구별 토큰량이 원장의 세션 합계와 어긋나지 않고, 재개 사본에도 안 부푼다
//   2. 담는 기준(cost/time)과 행 상한이 서버·화면에서 같은 값이고, 자르면 적는다
//   3. 목록 응답에는 본문이 없다 (센티넬 전수 검사)
//   4. 본문은 [내용 보기] 전용 통로로만, 그 호출 하나만, 저장 없이 나간다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { UsageApiServer } from '../service/api-server.mjs';
import { UsageStore } from '../service/store.mjs';
import { ClaudeCollector } from '../service/providers/claude/collector.mjs';
import { readSessionRecords } from '../service/providers/turn-detail-readers.mjs';
import { readToolCallContent, capText, TOOL_CONTENT_LIMIT_BYTES } from '../service/providers/tool-content.mjs';
import { normalizeRowLimit, normalizeOrder, ROW_LIMITS, DEFAULT_ROW_LIMIT } from '../service/providers/session-records.mjs';

const CWD = 'C:\\Users\\dev\\git\\node\\records-app';
const PROJECT_DIR = 'C--Users-dev-git-node-records-app';
const SESSION = 'ab5e5e5e-0000-4000-8000-000000000010';

// 본문이 목록 응답에 새는지 보려면 본문 자리에 표식을 넣고 응답 전체를
// 훑어야 합니다 — turn-detail.test.mjs 와 같은 방법입니다.
const SENTINELS = [
  'SENTINEL-PROMPT-TEXT',
  'SENTINEL-ASSISTANT-TEXT',
  'SENTINEL-TOOL-INPUT',
  'SENTINEL-TOOL-OUTPUT',
];

function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-session-records-'));
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
    type: 'user', sessionId: SESSION, cwd: CWD, timestamp: at,
    message: { role: 'user', content: [{ type: 'text', text: 'SENTINEL-PROMPT-TEXT' }] },
  });
}

function assistant({ at, messageId, output = 100, cacheRead = 1000, tools = [] }) {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${messageId}-uuid`,
    requestId: `req-${messageId}`,
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
        ...tools.map((tool) => ({
          type: 'tool_use',
          id: tool.id,
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

// 도구 결과. 두 곳에 저장되는 실제 로그 모양을 그대로 흉내 냅니다 —
// toolUseResult(원본)와 message.content[].tool_result(모델에 되먹인 것).
function toolResult({ at, toolUseId, text = 'SENTINEL-TOOL-OUTPUT' }) {
  return JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    cwd: CWD,
    timestamp: at,
    toolUseResult: { stdout: `${text}-RAW` },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  });
}

// 턴 1 = 채팅 1 + 도구 2회(한 요청) + MCP 1, 턴 2 = 채팅 1. 도구 호출마다 결과가
// 이어집니다.
function writeTranscript(target) {
  fs.mkdirSync(target.projectDir, { recursive: true });
  fs.writeFileSync(path.join(target.projectDir, `${SESSION}.jsonl`), [
    humanPrompt('2026-08-24T01:00:00.000Z'),
    assistant({ at: '2026-08-24T01:00:01.000Z', messageId: 'msg_1', output: 100 }),
    assistant({
      at: '2026-08-24T01:00:02.000Z',
      messageId: 'msg_2',
      output: 200,
      tools: [{ id: 'toolu_read', name: 'Read', file: '/repo/src/App.jsx' }, { id: 'toolu_edit', name: 'Edit', file: '/repo/src/App.jsx' }],
    }),
    toolResult({ at: '2026-08-24T01:00:03.000Z', toolUseId: 'toolu_read' }),
    assistant({
      at: '2026-08-24T01:00:04.000Z',
      messageId: 'msg_3',
      output: 300,
      tools: [{ id: 'toolu_mcp', name: 'mcp__github__list_issues' }],
    }),
    humanPrompt('2026-08-24T01:10:00.000Z'),
    assistant({ at: '2026-08-24T01:10:01.000Z', messageId: 'msg_4', output: 50 }),
    '',
  ].join('\n'));
}

test('행 상한과 담는 기준은 목록 밖의 값을 받지 않는다', () => {
  // 화면과 서버가 같은 목록을 봐야 "100행을 골랐는데 서버는 400행" 이 안 됩니다.
  assert.deepEqual(ROW_LIMITS, [20, 50, 100, 1000]);
  for (const value of ROW_LIMITS) assert.equal(normalizeRowLimit(value), value);
  for (const bogus of [7, 999, 5000, null, 'many', -20]) {
    assert.equal(normalizeRowLimit(bogus), DEFAULT_ROW_LIMIT, `${bogus} 는 기본값으로 접혀야 합니다`);
  }
  assert.equal(normalizeOrder('time'), 'time');
  assert.equal(normalizeOrder('cost'), 'cost');
  // 기본이 비용순인 이유: 시간순으로 앞에서 자르면 정작 비싼 행이 밀려납니다.
  assert.equal(normalizeOrder(null), 'cost');
  assert.equal(normalizeOrder('random'), 'cost');
});

test('세션 전체가 도구별로 갈리고 합계가 원장과 맞는다', async () => {
  const target = env();
  try {
    writeTranscript(target);
    await target.collector.reconcile('test:records');

    const source = target.store.getSessionSource({ provider: 'claude', sessionId: SESSION });
    assert.ok(source, '세션의 원본 포인터가 있어야 합니다');
    assert.equal(source.ledger.requestCount, 4);
    assert.equal(source.ledger.turnCount, 2);

    const detail = await readSessionRecords({ provider: 'claude', sourcePaths: source.sourcePaths });
    assert.equal(detail.available, true);
    // 완료 기준: 도구별 토큰량 합계 == 원장의 세션 합계.
    assert.equal(detail.totals.totalTokens, source.ledger.totalTokens);
    assert.equal(detail.totals.requestCount, 4);

    const byKey = Object.fromEntries(detail.toolBreakdown.map((row) => [row.key, row]));
    assert.deepEqual(Object.keys(byKey).sort(), ['chat', 'file', 'mcp', 'tool']);
    // 파이에 들어가는 셋은 서로 겹치지 않고 합이 세션 합계입니다.
    const pie = detail.toolBreakdown.filter((row) => row.pie);
    assert.equal(pie.reduce((sum, row) => sum + row.tokens, 0), detail.totals.totalTokens);
    // 턴 상세와 **같은** 배분 규칙이라 도구 이름별로 갈립니다.
    assert.deepEqual(byKey.tool.children.map((row) => row.label).sort(), ['Edit', 'Read']);
    assert.deepEqual(byKey.mcp.children[0].children.map((row) => row.label), ['list_issues']);

    // 표는 요청 행만 세웁니다 — 턴 경계 표시는 행이 아니라 turnIndex 로 나타납니다.
    assert.equal(detail.records.length, 4);
    assert.ok(detail.records.every((row) => row.kind === 'request'));
    assert.deepEqual([...new Set(detail.records.map((row) => row.turnIndex))].sort(), [1, 2]);

    // 내용 보기 손잡이: 본문이 아니라 id + 이름만.
    const withTools = detail.records.find((row) => row.toolCalls?.length === 2);
    assert.deepEqual(withTools.toolCalls, [
      { id: 'toolu_read', tool: 'Read' },
      { id: 'toolu_edit', tool: 'Edit' },
    ]);
  } finally {
    target.dispose();
  }
});

test('담는 기준이 비용순이면 비싼 행부터, 시간순이면 대화 순서대로 담는다', async () => {
  const target = env();
  try {
    writeTranscript(target);
    await target.collector.reconcile('test:order');
    const source = target.store.getSessionSource({ provider: 'claude', sessionId: SESSION });

    const cheapestFirst = await readSessionRecords({
      provider: 'claude', sourcePaths: source.sourcePaths, order: 'time', limit: 20,
    });
    const times = cheapestFirst.records.map((row) => Date.parse(row.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), '시간순은 오름차순이어야 합니다');

    const costliest = await readSessionRecords({
      provider: 'claude', sourcePaths: source.sourcePaths, order: 'cost', limit: 20,
    });
    const costs = costliest.records.map((row) => row.tokens.totalTokens);
    assert.deepEqual(costs, [...costs].sort((a, b) => b - a), '비용순은 내림차순이어야 합니다');

    // 상한이 답을 가리지 않는지: 1행만 담아도 비용순이면 **가장 비싼** 행입니다.
    const topOne = await readSessionRecords({
      provider: 'claude', sourcePaths: source.sourcePaths, order: 'cost', limit: 20,
    });
    assert.equal(topOne.records[0].tokens.totalTokens, Math.max(...costs));
    // 담긴 행이 전체보다 적으면 그 사실을 적습니다.
    assert.equal(costliest.truncated, false);
    assert.equal(costliest.recordCount, 4);
    assert.equal(costliest.limit, 20);
    assert.equal(costliest.order, 'cost');
  } finally {
    target.dispose();
  }
});

test('상한에 걸려도 비용순이면 비싼 행이 살아남고, 자른 사실을 적는다', async () => {
  const target = env();
  try {
    // 요청 25개 — 상한 20 을 넘깁니다. 가장 비싼 요청을 **맨 뒤**(시간상 마지막)에
    // 두는 것이 이 테스트의 핵심입니다: 시간순으로 앞에서 20개를 자르면 정작
    // 비싼 행이 상한 밖으로 밀려납니다.
    fs.mkdirSync(target.projectDir, { recursive: true });
    const lines = [humanPrompt('2026-08-24T02:00:00.000Z')];
    for (let index = 0; index < 25; index += 1) {
      const costly = index === 24;
      lines.push(assistant({
        at: new Date(Date.parse('2026-08-24T02:00:00.000Z') + (index + 1) * 1000).toISOString(),
        messageId: `bulk_${index}`,
        output: costly ? 99_000 : 100,
        cacheRead: 1000,
      }));
    }
    lines.push('');
    fs.writeFileSync(path.join(target.projectDir, `${SESSION}.jsonl`), lines.join('\n'));
    await target.collector.reconcile('test:truncate');
    const source = target.store.getSessionSource({ provider: 'claude', sessionId: SESSION });

    const capped = await readSessionRecords({
      provider: 'claude', sourcePaths: source.sourcePaths, order: 'cost', limit: 20,
    });
    assert.equal(capped.records.length, 20);
    // 잘린 사실과 **잘리기 전 전체 개수**를 함께 적습니다 — 조용히 자르면
    // 화면이 "전체가 20행" 이라고 거짓말합니다.
    assert.equal(capped.truncated, true);
    assert.equal(capped.recordCount, 25);
    // 가장 비싼 행이 살아남습니다. 이것이 기본 정렬을 비용순으로 둔 이유입니다.
    assert.equal(capped.records[0].tokens.outputTokens, 99_000);

    // 반대 확인: 시간순으로 자르면 그 행이 빠집니다. 화면이 담는 기준을
    // 고를 수 있어야 하는 이유이자, 기본이 비용순이어야 하는 근거입니다.
    const byTime = await readSessionRecords({
      provider: 'claude', sourcePaths: source.sourcePaths, order: 'time', limit: 20,
    });
    assert.equal(byTime.records.some((row) => row.tokens.outputTokens === 99_000), false);

    // 상한과 무관하게 **합계는 전체**입니다 — 도구별 배분이 담긴 행만으로
    // 계산되면 "표는 20행, 비중은 25행" 이 되어 둘이 어긋납니다.
    assert.equal(capped.totals.requestCount, 25);
    assert.equal(capped.totals.totalTokens, source.ledger.totalTokens);
    assert.equal(byTime.totals.totalTokens, capped.totals.totalTokens);
  } finally {
    target.dispose();
  }
});

test('재개 사본이 있어도 행과 합계가 부풀지 않는다', async () => {
  const target = env();
  try {
    writeTranscript(target);
    const original = path.join(target.projectDir, `${SESSION}.jsonl`);
    const copy = path.join(target.projectDir, `${SESSION}-resume.jsonl`);
    fs.copyFileSync(original, copy);
    await target.collector.reconcile('test:resume');

    // 사본의 요청은 원장에서 eventKey 로 접히므로 **기여한 파일이 아닙니다** —
    // 그래서 원본 포인터에는 한 벌만 남습니다. 이 한 겹이 이미 부풀림을 막지만,
    // 그것에만 기대지 않고 아래에서 두 파일을 강제로 넘겨 상세 쪽 중복 제거도
    // 검사합니다(원장과 상세가 같은 기준으로 접어야 합니다).
    const source = target.store.getSessionSource({ provider: 'claude', sessionId: SESSION });
    assert.equal(source.sourcePaths.length, 1, '사본은 기여 파일로 남지 않습니다');
    assert.equal(source.ledger.requestCount, 4, '원장이 사본만큼 부풀면 안 됩니다');

    const detail = await readSessionRecords({ provider: 'claude', sourcePaths: [original, copy] });
    assert.equal(detail.totals.requestCount, 4, '같은 요청을 두 번 세면 안 됩니다');
    assert.equal(detail.records.length, 4);
    assert.equal(detail.totals.totalTokens, source.ledger.totalTokens);
    assert.equal(detail.duplicateCount, 4);
    assert.equal(detail.scanned.length, 2, '읽은 파일은 둘 다 보고합니다');
  } finally {
    target.dispose();
  }
});

test('목록 응답에 대화 본문이 실리지 않는다', async () => {
  const target = env();
  try {
    writeTranscript(target);
    await target.collector.reconcile('test:privacy');
    const source = target.store.getSessionSource({ provider: 'claude', sessionId: SESSION });
    const detail = await readSessionRecords({ provider: 'claude', sourcePaths: source.sourcePaths });
    const serialized = JSON.stringify(detail);
    for (const sentinel of SENTINELS) {
      assert.equal(serialized.includes(sentinel), false, `${sentinel} 이 목록 응답에 새면 안 됩니다`);
    }
    // 도구 **이름**과 호출 id 는 남습니다 — 본문이 아니라 구조입니다.
    assert.ok(serialized.includes('toolu_read'));
    assert.ok(serialized.includes('Read'));
  } finally {
    target.dispose();
  }
});

test('내용 보기는 요청한 호출 하나의 본문만 준다', async () => {
  const target = env();
  try {
    writeTranscript(target);
    await target.collector.reconcile('test:content');
    const source = target.store.getSessionSource({ provider: 'claude', sessionId: SESSION });

    const content = await readToolCallContent({
      provider: 'claude', sourcePaths: source.sourcePaths, toolUseId: 'toolu_read',
    });
    assert.equal(content.available, true);
    assert.equal(content.tool, 'Read');
    // input 과 결과가 둘 다 나옵니다 — 이 통로의 목적이 그것입니다.
    assert.ok(content.input.content.includes('SENTINEL-TOOL-INPUT'));
    assert.equal(content.result.content, 'SENTINEL-TOOL-OUTPUT');
    assert.equal(content.input.truncated, false);
    assert.ok(content.source.path);

    // **그 호출 하나만** 입니다. 다른 호출의 결과나 프롬프트·응답 본문은 없습니다.
    const serialized = JSON.stringify(content);
    assert.equal(serialized.includes('SENTINEL-PROMPT-TEXT'), false);
    assert.equal(serialized.includes('SENTINEL-ASSISTANT-TEXT'), false);
    // 원본 stdout 이 아니라 모델에 되먹인 tool_result 를 읽습니다 — 잘리기 전
    // 원본과 모델이 실제로 본 것이 다를 수 있고, 이 화면의 질문은 후자입니다.
    assert.equal(serialized.includes('SENTINEL-TOOL-OUTPUT-RAW'), false);

    // 결과가 없는 호출도 지어내지 않습니다.
    const noResult = await readToolCallContent({
      provider: 'claude', sourcePaths: source.sourcePaths, toolUseId: 'toolu_edit',
    });
    assert.equal(noResult.available, true);
    assert.equal(noResult.tool, 'Edit');
    assert.equal(noResult.result, null);

    // 없는 호출은 없다고 답합니다.
    const missing = await readToolCallContent({
      provider: 'claude', sourcePaths: source.sourcePaths, toolUseId: 'toolu_nope',
    });
    assert.equal(missing.available, false);
    assert.equal(missing.reason, 'tool_call_not_found');
  } finally {
    target.dispose();
  }
});

test('내용 보기는 상한을 넘으면 앞부분만 싣고 잘렸다고 적는다', () => {
  const small = capText('짧은 결과');
  assert.equal(small.truncated, false);
  assert.equal(small.content, '짧은 결과');

  // 한글은 문자당 3바이트라 문자수로 자르면 상한을 세 배까지 넘깁니다.
  const huge = '가'.repeat(TOOL_CONTENT_LIMIT_BYTES);
  const capped = capText(huge);
  assert.equal(capped.truncated, true);
  assert.equal(capped.chars, huge.length, '원래 크기는 그대로 적습니다');
  assert.ok(Buffer.from(capped.content, 'utf8').length <= TOOL_CONTENT_LIMIT_BYTES);
  // 잘린 자리에서 UTF-8 시퀀스가 갈라지면 안 됩니다.
  assert.equal(capped.content.includes('\uFFFD'), false);
});

test('아직 확인하지 않은 provider 는 빈 내용이 아니라 미지원으로 답한다', async () => {
  for (const [provider, reason] of [
    ['codex', 'provider_unverified'],
    ['gemini', 'provider_not_implemented'],
    ['cursor', 'provider_has_no_turns'],
    ['nope', 'provider_unknown'],
  ]) {
    const content = await readToolCallContent({ provider, sourcePaths: ['/nowhere/x.jsonl'], toolUseId: 'toolu_x' });
    assert.equal(content.available, false, `${provider} 는 미지원이어야 합니다`);
    assert.equal(content.reason, reason);
    assert.equal(content.input, null);
    assert.equal(content.result, null);
  }
});

test('API 가 상세 내역을 내려 주고, 본문은 전용 통로로만 나간다', async () => {
  const target = env();
  writeTranscript(target);
  await target.collector.reconcile('test:api');

  const engine = new EventEmitter();
  engine.store = target.store;
  engine.snapshot = () => ({ generatedAt: '2026-08-24T01:20:00.000Z' });
  engine.defaultSince = () => null;
  const server = new UsageApiServer({ usageEngine: engine, accessToken: 'test-token', heartbeatMs: 60_000 });
  const baseUrl = await server.start();
  const headers = { 'X-Nyang-Access-Token': 'test-token' };
  const recordsUrl = `${baseUrl}/api/v1/sessions/${SESSION}/records?provider=claude`;
  const contentUrl = `${baseUrl}/api/v1/sessions/${SESSION}/tool-calls/toolu_read/content?provider=claude`;

  try {
    assert.equal((await fetch(recordsUrl)).status, 401, '토큰 없이 열리면 안 됩니다');
    assert.equal((await fetch(contentUrl)).status, 401, '내용 통로도 토큰이 필요합니다');

    // 1층: 최근 작업 프로젝트.
    const recent = await fetch(`${baseUrl}/api/v1/projects/recent?limit=5&all=1`, { headers }).then((r) => r.json());
    assert.equal(recent.projects.length, 1);
    const projectKey = recent.projects[0].projectKey;

    // 2층: 그 프로젝트의 세션.
    const sessions = await fetch(`${baseUrl}/api/v1/projects/${projectKey}/sessions?all=1`, { headers }).then((r) => r.json());
    assert.equal(sessions.sessions[0].sessionId, SESSION);
    assert.equal(sessions.sessions[0].provider, 'claude');

    // 3·4층: 도구별 토큰량 + 요청 행. **본문은 없습니다.**
    const records = await fetch(recordsUrl, { headers }).then((r) => r.json());
    assert.equal(records.available, true);
    assert.equal(records.limit, 100);
    assert.equal(records.order, 'cost');
    assert.equal(records.measured.totalTokens, records.ledger.totalTokens);
    for (const sentinel of SENTINELS) {
      assert.equal(JSON.stringify(records).includes(sentinel), false, `${sentinel} 이 목록 API 에 새면 안 됩니다`);
    }

    // 상한 밖의 limit 은 기본값으로 접힙니다.
    const odd = await fetch(`${recordsUrl}&limit=7`, { headers }).then((r) => r.json());
    assert.equal(odd.limit, 100);

    // 본문은 여기서만 나옵니다. 그리고 no-store 입니다 — 브라우저·프록시가
    // 도구 출력을 캐시에 남기면 "저장하지 않는다" 가 거짓이 됩니다.
    const contentResponse = await fetch(contentUrl, { headers });
    assert.equal(contentResponse.headers.get('cache-control'), 'no-store');
    const content = await contentResponse.json();
    assert.equal(content.available, true);
    assert.ok(content.result.content.includes('SENTINEL-TOOL-OUTPUT'));

    // 열람이 저장을 만들지 않습니다 — 원장 바이트에 본문이 없어야 합니다.
    const dbBytes = fs.readFileSync(target.store.dbPath);
    for (const sentinel of SENTINELS) {
      assert.equal(dbBytes.includes(Buffer.from(sentinel)), false, `${sentinel} 이 SQLite 에 남으면 안 됩니다`);
    }

    // 없는 세션은 404 입니다 — 빈 상세를 만들어 주지 않습니다.
    assert.equal((await fetch(`${baseUrl}/api/v1/sessions/nope/records?provider=claude`, { headers })).status, 404);

    // 가림을 켜면 목록은 경로만 빠지고, **내용 통로는 거부**합니다. 경로만
    // 가리고 본문을 내주면 가림의 목적이 사라집니다.
    target.store.setProjectAlias({ provider: 'claude', projectKey, alias: '(가림) 기록앱', redacted: true });
    const hidden = await fetch(recordsUrl, { headers }).then((r) => r.json());
    assert.equal(hidden.redacted, true);
    assert.equal(hidden.source.files[0].path, null);
    assert.deepEqual(hidden.files, []);
    assert.ok(hidden.toolBreakdown.some((row) => row.key === 'tool'), '도구 내역은 그대로 남습니다');
    assert.equal(JSON.stringify(hidden).includes(PROJECT_DIR), false);

    const refused = await fetch(contentUrl, { headers }).then((r) => r.json());
    assert.equal(refused.available, false);
    assert.equal(refused.reason, 'redacted');
    assert.equal(refused.result, null);
    assert.equal(JSON.stringify(refused).includes('SENTINEL-TOOL-OUTPUT'), false);
  } finally {
    await server.stop();
    target.dispose();
  }
});
