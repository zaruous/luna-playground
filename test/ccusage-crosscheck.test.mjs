// ccusage 교차 검증.
//
// ccusage(https://github.com/ccusage/ccusage)는 같은 Codex rollout 로그를
// 읽는 독립 구현입니다. 우리는 ccusage를 의존성으로 쓰지 않지만, 같은 입력에
// 대해 두 구현이 무엇에 합의하고 어디서 의도적으로 갈라지는지 고정해두면
// 파서가 조용히 틀어지는 것을 잡을 수 있습니다.
//
// 실행하려면 ccusage 가 필요합니다(선택):
//   npm i -D ccusage && npm test
// 설치돼 있지 않으면 이 파일은 통째로 skip 됩니다 — 필수 의존성이 아닙니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { UsageStore } from '../service/store.mjs';
import { CodexCollector } from '../service/providers/codex/collector.mjs';

const require = createRequire(import.meta.url);

// ccusage 는 플랫폼별 네이티브 바이너리를 optionalDependencies 로 받습니다.
// 지원 목록에 없는 환경(예: musl 기반 Alpine, 그 밖의 arch)에서는 cli.js 는
// 있지만 실행 바이너리가 없어 spawn 이 실패합니다. 그러면 "환경에 없음"이
// 테스트 실패로 보이므로, 실패시키지 않고 skip 하도록 미리 확인합니다.
function findCcusageCli() {
  try {
    const pkgPath = require.resolve('ccusage/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.ccusage;
    if (!bin) return null;
    const cli = path.join(path.dirname(pkgPath), bin);
    if (!fs.existsSync(cli)) return null;
    // 이 플랫폼용 네이티브 패키지가 실제로 설치됐는지 확인합니다.
    const natives = Object.keys(pkg.optionalDependencies ?? {});
    if (natives.length && !natives.some((name) => {
      try { require.resolve(`${name}/package.json`); return true; } catch { return false; }
    })) return null;
    return cli;
  } catch {
    return null;
  }
}

const ccusageCli = findCcusageCli();
const skip = ccusageCli ? false : 'ccusage 또는 이 플랫폼용 네이티브 바이너리 미설치 — npm i -D ccusage 후 실행하세요';

// 결정적인 rollout 픽스처. 누적 스냅샷과 턴 증분을 함께 담아 두 구현이
// 같은 증분 규칙을 쓰는지 확인합니다.
function writeFixture(codexHome, day) {
  const dir = path.join(codexHome, 'sessions', '2026', '08', day);
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = `9${day}0000-0000-4000-8000-00000000000${day[1]}`;
  const turns = [
    { input: 120_000, cached: 100_000, cacheWrite: 4_000, output: 6_000, reasoning: 2_500 },
    { input: 260_000, cached: 232_000, cacheWrite: 9_000, output: 11_000, reasoning: 4_800 },
    { input: 410_000, cached: 372_000, cacheWrite: 12_500, output: 15_500, reasoning: 6_100 },
  ];
  const lines = [
    JSON.stringify({ timestamp: `2026-08-${day}T02:00:00.000Z`, type: 'session_meta', payload: { id: sessionId, cwd: '/repo/crosscheck' } }),
    JSON.stringify({ timestamp: `2026-08-${day}T02:00:01.000Z`, type: 'turn_context', payload: { cwd: '/repo/crosscheck', model: 'gpt-5-codex' } }),
  ];
  turns.forEach((turn, index) => {
    lines.push(JSON.stringify({
      timestamp: `2026-08-${day}T0${2 + index}:10:00.000Z`,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: turn.input,
            cached_input_tokens: turn.cached,
            cache_write_input_tokens: turn.cacheWrite,
            output_tokens: turn.output,
            reasoning_output_tokens: turn.reasoning,
            total_tokens: turn.input + turn.output,
          },
        },
      },
    }));
  });
  fs.writeFileSync(path.join(dir, `rollout-${sessionId}.jsonl`), `${lines.join('\n')}\n`);
  return turns[turns.length - 1];
}

test('ccusage 와 같은 Codex 로그를 읽어 총합·출력·추론·캐시읽기가 일치한다', { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-cc-'));
  const codexHome = path.join(root, '.codex');
  const store = new UsageStore(path.join(root, 'usage.sqlite3'));
  const collector = new CodexCollector({ store, codexHome });

  try {
    const last = writeFixture(codexHome, '11');
    await collector.reconcile('test:crosscheck');

    const raw = execFileSync(process.execPath, [ccusageCli, 'codex', 'daily', '--json', '--offline', '--no-cost'], {
      env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    const daily = JSON.parse(raw).daily ?? [];
    assert.ok(daily.length > 0, 'ccusage 가 픽스처를 읽지 못했습니다');

    const theirs = daily.reduce((acc, day) => ({
      inputTokens: acc.inputTokens + day.inputTokens,
      cacheReadTokens: acc.cacheReadTokens + day.cacheReadTokens,
      outputTokens: acc.outputTokens + day.outputTokens,
      reasoningOutputTokens: acc.reasoningOutputTokens + day.reasoningOutputTokens,
      totalTokens: acc.totalTokens + day.totalTokens,
    }), { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
    const ours = store.getProviderTotals('codex');

    // 합의하는 것: 두 구현이 같은 누적 diff 규칙과 같은 총합에 도달합니다.
    assert.equal(ours.totalTokens, theirs.totalTokens, '총 토큰이 다릅니다');
    assert.equal(ours.outputTokens, theirs.outputTokens, '출력 토큰이 다릅니다');
    assert.equal(ours.reasoningTokens, theirs.reasoningOutputTokens, '추론 토큰이 다릅니다');
    assert.equal(ours.cachedInputTokens, theirs.cacheReadTokens, '캐시 읽기 토큰이 다릅니다');
    assert.equal(ours.totalTokens, last.input + last.output, '누적 카운터 diff 결과가 최종 누적값과 달라야 합니다');

    // 의도적으로 갈라지는 것: 우리는 로그 원본대로 캐시를 포함한 input 을
    // 저장하고, ccusage 는 캐시를 뺀 값을 input 으로 보고합니다. 같은 값을
    // 다르게 쪼갠 것이므로 이 항등식이 성립해야 합니다.
    assert.equal(
      ours.inputTokens,
      theirs.inputTokens + theirs.cacheReadTokens,
      'input 분해 관계가 깨졌습니다 — 어느 한쪽의 캐시 회계가 바뀐 것입니다',
    );
  } finally {
    collector.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
