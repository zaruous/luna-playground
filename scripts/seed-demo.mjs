#!/usr/bin/env node
// 데모용 합성 Codex rollout 로그 생성기.
//
// 실측 데이터가 아닙니다. 화면 작업과 시계열 검증을 위해 재현 가능한 표본을
// 만드는 용도이며, 기본적으로 사용자의 실제 ~/.codex 를 건드리지 않도록
// 저장소 안의 격리된 디렉터리에 씁니다.
//
//   node scripts/seed-demo.mjs                 # .demo/codex 에 생성
//   node scripts/seed-demo.mjs --days 20       # 기간 조정
//   node scripts/seed-demo.mjs --out /tmp/cdx  # 위치 지정
//
// 생성 후 안내되는 CODEX_HOME/NYANG_USER_DATA 환경변수와 함께 서버를 띄우면
// 실제 수집기가 이 로그를 읽어 화면에 표시합니다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { days: 12, out: path.join(rootDir, '.demo', 'codex'), reset: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--days') args.days = Math.max(1, Number(argv[++index]) || 12);
    else if (flag === '--out') args.out = path.resolve(argv[++index]);
    else if (flag === '--clean') args.reset = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
  }
  return args;
}

// 재현 가능한 표본을 위해 시드 고정 LCG를 씁니다 (Math.random 미사용).
function createRandom(seed = 20260820) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PROJECTS = [
  { name: 'luna-playground', cwd: '/repo/luna-playground', weight: 0.42, models: ['gpt-5-codex', 'gpt-5', 'o4-mini'] },
  { name: 'mes-portal', cwd: '/repo/mes-portal', weight: 0.27, models: ['gpt-5-codex', 'gpt-5'] },
  { name: 'nyang-docs', cwd: '/repo/nyang-docs', weight: 0.19, models: ['gpt-5', 'o4-mini'] },
  { name: 'agent-lab', cwd: '/repo/agent-lab', weight: 0.12, models: ['gpt-5-codex'] },
];

function uuidFrom(random) {
  const hex = '0123456789abcdef';
  let out = '';
  for (let index = 0; index < 32; index += 1) out += hex[Math.floor(random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-8${out.slice(17, 20)}-${out.slice(20, 32)}`;
}

function isoAt(date) {
  return new Date(date).toISOString();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('사용법: node scripts/seed-demo.mjs [--days N] [--out DIR] [--clean]');
    return;
  }

  const random = createRandom();
  const sessionsRoot = path.join(args.out, 'sessions');
  if (args.reset) fs.rmSync(args.out, { recursive: true, force: true });

  const now = Date.now();
  const dayMs = 86_400_000;
  let files = 0;
  let events = 0;
  // 한도는 주간 창이 서서히 차오르고 5시간 창은 주기적으로 리셋되는 모양으로 만듭니다.
  let weeklyPercent = 8;

  for (let dayOffset = args.days - 1; dayOffset >= 0; dayOffset -= 1) {
    const dayStart = now - dayOffset * dayMs;
    const day = new Date(dayStart);
    const dir = path.join(
      sessionsRoot,
      String(day.getUTCFullYear()),
      String(day.getUTCMonth() + 1).padStart(2, '0'),
      String(day.getUTCDate()).padStart(2, '0'),
    );
    fs.mkdirSync(dir, { recursive: true });

    const sessionsToday = 1 + Math.floor(random() * 3);
    for (let sessionIndex = 0; sessionIndex < sessionsToday; sessionIndex += 1) {
      const pick = random();
      let acc = 0;
      const project = PROJECTS.find((candidate) => (acc += candidate.weight) >= pick) ?? PROJECTS[0];
      const model = project.models[Math.floor(random() * project.models.length)];
      const sessionId = uuidFrom(random);
      // 하루 안에서 시각을 흩뿌려 시간 버킷도 비어 보이지 않게 합니다.
      const sessionStart = dayStart - Math.floor(random() * 10) * 3_600_000;

      const lines = [
        JSON.stringify({ timestamp: isoAt(sessionStart), type: 'session_meta', payload: { id: sessionId, cwd: project.cwd } }),
        JSON.stringify({ timestamp: isoAt(sessionStart + 1000), type: 'turn_context', payload: { cwd: project.cwd, model } }),
      ];

      const turns = 2 + Math.floor(random() * 4);
      const cumulative = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
      let fiveHourPercent = 4 + random() * 20;

      for (let turn = 0; turn < turns; turn += 1) {
        // 캐시 적중이 지배적인 실제 코딩 세션 형태를 흉내냅니다.
        const input = Math.round((90_000 + random() * 520_000) * (project.weight + 0.6));
        const cached = Math.round(input * (0.82 + random() * 0.14));
        const cacheWrite = Math.round(input * (0.02 + random() * 0.05));
        const output = Math.round(2_400 + random() * 16_000);
        const reasoning = Math.round(output * (0.3 + random() * 0.5));

        cumulative.input += input;
        cumulative.cached += cached;
        cumulative.cacheWrite += cacheWrite;
        cumulative.output += output;
        cumulative.reasoning += reasoning;

        const total = cumulative.input + cumulative.output;
        const timestamp = isoAt(sessionStart + 2000 + turn * (120_000 + Math.floor(random() * 900_000)));
        fiveHourPercent = Math.min(97, fiveHourPercent + random() * 9);
        weeklyPercent = Math.min(99, weeklyPercent + random() * 1.4);

        lines.push(JSON.stringify({
          timestamp,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: cumulative.input,
                cached_input_tokens: cumulative.cached,
                cache_write_input_tokens: cumulative.cacheWrite,
                output_tokens: cumulative.output,
                reasoning_output_tokens: cumulative.reasoning,
                total_tokens: total,
              },
              last_token_usage: {
                input_tokens: input,
                cached_input_tokens: cached,
                cache_write_input_tokens: cacheWrite,
                output_tokens: output,
                reasoning_output_tokens: reasoning,
                total_tokens: input + output,
              },
            },
            rate_limits: {
              primary: { used_percent: Number(fiveHourPercent.toFixed(1)), window_minutes: 300, resets_at: Math.floor((sessionStart + 5 * 3_600_000) / 1000) },
              secondary: { used_percent: Number(weeklyPercent.toFixed(1)), window_minutes: 10080, resets_at: Math.floor((now + 3 * dayMs) / 1000) },
            },
          },
        }));
        events += 1;
      }

      fs.writeFileSync(path.join(dir, `rollout-${sessionId}.jsonl`), `${lines.join('\n')}\n`);
      files += 1;
    }
  }

  const dataDir = path.join(path.dirname(args.out), 'user-data');
  console.log(`합성 데모 로그 생성 완료 — 실측 데이터가 아닙니다.`);
  console.log(`  세션 파일 ${files}개 · token_count 이벤트 ${events}개 · ${args.days}일치`);
  console.log(`  위치: ${sessionsRoot}`);
  console.log('');
  console.log('이 데이터로 서버를 띄우려면:');
  console.log(`  CODEX_HOME=${args.out} NYANG_USER_DATA=${dataDir} npm run start:web`);
}

main();
