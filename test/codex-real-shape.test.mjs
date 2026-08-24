// 실제 Codex rollout 로그(cli 0.146.0)에서 확인한 구조에 대한 회귀 테스트.
//
// 사용자가 제공한 실제 로그의 **모양만** 옮겼습니다. 프롬프트·응답 본문과
// 실제 작업 경로는 담지 않습니다. 여기서 고정하는 것은 합성 픽스처로는
// 드러나지 않았던 네 가지입니다:
//   1. rate_limits.primary 가 주간 창(10080)이고 secondary 가 null 일 수 있다
//   2. cache_write_input_tokens 필드는 실재하며 0 일 수 있다
//   3. credits / plan_type / individual_limit 등 신규 필드가 섞여 들어온다
//   4. cwd 가 Windows 경로일 수 있다 (POSIX 호스트에서 읽는 경우 포함)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../service/store.mjs';
import { CodexCollector } from '../service/providers/codex/collector.mjs';
import { projectNameFromCwd } from '../service/utils.mjs';

const SESSION_ID = '01a01746-93f2-7861-998c-3034ac03f36f';
const WINDOWS_CWD = 'C:\\Users\\dev\\git\\node\\sample-app';

function writeRealShapeLog(codexHome) {
  const dir = path.join(codexHome, 'sessions', '2026', '08', '19');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { timestamp: '2026-08-18T23:48:23.000Z', type: 'session_meta', payload: { session_id: SESSION_ID, id: SESSION_ID, timestamp: '2026-08-18T23:48:23.000Z', cwd: WINDOWS_CWD, originator: 'codex-tui', cli_version: '0.146.0', source: 'tui', context_window: 258400 } },
    { timestamp: '2026-08-18T23:48:24.000Z', type: 'world_state', payload: { full: true, state: {} } },
    { timestamp: '2026-08-18T23:48:25.000Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: WINDOWS_CWD, workspace_roots: [WINDOWS_CWD], model: 'gpt-5.6-sol', effort: 'high', timezone: 'Asia/Seoul' } },
    {
      timestamp: '2026-08-18T23:49:12.485Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 19703, cached_input_tokens: 6912, cache_write_input_tokens: 0, output_tokens: 71, reasoning_output_tokens: 34, total_tokens: 19774 },
          last_token_usage: { input_tokens: 19703, cached_input_tokens: 6912, cache_write_input_tokens: 0, output_tokens: 71, reasoning_output_tokens: 34, total_tokens: 19774 },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: 'codex',
          limit_name: null,
          primary: { used_percent: 49, window_minutes: 10080, resets_at: 1787549765 },
          secondary: null,
          credits: { has_credits: false, unlimited: false, balance: null },
          individual_limit: null,
          spend_control_reached: null,
          plan_type: 'team',
          rate_limit_reached_type: null,
        },
      },
    },
  ];
  fs.writeFileSync(
    path.join(dir, `rollout-2026-08-19T08-48-23-${SESSION_ID}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
}

test('실제 rollout 구조를 읽고 토큰 회계 항등식이 성립한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-real-'));
  const codexHome = path.join(root, '.codex');
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new CodexCollector({ store, codexHome });

  try {
    writeRealShapeLog(codexHome);
    await collector.reconcile('test:real-shape');

    const totals = store.getProviderTotals('codex');
    assert.equal(totals.totalTokens, 19774);
    assert.equal(totals.inputTokens, 19703);
    assert.equal(totals.cachedInputTokens, 6912);
    assert.equal(totals.cacheWriteInputTokens, 0, 'cache_write 는 실재하는 필드이고 0 일 수 있습니다');
    assert.equal(totals.outputTokens, 71);
    assert.equal(totals.reasoningTokens, 34);
    assert.equal(totals.eventCount, 1);

    // 화면의 누적 막대 분해가 기대는 항등식 (실제 로그로 확인됨)
    assert.equal(totals.inputTokens + totals.outputTokens, totals.totalTokens);
    assert.ok(totals.cachedInputTokens <= totals.inputTokens);
    assert.ok(totals.reasoningTokens <= totals.outputTokens);
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('primary 가 주간 창이고 secondary 가 없어도 창 길이로 라벨을 정한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-real-q-'));
  const codexHome = path.join(root, '.codex');
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new CodexCollector({ store, codexHome });

  try {
    writeRealShapeLog(codexHome);
    await collector.reconcile('test:real-quota');

    const limits = store.getLatestRateLimits('codex').limits;
    assert.equal(limits.length, 1);
    const windows = Object.values(limits[0].windows);
    assert.equal(windows.length, 1, 'secondary 가 null 이면 창이 하나만 저장돼야 합니다');

    const [only] = windows;
    // primary 는 전송 레인 이름일 뿐이라 5시간 창이라고 단정하면 안 됩니다.
    assert.equal(only.windowType, 'primary');
    assert.equal(only.windowMinutes, 10080, 'primary 가 주간 창인 실제 사례');
    assert.equal(only.usedPercent, 49);

    // 백분율이 토큰 원장에 새지 않았는지 (R5)
    const totals = store.getProviderTotals('codex');
    assert.equal(totals.totalTokens, 19774);
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows cwd 를 POSIX 호스트에서 읽어도 프로젝트명이 마지막 구간이 된다', async () => {
  // 로그를 쓴 기계와 읽는 기계의 OS 가 다를 수 있습니다 (WSL 등).
  assert.equal(projectNameFromCwd(WINDOWS_CWD), 'sample-app');
  assert.equal(projectNameFromCwd('/repo/luna-playground'), 'luna-playground');
  assert.equal(projectNameFromCwd('C:/Users/dev/git/x'), 'x');
  assert.equal(projectNameFromCwd('/repo/trailing/'), 'trailing');
  assert.equal(projectNameFromCwd(null), 'unknown-project');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-real-p-'));
  const codexHome = path.join(root, '.codex');
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new CodexCollector({ store, codexHome });
  try {
    writeRealShapeLog(codexHome);
    await collector.reconcile('test:real-project');
    const [project] = store.getRecentProjects('codex');
    assert.equal(project.name, 'sample-app', '전체 경로가 아니라 마지막 구간이어야 합니다');
    assert.equal(project.model, 'gpt-5.6-sol');
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
