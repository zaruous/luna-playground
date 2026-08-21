// 실제 Claude Code transcript(2.1.143~2.1.232)에서 확인한 구조에 대한 회귀 테스트.
//
// 이 기계의 실제 로그 214 파일 / assistant 레코드 30,777건을 훑어 확인한
// **모양만** 옮겼습니다. 프롬프트·응답 본문과 실제 작업 경로는 담지 않습니다.
// 합성 픽스처로는 드러나지 않았던 것들을 여기서 고정합니다:
//
//   1. usage 에 output_tokens_details.thinking_tokens 가 있다 (2.1.228 이상)
//   2. usage.iterations[] 가 있고, 상위 usage 는 그 합이 아니라 **마지막 항목**과
//      같다 — 즉 다중 iteration 요청에서 상위 값은 앞선 호출을 빠뜨린다
//   3. cache_creation_input_tokens 가 0 인데 cache_creation.ephemeral_* 는 0 이
//      아닌 레코드가 있다
//   4. input_tokens 가 2 인 것은 플레이스홀더가 아니라 "프롬프트를 캐시가 거의
//      다 흡수한 정상 상태"다 — 조사 문서의 75% 플레이스홀더 주장은 이 범위에서
//      재현되지 않는다
//   5. server_tool_use / service_tier / speed / inference_geo / effort /
//      attributionAgent / slug / teamName 등 우리가 쓰지 않는 필드가 섞여 온다
//   6. cwd 는 Windows 경로일 수 있다
//   7. model 이 '<synthetic>' 인 오류 자리표시자가 섞여 온다

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../service/store.mjs';
import { ClaudeCollector } from '../service/providers/claude/collector.mjs';
import {
  INPUT_VALIDATED_MIN_VERSION,
  THINKING_DETAIL_MIN_VERSION,
  createClaudeParserState,
  parseClaudeTranscriptLine,
} from '../service/providers/claude/parser.mjs';
import { projectNameFromCwd } from '../service/utils.mjs';

const SESSION_ID = 'ef059b7b-0000-4000-8000-000000000001';
const WINDOWS_CWD = 'C:\\Users\\dev\\git\\node\\real-shape';
const PROJECT_DIR = 'C--Users-dev-git-node-real-shape';

// 실제 레코드의 필드 구성을 그대로 옮긴 usage 객체(값만 교체).
function realUsage({ input, cacheRead, cacheWrite, output, thinking, iterations = null, ephemeral = null }) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    ...(thinking == null ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: ephemeral ?? { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 },
    inference_geo: 'not_available',
    iterations: iterations ?? [{
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
      cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 },
      type: 'message',
    }],
    speed: 'standard',
  };
}

function realRecord({ messageId, requestId, usage, version = '2.1.232', block = 'text', timestamp, model = 'claude-opus-5', extra = {} }) {
  return {
    parentUuid: '00000000-0000-4000-8000-00000000aaaa',
    isSidechain: false,
    message: {
      model,
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [{ type: block, text: 'x' }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      stop_details: null,
      usage,
      diagnostics: {},
    },
    requestId,
    type: 'assistant',
    uuid: `${messageId}-${block}`,
    timestamp,
    effort: 'high',
    session_id: SESSION_ID,
    userType: 'external',
    entrypoint: 'cli',
    cwd: WINDOWS_CWD,
    sessionId: SESSION_ID,
    version,
    gitBranch: 'main',
    ...extra,
  };
}

test('실제 필드 구성을 그대로 넣어도 토큰 7필드로 정규화된다', () => {
  const state = createClaudeParserState({ filePath: `/root/${PROJECT_DIR}/${SESSION_ID}.jsonl`, projectsRoot: '/root' });
  const [event] = parseClaudeTranscriptLine(JSON.stringify(realRecord({
    messageId: 'msg_real_1',
    requestId: 'req_real_1',
    timestamp: '2026-08-14T01:37:28.543Z',
    // 실제 값 형태: 비캐시 입력이 2 이고 캐시 읽기가 13만입니다.
    usage: realUsage({ input: 2, cacheRead: 132_077, cacheWrite: 4_540, output: 1_235, thinking: 412 }),
    extra: { slug: 'virtual-growing-crab', attributionAgent: 'Explore', teamName: 'team-a', agentName: 'agent-a' },
  })), state);

  assert.equal(event.type, 'usage');
  assert.deepEqual(event.delta, {
    inputTokens: 2,
    cachedInputTokens: 132_077,
    cacheWriteInputTokens: 4_540,
    outputTokens: 1_235,
    reasoningTokens: 412,
    toolTokens: 0,
    totalTokens: 2 + 132_077 + 4_540 + 1_235,
  });
  // input 이 2 라는 것은 플레이스홀더가 아니라 캐시가 프롬프트를 거의 다
  // 흡수한 정상 상태입니다 — 신뢰도를 깎지 않습니다.
  assert.equal(event.fieldQuality.inputTokens, 'local_exact');
  assert.equal(event.measurementQuality, 'local_exact');
  assert.equal(event.requestId, 'req_real_1');
  assert.equal(event.session.cliVersion, '2.1.232');
  assert.equal(event.session.gitBranch, 'main');
  assert.equal(event.session.source, 'cli');
  // Windows 경로에서 프로젝트 이름을 뽑습니다(호스트 OS 와 무관).
  assert.equal(event.session.projectName, projectNameFromCwd(WINDOWS_CWD));
  assert.equal(event.session.projectName, 'real-shape');
});

test('thinking_tokens 등장 경계가 버전 게이트와 일치한다', () => {
  const state = createClaudeParserState({ filePath: '/root/p/s.jsonl' });
  const withDetail = parseClaudeTranscriptLine(JSON.stringify(realRecord({
    messageId: 'msg_new', requestId: 'req_new', version: THINKING_DETAIL_MIN_VERSION,
    timestamp: '2026-08-01T00:00:00.000Z',
    usage: realUsage({ input: 10, cacheRead: 1_000, cacheWrite: 100, output: 500, thinking: 200 }),
  })), state)[0];
  assert.equal(withDetail.delta.reasoningTokens, 200);
  assert.equal(withDetail.fieldQuality.reasoningTokens, 'local_exact');

  // 2.1.227 이하 로그에는 output_tokens_details 가 아예 없습니다(실측 0건).
  const withoutDetail = parseClaudeTranscriptLine(JSON.stringify(realRecord({
    messageId: 'msg_old', requestId: 'req_old', version: '2.1.227',
    timestamp: '2026-07-01T00:00:00.000Z',
    usage: realUsage({ input: 10, cacheRead: 1_000, cacheWrite: 100, output: 500, thinking: null }),
  })), state)[0];
  assert.equal(withoutDetail.delta.reasoningTokens, 0);
  assert.ok(!('reasoningTokens' in withoutDetail.fieldQuality));
  assert.equal(withoutDetail.fieldQuality.outputTokens, 'partial');
  // input 은 검증된 하한 이상이면 여전히 로컬 관측입니다.
  assert.equal(withoutDetail.fieldQuality.inputTokens, 'local_exact');

  const belowFloor = parseClaudeTranscriptLine(JSON.stringify(realRecord({
    messageId: 'msg_ancient', requestId: 'req_ancient', version: '2.1.100',
    timestamp: '2026-05-01T00:00:00.000Z',
    usage: realUsage({ input: 1, cacheRead: 1_000, cacheWrite: 100, output: 500, thinking: null }),
  })), state)[0];
  assert.equal(belowFloor.fieldQuality.inputTokens, 'unverified');
  assert.equal(INPUT_VALIDATED_MIN_VERSION, '2.1.143');
});

test('다중 iteration 레코드의 상위 usage 는 합이 아니라 마지막 항목이다', () => {
  const state = createClaudeParserState({ filePath: '/root/p/s.jsonl' });
  // 실측 값 형태: iteration 2개, 상위 output 1235 == 마지막 iteration,
  // 두 iteration 의 합은 1473 입니다.
  const usage = realUsage({
    input: 2, cacheRead: 132_077, cacheWrite: 0, output: 1_235, thinking: 300,
    iterations: [
      { input_tokens: 2, output_tokens: 238, cache_read_input_tokens: 179_818, cache_creation_input_tokens: 0, type: 'message' },
      { input_tokens: 2, output_tokens: 1_235, cache_read_input_tokens: 132_077, cache_creation_input_tokens: 0, type: 'message' },
    ],
  });
  const [event] = parseClaudeTranscriptLine(JSON.stringify(realRecord({
    messageId: 'msg_iter', requestId: 'req_iter', timestamp: '2026-08-14T02:00:00.000Z', usage,
  })), state);

  assert.equal(event.delta.outputTokens, 1_235);
  assert.equal(event.delta.cachedInputTokens, 132_077);
  assert.equal(event.discrepancies.iterationCount, 2);
  // 앞선 iteration 이 빠진 것을 감지해 두어야 나중에 되짚을 수 있습니다.
  assert.ok(event.discrepancies.iterationsTotalTokens > event.delta.totalTokens);
  assert.equal(event.fieldQuality.outputTokens, 'partial');
  assert.equal(state.stats.iterationDiscrepancies, 1);
});

test('cache_creation_input_tokens 가 0 이어도 TTL 내역이 있으면 그 값을 쓴다', () => {
  const state = createClaudeParserState({ filePath: '/root/p/s.jsonl' });
  const [event] = parseClaudeTranscriptLine(JSON.stringify(realRecord({
    messageId: 'msg_ttl', requestId: 'req_ttl', timestamp: '2026-08-14T03:00:00.000Z',
    usage: realUsage({
      input: 2, cacheRead: 50_000, cacheWrite: 0, output: 100, thinking: 0,
      ephemeral: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_312 },
    }),
  })), state);
  assert.equal(event.delta.cacheWriteInputTokens, 1_312);
  assert.equal(event.fieldQuality.cacheWriteInputTokens, 'partial');
  assert.equal(state.stats.cacheWriteDiscrepancies, 1);
});

test('실제 파일 레이아웃 그대로 수집하면 요청 단위로 한 번씩만 계상된다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-claude-realshape-'));
  const claudeHome = path.join(root, '.claude');
  const projectDir = path.join(claudeHome, 'projects', PROJECT_DIR);
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new ClaudeCollector({ store, claudeHomes: [claudeHome] });
  try {
    fs.mkdirSync(projectDir, { recursive: true });
    const usage = realUsage({ input: 2, cacheRead: 132_077, cacheWrite: 4_540, output: 1_235, thinking: 412 });
    fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), [
      // 실측 모양: thinking → text → tool_use → tool_use 네 줄이 같은 message.id
      // 를 공유하고, 앞 줄이 스트리밍 중간값을 담습니다.
      JSON.stringify(realRecord({ messageId: 'msg_flow', requestId: 'req_flow', block: 'thinking', timestamp: '2026-08-14T01:37:28.543Z', usage: { ...usage, output_tokens: 8 } })),
      JSON.stringify(realRecord({ messageId: 'msg_flow', requestId: 'req_flow', block: 'text', timestamp: '2026-08-14T01:37:29.306Z', usage })),
      JSON.stringify(realRecord({ messageId: 'msg_flow', requestId: 'req_flow', block: 'tool_use', timestamp: '2026-08-14T01:37:30.718Z', usage })),
      // 오류 자리표시자: model 이 '<synthetic>' 이고 토큰이 전부 0 입니다.
      JSON.stringify(realRecord({
        messageId: 'msg_err', requestId: 'req_err', model: '<synthetic>', timestamp: '2026-08-14T01:38:00.000Z',
        usage: realUsage({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: null }),
        extra: { isApiErrorMessage: true, apiErrorStatus: 429 },
      })),
      '',
    ].join('\n'));

    await collector.reconcile('test:real-shape');

    const totals = store.getProviderTotals('claude');
    assert.equal(totals.eventCount, 1, '한 요청이 여러 행으로 들어갔거나 오류 레코드가 계상됐습니다');
    assert.equal(totals.outputTokens, 1_235);
    assert.equal(totals.reasoningTokens, 412);
    assert.equal(totals.totalTokens, 2 + 132_077 + 4_540 + 1_235);
    assert.equal(collector.getStatus().syntheticRecords, 1);
    assert.equal(store.getRecentProjects('claude')[0].name, 'real-shape');
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
