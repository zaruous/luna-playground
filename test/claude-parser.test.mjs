import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_PARSER_VERSION,
  claudeEventKey,
  claudeProjectName,
  claudeSessionIdFromPath,
  compareCliVersion,
  createClaudeParserState,
  normalizeClaudeUsage,
  parseClaudeTranscriptLine,
} from '../service/providers/claude/parser.mjs';

const CWD = 'C:\\Users\\dev\\git\\node\\sample-app';

function assistant(overrides = {}) {
  const { usage, ...rest } = overrides;
  return {
    type: 'assistant',
    uuid: 'aaaaaaaa-0000-4000-8000-000000000001',
    parentUuid: null,
    isSidechain: false,
    requestId: 'req_test_1',
    timestamp: '2026-08-21T01:00:00.000Z',
    sessionId: '11111111-1111-4111-8111-111111111111',
    cwd: CWD,
    version: '2.1.232',
    gitBranch: 'main',
    entrypoint: 'cli',
    userType: 'external',
    message: {
      id: 'msg_test_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'SENTINEL-ASSISTANT-TEXT' }],
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 4000,
        cache_read_input_tokens: 90000,
        output_tokens: 500,
        output_tokens_details: { thinking_tokens: 120 },
        cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 0 },
        service_tier: 'standard',
        ...usage,
      },
    },
    ...rest,
  };
}

function parse(record, state = createClaudeParserState({ filePath: '/p/session.jsonl' })) {
  return { events: parseClaudeTranscriptLine(JSON.stringify(record), state), state };
}

test('assistant 레코드는 요청 단위 값을 그대로 쓰고 누적 diff 를 하지 않는다', () => {
  const state = createClaudeParserState({ filePath: '/p/11111111-1111-4111-8111-111111111111.jsonl' });
  const first = parseClaudeTranscriptLine(JSON.stringify(assistant()), state);
  const second = parseClaudeTranscriptLine(JSON.stringify(assistant({
    uuid: 'aaaaaaaa-0000-4000-8000-000000000002',
    requestId: 'req_test_2',
    message: { ...assistant().message, id: 'msg_test_2' },
  })), state);

  const [event] = first;
  assert.equal(event.type, 'usage');
  assert.equal(event.accounting, 'direct');
  assert.equal(event.parserVersion, CLAUDE_PARSER_VERSION);
  assert.deepEqual(event.delta, {
    inputTokens: 12,
    cachedInputTokens: 90000,
    cacheWriteInputTokens: 4000,
    outputTokens: 500,
    reasoningTokens: 120,
    toolTokens: 0,
    totalTokens: 94512,
  });
  // 두 번째 레코드도 자기 값을 그대로 씁니다 — 앞 레코드를 빼지 않습니다.
  assert.equal(second[0].delta.totalTokens, 94512);
});

test('캐시 읽기는 input 밖이므로 min(input, cached) 로 깎지 않는다', () => {
  const usage = normalizeClaudeUsage({ input_tokens: 2, cache_read_input_tokens: 132077, cache_creation_input_tokens: 500, output_tokens: 10 });
  assert.equal(usage.cachedInputTokens, 132077);
  assert.equal(usage.inputTokens, 2);
  assert.equal(usage.totalTokens, 2 + 132077 + 500 + 10);
});

test('thinking_tokens 가 있으면 추론으로 매핑하고 output 안에 든 것으로 본다', () => {
  const { events } = parse(assistant({ usage: { output_tokens: 300, output_tokens_details: { thinking_tokens: 280 } } }));
  assert.equal(events[0].delta.reasoningTokens, 280);
  assert.equal(events[0].fieldQuality.reasoningTokens, 'local_exact');
  assert.equal(events[0].fieldQuality.outputTokens, 'local_exact');
  // 추론이 출력보다 클 수는 없습니다.
  const clamped = normalizeClaudeUsage({ output_tokens: 100, output_tokens_details: { thinking_tokens: 999 } });
  assert.equal(clamped.reasoningTokens, 100);
});

test('thinking_tokens 가 없는 옛 버전 로그는 output 을 추정으로, 추론을 미제공으로 남긴다', () => {
  const record = assistant({ version: '2.1.220' });
  delete record.message.usage.output_tokens_details;
  const { events } = parse(record);
  const [event] = events;
  assert.equal(event.delta.reasoningTokens, 0);
  assert.equal(event.fieldQuality.outputTokens, 'partial');
  // 키 자체가 없는 것이 "0 토큰"과 "측정 불가"를 구분하는 방법입니다(R7).
  assert.ok(!('reasoningTokens' in event.fieldQuality));
  assert.equal(event.measurementQuality, 'partial');
});

test('버전을 모르는 로그는 input 을 미확인으로 남긴다', () => {
  const record = assistant();
  delete record.version;
  const { events } = parse(record);
  assert.equal(events[0].fieldQuality.inputTokens, 'unverified');
  assert.equal(events[0].measurementQuality, 'unverified');
  assert.equal(compareCliVersion('2.1.228', '2.1.9'), 1);
  assert.equal(compareCliVersion('2.1.143', '2.1.143'), 0);
  assert.equal(compareCliVersion('2.1.100', '2.1.143'), -1);
  assert.equal(compareCliVersion(null, '2.1.143'), null);
});

test('캐시 쓰기 상위 필드와 TTL 내역이 어긋나면 더 완전한 쪽을 쓰고 partial 로 내린다', () => {
  const { events, state } = parse(assistant({
    usage: {
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1312 },
    },
  }));
  const [event] = events;
  assert.equal(event.delta.cacheWriteInputTokens, 1312);
  assert.equal(event.fieldQuality.cacheWriteInputTokens, 'partial');
  assert.equal(event.discrepancies.reportedCacheWriteTokens, 0);
  assert.equal(event.discrepancies.breakdownCacheWriteTokens, 1312);
  assert.equal(state.stats.cacheWriteDiscrepancies, 1);
});

test('iterations 합이 상위 usage 보다 크면 불일치로 표시한다', () => {
  const { events, state } = parse(assistant({
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: 132077,
      output_tokens: 1235,
      iterations: [
        { input_tokens: 2, output_tokens: 238, cache_read_input_tokens: 179818, cache_creation_input_tokens: 0 },
        { input_tokens: 2, output_tokens: 1235, cache_read_input_tokens: 132077, cache_creation_input_tokens: 0 },
      ],
    },
  }));
  const [event] = events;
  // 상위 값을 조용히 키우지 않습니다 — 마지막 iteration 값이 그대로 남습니다.
  assert.equal(event.delta.outputTokens, 1235);
  assert.equal(event.delta.cachedInputTokens, 132077);
  assert.equal(event.discrepancies.iterationCount, 2);
  assert.ok(event.discrepancies.iterationsTotalTokens > event.delta.totalTokens);
  assert.equal(event.fieldQuality.outputTokens, 'partial');
  assert.equal(state.stats.iterationDiscrepancies, 1);
});

test('중복 제거 키는 파일이 아니라 요청을 가리킨다', () => {
  const key = claudeEventKey({ message: { id: 'msg_a' }, requestId: 'req_a' });
  assert.equal(key, 'claude|msg_a|req_a');
  // requestId 가 없어도 message.id 로 묶입니다(실측 11건).
  assert.equal(claudeEventKey({ message: { id: 'msg_a' } }), 'claude|msg_a|');
  // 안정적인 id 가 없으면 레코드 uuid 로 떨어져 서로 다른 요청이 합쳐지지 않습니다.
  assert.equal(claudeEventKey({ uuid: 'u-1' }), 'claude|uuid:u-1');
  assert.equal(claudeEventKey({}), null);
});

test('같은 요청의 content block 분할 레코드는 같은 키를 갖고 뒤 레코드가 최종값이다', () => {
  const state = createClaudeParserState({ filePath: '/p/session.jsonl' });
  const streaming = parseClaudeTranscriptLine(JSON.stringify(assistant({
    message: { ...assistant().message, content: [{ type: 'thinking', thinking: 'SENTINEL' }], stop_reason: null, usage: { ...assistant().message.usage, output_tokens: 5 } },
  })), state);
  const final = parseClaudeTranscriptLine(JSON.stringify(assistant({
    uuid: 'aaaaaaaa-0000-4000-8000-000000000009',
    message: { ...assistant().message, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' },
  })), state);
  assert.equal(streaming[0].eventKey, final[0].eventKey);
  assert.ok(final[0].delta.outputTokens > streaming[0].delta.outputTokens);
});

test('assistant 가 아닌 레코드와 부모의 toolUseResult 롤업은 토큰을 만들지 않는다', () => {
  const state = createClaudeParserState({ filePath: '/p/session.jsonl' });
  const rollup = {
    type: 'user',
    toolUseResult: {
      status: 'completed',
      prompt: 'SENTINEL-PROMPT',
      agentId: 'a1',
      totalTokens: 105288,
      usage: { input_tokens: 2, cache_creation_input_tokens: 399, cache_read_input_tokens: 102797, output_tokens: 2089 },
    },
  };
  assert.deepEqual(parseClaudeTranscriptLine(JSON.stringify(rollup), state), []);
  assert.deepEqual(parseClaudeTranscriptLine(JSON.stringify({ type: 'attachment', content: 'SENTINEL' }), state), []);
  assert.deepEqual(parseClaudeTranscriptLine(JSON.stringify({ type: 'last-prompt', prompt: 'SENTINEL' }), state), []);
});

test('합성 오류 레코드와 토큰이 전혀 없는 레코드는 사용량이 되지 않는다', () => {
  const state = createClaudeParserState({ filePath: '/p/session.jsonl' });
  const synthetic = assistant({
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: { ...assistant().message, model: '<synthetic>', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
  });
  const syntheticEvents = parseClaudeTranscriptLine(JSON.stringify(synthetic), state);
  assert.ok(!syntheticEvents.some((event) => event.type === 'usage'));
  assert.equal(state.stats.syntheticRecords, 1);

  const empty = assistant({
    message: {
      ...assistant().message,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, cache_creation: {} },
    },
  });
  const emptyEvents = parseClaudeTranscriptLine(JSON.stringify(empty), state);
  assert.ok(!emptyEvents.some((event) => event.type === 'usage'));
  assert.equal(state.stats.emptyUsageRecords, 1);
});

test('깨진 줄과 빈 줄은 파싱을 멈추지 않는다', () => {
  const state = createClaudeParserState({ filePath: '/p/session.jsonl' });
  assert.deepEqual(parseClaudeTranscriptLine('{"type":"assistant"', state), [{ type: 'parse_error', reason: 'invalid_json' }]);
  assert.deepEqual(parseClaudeTranscriptLine('', state), []);
  assert.deepEqual(parseClaudeTranscriptLine('   ', state), []);
  // usage 없는 assistant 레코드도 조용히 넘깁니다.
  assert.deepEqual(parseClaudeTranscriptLine(JSON.stringify({ type: 'assistant', message: { id: 'm' } }), state), []);
});

test('프로젝트 귀속은 cwd 우선, 없으면 디렉터리 이름을 그대로 쓴다', () => {
  assert.equal(claudeProjectName(CWD, 'C--Users-dev-git-node-sample-app'), 'sample-app');
  assert.equal(claudeProjectName('/home/dev/work/tracker', 'x'), 'tracker');
  assert.equal(claudeProjectName(null, 'C--Users-Public-Documents----2026'), 'C--Users-Public-Documents----2026');
  assert.equal(claudeProjectName(null, null), 'unknown-project');
});

test('서브에이전트 파일의 세션 id 는 부모 세션이다', () => {
  const parent = '46bba84b-e544-4a3f-9e8c-12490813fc85';
  assert.equal(claudeSessionIdFromPath(`/root/proj/${parent}/subagents/agent-a71f331dd.jsonl`), parent);
  assert.equal(claudeSessionIdFromPath(`/root/proj/${parent}.jsonl`), parent);
  // subagents 디렉터리가 없는 낯선 레이아웃이면 파일 이름으로 떨어집니다.
  assert.equal(claudeSessionIdFromPath('/root/agent-orphan.jsonl'), 'agent-orphan');
});

test('숫자로 쓰이는 필드가 문자열/음수여도 무너지지 않는다', () => {
  const usage = normalizeClaudeUsage({ input_tokens: '15', cache_read_input_tokens: -5, output_tokens: null, cache_creation_input_tokens: undefined });
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.cachedInputTokens, 0);
  assert.equal(usage.outputTokens, 0);
  assert.equal(usage.cacheWriteInputTokens, 0);
  assert.equal(usage.totalTokens, 15);
});
