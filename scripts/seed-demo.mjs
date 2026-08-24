#!/usr/bin/env node
// 데모용 합성 Codex rollout 로그 생성기.
//
// 실측 데이터가 아닙니다. 화면 작업과 시계열 검증을 위해 재현 가능한 표본을
// 만드는 용도이며, 기본적으로 사용자의 실제 ~/.codex 를 건드리지 않도록
// 저장소 안의 격리된 디렉터리에 씁니다.
//
// 세션 탭(M8)은 event_msg/user_message 에서 턴 경계를, response_item 에서 도구
// 이름을 얻습니다. 그 레코드가 없으면 화면은 턴 '—', 단계 '도구 없음' 으로
// 남습니다 — 계층이 없는 정보를 지어내지 않기 때문입니다. 그래서 토큰 기록만이
// 아니라 턴·도구·컴팩션 레코드까지 함께 씁니다.
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

// Codex 로그에 도구 호출이 실제로 실리는 레코드 모양. 이름은
// service/providers/tool-phases.mjs 의 codex 표에서 그대로 옮겼습니다 — 표에
// 없는 이름을 지어내면 화면이 통째로 '기타'로 떨어집니다. arguments/명령
// 문자열은 쓰지 않습니다: 파서가 읽지 않는 데다, 그럴듯한 가짜 도구 입력을
// 디스크에 남기게 됩니다.
const TOOL_SEARCH = { type: 'tool_search_call' };
const APPLY_PATCH = { type: 'custom_tool_call', name: 'apply_patch' };
const SHELL_COMMAND = { type: 'function_call', name: 'shell_command' };
const EXEC = { type: 'function_call', name: 'exec' };
const LOCAL_SHELL = { type: 'local_shell_call' };
// 매핑표에 없는 이름도 하나 섞습니다. '기타'로 떨어지는 경로가 화면에
// 보여야 매핑이 비어 있는 provider 를 볼 때 놀라지 않습니다.
const UPDATE_PLAN = { type: 'function_call', name: 'update_plan' };

// 턴이 진행될수록 탐색 → 구현 → 검증 쪽으로 기울여, 단계 막대가 한 색으로
// 뭉치지 않게 합니다.
const TOOL_POOLS = Object.freeze([
  Object.freeze([TOOL_SEARCH, TOOL_SEARCH, TOOL_SEARCH, APPLY_PATCH, UPDATE_PLAN]),
  Object.freeze([APPLY_PATCH, APPLY_PATCH, TOOL_SEARCH, SHELL_COMMAND, EXEC]),
  Object.freeze([SHELL_COMMAND, EXEC, LOCAL_SHELL, APPLY_PATCH, UPDATE_PLAN]),
]);

function uuidFrom(random) {
  const hex = '0123456789abcdef';
  let out = '';
  for (let index = 0; index < 32; index += 1) out += hex[Math.floor(random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-8${out.slice(17, 20)}-${out.slice(20, 32)}`;
}

function isoAt(date) {
  return new Date(date).toISOString();
}

// 실제 Codex 는 rollout 을 세션이 '시작된' 날짜 디렉터리에 넣습니다. 그래서
// 날짜는 항상 세션 시작 순간에서 뽑습니다 — 기준일에서 뽑으면 자정을 넘겨
// 시작한 세션이 하루 뒤 폴더에 쌓입니다.
function dayDirFor(root, instant) {
  const day = new Date(instant);
  return path.join(
    root,
    String(day.getUTCFullYear()),
    String(day.getUTCMonth() + 1).padStart(2, '0'),
    String(day.getUTCDate()).padStart(2, '0'),
  );
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
  let turnBoundaries = 0;
  let toolCalls = 0;
  let compactedSessions = 0;
  let sessionSerial = 0;
  // 한도는 주간 창이 서서히 차오르고 5시간 창은 주기적으로 리셋되는 모양으로 만듭니다.
  let weeklyPercent = 8;

  for (let dayOffset = args.days - 1; dayOffset >= 0; dayOffset -= 1) {
    const dayStart = now - dayOffset * dayMs;

    const sessionsToday = 1 + Math.floor(random() * 3);
    for (let sessionIndex = 0; sessionIndex < sessionsToday; sessionIndex += 1) {
      const pick = random();
      let acc = 0;
      const project = PROJECTS.find((candidate) => (acc += candidate.weight) >= pick) ?? PROJECTS[0];
      const model = project.models[Math.floor(random() * project.models.length)];
      const sessionId = uuidFrom(random);
      const serial = sessionSerial++;
      // 하루 안에서 시각을 흩뿌려 시간 버킷도 비어 보이지 않게 합니다. 세션
      // 전체 길이(최대 2시간대)보다 넉넉히 뒤로 잡아야 dayOffset 0(=지금)에서도
      // 미래 시각 이벤트가 나오지 않습니다.
      const hoursBack = 3 + Math.floor(random() * 8);
      const sessionStart = dayStart - hoursBack * 3_600_000;
      // 디렉터리는 기준일이 아니라 이 세션의 시작 시각에서 뽑습니다. service/ 는
      // 경로의 날짜를 읽지 않지만, 실제 구조를 재현하는 게 이 스크립트의 일입니다.
      const dir = dayDirFor(sessionsRoot, sessionStart);
      fs.mkdirSync(dir, { recursive: true });

      const lines = [
        JSON.stringify({ timestamp: isoAt(sessionStart), type: 'session_meta', payload: { id: sessionId, cwd: project.cwd, timestamp: isoAt(sessionStart) } }),
        JSON.stringify({ timestamp: isoAt(sessionStart + 1000), type: 'turn_context', payload: { cwd: project.cwd, model } }),
      ];

      const turns = 3 + Math.floor(random() * 4);
      const cumulative = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
      let previousInput = 0;
      let fiveHourPercent = 4 + random() * 20;
      // 시각은 단조 증가 커서로만 만듭니다. 곡선과 컴팩션 세로선이 시간순
      // 정렬에 기대고 있어(store.getSessionFlow), 되감기면 표시가 엉뚱한 점에
      // 붙고 곡선이 지그재그로 보입니다.
      let cursor = sessionStart + 2_000;
      const tick = (minMs, spanMs) => { cursor += minMs + Math.floor(random() * spanMs); return isoAt(cursor); };

      // --days 1 로 돌려도 컴팩션 세션이 최소 하나는 나오게 0번은 항상 켭니다.
      const wantsCompaction = serial % 3 === 0;
      // 표시는 마커 **다음** user_message 에 붙습니다. 뒤에 프롬프트가 없는
      // 마커는 조용히 버려지므로, 마지막 턴의 프롬프트 바로 앞에 둡니다.
      const compactTurn = wantsCompaction ? turns - 1 : -1;
      // 도구를 하나도 안 쓴 턴을 일부러 하나 남깁니다. '도구 없음'은 빠진
      // 정보가 아니라 관측된 사실이고, 그 칸도 화면에 나와야 합니다.
      const quietTurn = Math.floor(random() * turns);
      if (wantsCompaction) compactedSessions += 1;

      for (let turn = 0; turn < turns; turn += 1) {
        if (turn === compactTurn) {
          lines.push(JSON.stringify({ timestamp: tick(1_000, 4_000), type: 'event_msg', payload: { type: 'context_compacted' } }));
        }
        // 턴 경계 = 사람 프롬프트. 본문(message)은 넣지 않습니다 — 파서가 읽지
        // 않고, 없는 대화를 지어내지 않으려는 것입니다.
        lines.push(JSON.stringify({ timestamp: tick(5_000, 60_000), type: 'event_msg', payload: { type: 'user_message' } }));
        turnBoundaries += 1;

        const pool = TOOL_POOLS[Math.min(TOOL_POOLS.length - 1, Math.floor((turn * TOOL_POOLS.length) / turns))];
        const requests = 1 + Math.floor(random() * 3);
        for (let request = 0; request < requests; request += 1) {
          // 도구 레코드는 반드시 그 요청의 token_count 앞에 둡니다. 파서는
          // 모아 둔 도구를 다음 token_count 에 붙이므로, 뒤에 두면 다음 턴의
          // 첫 요청으로 조용히 넘어갑니다.
          const callCount = turn === quietTurn ? 0 : 1 + Math.floor(random() * 3);
          for (let call = 0; call < callCount; call += 1) {
            lines.push(JSON.stringify({ timestamp: tick(2_000, 18_000), type: 'response_item', payload: pool[Math.floor(random() * pool.length)] }));
            toolCalls += 1;
          }

          // 컴팩션 직후 첫 요청은 프롬프트가 실제로 짧아집니다. 새로 뽑지 않고
          // 직전 요청을 기준으로 줄여야 곡선의 꺾임이 반드시 보입니다. 줄이는 건
          // last 쪽뿐 — 누적을 내려도 파서(codex/parser.mjs)는 이벤트를 버리지
          // 않고 reset:true 로 실어 보냅니다(cumulative_reset=1). 그러면 진단의
          // '누적 리셋' 칸이 컴팩션마다 올라가 진짜 파싱 이상과 구분되지 않고,
          // 감소 폭이 작으면 stale 회귀 가드에 걸려 그 이벤트만 통째로 사라집니다.
          const compacting = turn === compactTurn && request === 0;
          // 캐시 적중이 지배적인 실제 코딩 세션 형태를 흉내냅니다.
          const input = compacting
            ? Math.round(previousInput * (0.22 + random() * 0.16))
            : Math.round((90_000 + random() * 520_000) * (project.weight + 0.6));
          previousInput = input;
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
          const timestamp = tick(45_000, 255_000);
          // 요청 수가 턴당 여러 개로 늘었으니 증가폭을 낮춰, 예전과 비슷한
          // 기울기로 차오르게 합니다 (안 그러면 전 세션이 상한에 붙습니다).
          fiveHourPercent = Math.min(97, fiveHourPercent + random() * 3.5);
          weeklyPercent = Math.min(99, weeklyPercent + random() * 0.55);

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
      }

      fs.writeFileSync(path.join(dir, `rollout-${sessionId}.jsonl`), `${lines.join('\n')}\n`);
      files += 1;
    }
  }

  const dataDir = path.join(path.dirname(args.out), 'user-data');
  console.log(`합성 데모 로그 생성 완료 — 실측 데이터가 아닙니다.`);
  console.log(`  세션 파일 ${files}개 · 턴 ${turnBoundaries}개 · 도구 호출 ${toolCalls}회 · token_count 이벤트 ${events}개 · 컴팩션 ${compactedSessions}세션 · ${args.days}일치`);
  console.log(`  위치: ${sessionsRoot}`);
  console.log('');
  console.log('이 데이터로 서버를 띄우려면:');
  console.log(`  CODEX_HOME=${args.out} NYANG_USER_DATA=${dataDir} npm run start:web`);
}

main();
