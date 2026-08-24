// Gemini CLI 로그 파서. 여기서 고정하는 것은 실측으로 확정한 회계 계약이고,
// 특히 **다른 두 provider 와 반대인 두 가지**입니다.
//   1) thoughts(추론)가 output 밖에 있다 → output 에서 빼면 안 된다
//   2) cached 가 input 안에 있다 → 프롬프트 분모에 다시 더하면 안 된다
// 근거는 service/providers/gemini/parser.mjs 상단의 실측 정리입니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMINI_PARSER_VERSION,
  createGeminiParserState,
  geminiToolActivity,
  parseGeminiLogLine,
  parseGeminiSessionFile,
  withSourceOffsets,
} from '../service/providers/gemini/parser.mjs';
import { accountingOf, promptSideTokens } from '../service/providers/accounting.mjs';
import { phaseOfTool } from '../service/providers/tool-phases.mjs';
import { decomposeTokens } from '../src/shared.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

function state(overrides = {}) {
  return createGeminiParserState({
    filePath: '/tmp/.gemini/tmp/my-project/chats/session-2026-01-01T00-00-abcd1234.json',
    projectDirName: 'my-project',
    project: { cwd: 'C:\\work\\my-project', projectName: null, resolved: true },
    ...overrides,
  });
}

function sessionDoc(messages) {
  return JSON.stringify({
    sessionId: SESSION_ID,
    projectHash: 'my-project',
    startTime: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:10:00.000Z',
    messages,
  });
}

test('추론 토큰은 출력 밖에 있으므로 출력에서 빼지 않는다', () => {
  const events = parseGeminiSessionFile(sessionDoc([
    { id: 'u1', timestamp: '2026-01-01T00:00:01.000Z', type: 'user', content: 'x' },
    {
      id: 'g1',
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'gemini',
      model: 'gemini-3-pro-preview',
      tokens: { input: 1000, output: 50, cached: 400, thoughts: 20, tool: 0, total: 1070 },
    },
  ]), state());

  const usage = events.find((event) => event.type === 'usage');
  assert.ok(usage, '사용량 이벤트가 나와야 합니다');
  assert.equal(usage.delta.outputTokens, 50, '출력은 로그 값 그대로여야 합니다');
  assert.equal(usage.delta.reasoningTokens, 20);
  assert.equal(usage.delta.totalTokens, 1070);
  // 1000 + 50 + 20 === 1070 — 이 항등식이 이 provider 의 계약입니다.
  assert.equal(
    usage.delta.inputTokens + usage.delta.outputTokens + usage.delta.reasoningTokens,
    usage.delta.totalTokens,
  );
  assert.equal(usage.measurementQuality, 'local_exact');
  assert.equal(usage.parserVersion, GEMINI_PARSER_VERSION);
  assert.equal(usage.eventKey, 'gemini|g1');
});

test('캐시 읽기는 input 안쪽이므로 프롬프트 분모에 다시 더하지 않는다', () => {
  assert.equal(accountingOf('gemini'), 'cache_in_input');
  // input 1000 안에 cached 400 이 들어 있으므로 프롬프트 쪽 토큰은 1000 입니다.
  // cache_disjoint 로 잘못 두면 1400 이 되어 캐시 적중률이 부풀려집니다.
  assert.equal(promptSideTokens('gemini', {
    inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 0,
  }), 1000);
});

test('분해는 네 조각으로 겹치지 않게 쌓이고 합이 total 과 정확히 같다', () => {
  const decomposed = decomposeTokens({
    inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 0,
    outputTokens: 50, reasoningTokens: 20, totalTokens: 1070,
  });
  assert.equal(decomposed.nested, true, 'Gemini 항등식이 분해 분기에 있어야 합니다');
  assert.equal(decomposed.segments.reduce((sum, segment) => sum + segment.value, 0), 1070);
  const byKey = Object.fromEntries(decomposed.segments.map((segment) => [segment.key, segment.value]));
  assert.equal(byKey.cachedInputTokens, 400);
  assert.equal(byKey.inputTokens, 600, '비캐시 입력 = input - cached');
  assert.equal(byKey.outputTokens, 50, '출력에서 추론을 빼면 합이 total 에 못 미칩니다');
  assert.equal(byKey.reasoningTokens, 20);
  assert.deepEqual(decomposed.extras, []);
});

test('항등식이 깨지면 보정하지 않고 불일치로 표시한다', () => {
  // total 이 합과 다른 레코드. 값을 고쳐 맞추면 로그가 바뀐 사실이 숨습니다.
  const parserState = state();
  const events = parseGeminiSessionFile(sessionDoc([
    { id: 'g1', timestamp: '2026-01-01T00:00:02.000Z', type: 'gemini', tokens: { input: 100, output: 10, cached: 0, thoughts: 0, tool: 7, total: 117 } },
  ]), parserState);
  const usage = events.find((event) => event.type === 'usage');
  assert.equal(usage.delta.totalTokens, 117, 'total 은 로그 값을 그대로 씁니다');
  assert.equal(usage.delta.toolTokens, 7);
  assert.equal(usage.measurementQuality, 'partial', '항등식이 안 맞으면 등급이 내려갑니다');
  assert.equal(usage.discrepancies.reportedTotalTokens, 117);
  assert.equal(usage.discrepancies.summedTotalTokens, 110);
  assert.equal(parserState.stats.identityMismatches, 1);
  assert.equal(parserState.stats.toolTokensSeen, 1);
  // 자리를 모르는 tool 이 섞이면 분해는 포기합니다 — 지어내지 않습니다.
  assert.equal(decomposeTokens(usage.delta).nested, false);
});

test('cached 가 input 보다 크면 캐시 등급만 내리고 값은 건드리지 않는다', () => {
  const parserState = state();
  const events = parseGeminiSessionFile(sessionDoc([
    { id: 'g1', timestamp: '2026-01-01T00:00:02.000Z', type: 'gemini', tokens: { input: 10, output: 5, cached: 90, thoughts: 0, tool: 0, total: 15 } },
  ]), parserState);
  const usage = events.find((event) => event.type === 'usage');
  assert.equal(usage.delta.cachedInputTokens, 90, '값을 잘라내면 로그와 달라집니다');
  assert.equal(usage.fieldQuality.cachedInputTokens, 'partial');
  assert.equal(parserState.stats.cacheOutsideInput, 1);
});

test('턴 경계는 사람 메시지이고, 경계 앞의 사용량은 0번 버킷에 남는다', () => {
  const events = parseGeminiSessionFile(sessionDoc([
    { id: 'g0', timestamp: '2026-01-01T00:00:00.500Z', type: 'gemini', tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 } },
    { id: 'u1', timestamp: '2026-01-01T00:00:01.000Z', type: 'user', content: 'x' },
    { id: 'g1', timestamp: '2026-01-01T00:00:02.000Z', type: 'gemini', tokens: { input: 7, output: 2, cached: 0, thoughts: 0, tool: 0, total: 9 } },
    { id: 'u2', timestamp: '2026-01-01T00:00:03.000Z', type: 'user', content: 'y' },
    { id: 'g2', timestamp: '2026-01-01T00:00:04.000Z', type: 'gemini', tokens: { input: 8, output: 3, cached: 0, thoughts: 0, tool: 0, total: 11 } },
  ]), state());

  const usages = events.filter((event) => event.type === 'usage');
  assert.deepEqual(usages.map((event) => event.turnIndex), [0, 1, 2]);
  const turns = events.filter((event) => event.type === 'turn');
  assert.deepEqual(turns.map((event) => event.turnIndex), [1, 2]);
  // 컴팩션 표시를 로그에서 찾지 못했으므로 있는 것처럼 적지 않습니다.
  assert.ok(turns.every((event) => event.compacted === false));
});

test('info / error 메시지와 토큰 없는 메시지는 사용량을 만들지 않는다', () => {
  const parserState = state();
  const events = parseGeminiSessionFile(sessionDoc([
    { id: 'i1', timestamp: '2026-01-01T00:00:01.000Z', type: 'info', content: 'x' },
    { id: 'e1', timestamp: '2026-01-01T00:00:02.000Z', type: 'error', content: 'x' },
    { id: 'g1', timestamp: '2026-01-01T00:00:03.000Z', type: 'gemini', content: 'x' },
  ]), parserState);
  assert.equal(events.filter((event) => event.type === 'usage').length, 0);
  assert.equal(parserState.stats.messagesWithoutTokens, 1, 'gemini 응답만 셉니다');
});

test('도구는 이름과 경로 뒤 두 조각만 남고 인자 본문은 읽지 않는다', () => {
  const activity = geminiToolActivity({
    toolCalls: [
      { name: 'read_file', args: { file_path: 'C:\\work\\my-project\\src\\deep\\app.js' }, result: 'SECRET-RESULT' },
      { name: 'read_file', args: { absolute_path: '/home/dev/other/lib.js' } },
      { name: 'run_shell_command', args: { command: 'SECRET-COMMAND --token=abc' } },
      { name: 'replace', args: { file_path: '/a/b/c.txt', old_string: 'SECRET-OLD', new_string: 'SECRET-NEW' } },
      { args: { file_path: '/x/y.txt' } },
    ],
  });
  assert.deepEqual(activity.toolCounts, { read_file: 2, run_shell_command: 1, replace: 1 });
  assert.deepEqual(activity.touchedPaths, { 'deep/app.js': 1, 'other/lib.js': 1, 'b/c.txt': 1 });
  const serialized = JSON.stringify(activity);
  for (const secret of ['SECRET-RESULT', 'SECRET-COMMAND', 'SECRET-OLD', 'SECRET-NEW', 'my-project']) {
    assert.ok(!serialized.includes(secret), `${secret} 가 도구 활동에 남아 있습니다`);
  }
});

test('내장 도구만 단계로 분류하고 MCP·프로젝트 전용 이름은 other 로 둔다', () => {
  assert.equal(phaseOfTool('gemini', 'read_file'), 'explore');
  assert.equal(phaseOfTool('gemini', 'write_file'), 'implement');
  assert.equal(phaseOfTool('gemini', 'run_shell_command'), 'verify');
  assert.equal(phaseOfTool('gemini', 'write_todos'), 'plan');
  assert.equal(phaseOfTool('gemini', 'ask_user'), 'clarify');
  assert.equal(phaseOfTool('gemini', 'delegate_to_agent'), 'delegate');
  // 실제 코퍼스에 있었지만 우리 어휘가 아닌 이름들.
  assert.equal(phaseOfTool('gemini', 'mcp_chrome-devtools_click'), 'other');
  assert.equal(phaseOfTool('gemini', 'API-post-page'), 'other');
});

test('.jsonl 은 헤더 · 메시지 · $set 세 종류 줄을 구분한다', () => {
  const parserState = createGeminiParserState({
    filePath: '/tmp/.gemini/tmp/proj/chats/session-2026-01-01T00-00-abcd1234.jsonl',
    project: { cwd: null, projectName: 'proj', resolved: false },
    sessionKey: 'gemini-deadbeefdeadbeef',
  });

  const header = parseGeminiLogLine(JSON.stringify({
    sessionId: SESSION_ID, projectHash: 'proj', startTime: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:00:00.000Z', kind: 'main',
  }), parserState);
  assert.equal(header.length, 1);
  assert.equal(header[0].type, 'session');
  assert.equal(header[0].session.startedAt, '2026-01-01T00:00:00.000Z');
  // 로그의 sessionId 는 정체로 쓰지 않습니다 — 실측에서 파일 347개가 한 값을
  // 공유했습니다. 정체는 수집기가 경로에서 만들어 씨앗으로 넣습니다.
  assert.notEqual(header[0].session.sessionId, SESSION_ID);
  assert.equal(header[0].session.sessionId, 'gemini-deadbeefdeadbeef');

  // 사람 메시지가 턴 경계입니다.
  const boundary = parseGeminiLogLine(JSON.stringify({
    id: 'u9', timestamp: '2026-01-01T00:00:02.000Z', type: 'user', content: 'x',
  }), parserState);
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0].type, 'turn');
  assert.equal(boundary[0].turnIndex, 1);

  // $set 은 어떤 형태든 이벤트를 만들지 않습니다.
  for (const patch of [
    { $set: { lastUpdated: '2026-01-01T00:00:01.000Z' } },
    { $set: { summary: 'x' } },
    { $set: { messages: [{ id: 'u9', timestamp: '2026-01-01T00:00:02.000Z', type: 'user', content: 'x' }] } },
  ]) {
    assert.deepEqual(parseGeminiLogLine(JSON.stringify(patch), parserState), [],
      `${Object.keys(patch.$set)[0]} 패치는 아무 이벤트도 만들지 않습니다`);
  }

  // 회귀 방지: $set.messages 를 턴 경계로 받으면 같은 프롬프트의 재기록마다
  // 번호가 올라갑니다. 실측에서 1,982건의 고유 id 가 단 1개였고 턴이 1.7배로
  // 부풀었습니다.
  const setUser = { $set: { messages: [{ id: 'u9', timestamp: '2026-01-01T00:00:02.000Z', type: 'user', content: 'x' }] } };
  for (let i = 0; i < 50; i += 1) parseGeminiLogLine(JSON.stringify(setUser), parserState);
  assert.equal(parserState.turn.index, 1, '$set 재기록 50번이 턴 번호를 올리면 안 됩니다');

  const usage = parseGeminiLogLine(JSON.stringify({
    id: 'g9', timestamp: '2026-01-01T00:00:03.000Z', type: 'gemini', model: 'gemini-2.5-pro',
    tokens: { input: 30, output: 4, cached: 10, thoughts: 6, tool: 0, total: 40 },
  }), parserState);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].type, 'usage');
  assert.equal(usage[0].turnIndex, 1, '사람 메시지로 만든 턴에 매달려야 합니다');
  assert.equal(usage[0].session.sessionId, 'gemini-deadbeefdeadbeef');
  assert.equal(usage[0].delta.reasoningTokens, 6);

  assert.deepEqual(parseGeminiLogLine('', parserState), []);
  assert.deepEqual(parseGeminiLogLine('{not json', parserState), [{ type: 'parse_error', reason: 'invalid_json' }]);
});

test('경로가 하나면 세션 경로로 쓰고, 둘이면 고르지 않는다', () => {
  const single = createGeminiParserState({ filePath: '/x/chats/a.json', project: { cwd: null, projectName: 'slug', resolved: false } });
  parseGeminiSessionFile(JSON.stringify({
    sessionId: SESSION_ID, startTime: '2026-01-01T00:00:00.000Z',
    directories: ['D:\\git\\node\\only-one'], messages: [],
  }), single);
  assert.equal(single.session.cwd, 'D:\\git\\node\\only-one');
  assert.equal(single.session.projectName, 'only-one');

  const many = createGeminiParserState({ filePath: '/x/chats/a.json', project: { cwd: null, projectName: 'slug', resolved: false } });
  parseGeminiSessionFile(JSON.stringify({
    sessionId: SESSION_ID, startTime: '2026-01-01T00:00:00.000Z',
    directories: ['D:\\one', 'D:\\two'], messages: [],
  }), many);
  assert.equal(many.session.cwd, null, '둘 중 하나를 고르면 남의 경로를 붙이게 됩니다');
  assert.equal(many.session.projectName, 'slug');
});

test('스냅샷 커서는 사용량 이벤트 순번이고 세션·턴은 그 번호를 공유한다', () => {
  const events = parseGeminiSessionFile(sessionDoc([
    { id: 'u1', timestamp: '2026-01-01T00:00:01.000Z', type: 'user', content: 'x' },
    { id: 'g1', timestamp: '2026-01-01T00:00:02.000Z', type: 'gemini', tokens: { input: 1, output: 1, cached: 0, thoughts: 0, tool: 0, total: 2 } },
    { id: 'g2', timestamp: '2026-01-01T00:00:03.000Z', type: 'gemini', tokens: { input: 2, output: 1, cached: 0, thoughts: 0, tool: 0, total: 3 } },
  ]), state());
  const offsets = withSourceOffsets(events);
  const usageOffsets = offsets.filter((entry) => entry.event.type === 'usage').map((entry) => entry.sourceOffset);
  assert.deepEqual(usageOffsets, [0, 1], '사용량마다 하나씩 올라가야 UNIQUE 제약이 겹치지 않습니다');
});
