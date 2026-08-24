#!/usr/bin/env node
// 로컬 Codex 로그의 **구조만** 조사해 붙여넣기 안전한 리포트를 출력합니다.
//
// 이 스크립트는 프롬프트·응답 본문, 파일 경로, 세션 ID, 작업 디렉터리를
// 출력하지 않습니다. 필드의 존재 여부와 수치 관계만 셉니다. 결과를 그대로
// 복사해 공유해도 안전하도록 만드는 것이 목적입니다.
//
//   node scripts/inspect-codex.mjs                 # ~/.codex (또는 CODEX_HOME)
//   node scripts/inspect-codex.mjs --home D:/codex # 위치 지정
//   node scripts/inspect-codex.mjs --limit 300     # 최근 N개 파일만

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';

function parseArgs(argv) {
  const args = { home: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), limit: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') args.home = path.resolve(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Math.max(1, Number(argv[++i]) || 1000);
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function* walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full;
  }
}

function bump(map, key) { map.set(key, (map.get(key) ?? 0) + 1); }

function renderCounts(map, indent = '  ') {
  if (!map.size) return `${indent}(없음)`;
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${indent}${key} × ${count}`)
    .join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('사용법: node scripts/inspect-codex.mjs [--home DIR] [--limit N]');
    return;
  }

  const roots = [path.join(args.home, 'sessions'), path.join(args.home, 'archived_sessions')];
  const files = [];
  for (const root of roots) for (const file of walk(root)) files.push(file);
  if (!files.length) {
    console.log(`Codex 로그를 찾지 못했습니다: ${roots.join(', ')}`);
    console.log('CODEX_HOME 환경변수나 --home 으로 위치를 지정해 보세요.');
    return;
  }
  files.sort((a, b) => {
    const statA = fs.statSync(a).mtimeMs;
    const statB = fs.statSync(b).mtimeMs;
    return statB - statA;
  });
  const targets = files.slice(0, args.limit);

  const usageFieldPresence = new Map();
  const rateFieldPresence = new Map();
  const infoFieldPresence = new Map();
  const windowCombos = new Map();
  const windowMinutes = new Map();
  const models = new Map();
  const cliVersions = new Map();
  const planTypes = new Map();
  const cwdStyles = new Map();
  const identity = { checked: 0, inputPlusOutputEqualsTotal: 0, cachedWithinInput: 0, reasoningWithinOutput: 0 };
  const cacheWrite = { records: 0, nonZero: 0, max: 0 };
  let tokenCountRecords = 0;
  let parseFailures = 0;

  for (const file of targets) {
    const stream = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of stream) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { parseFailures += 1; continue; }

      if (record.type === 'session_meta' && record.payload?.cli_version) bump(cliVersions, String(record.payload.cli_version));
      if (record.payload?.cwd) bump(cwdStyles, /^[a-zA-Z]:[\\/]/.test(record.payload.cwd) ? 'Windows 스타일 (C:\\...)' : 'POSIX 스타일 (/...)');
      if (record.type === 'turn_context' && record.payload?.model) bump(models, String(record.payload.model));

      if (record.payload?.type !== 'token_count') continue;
      tokenCountRecords += 1;
      const info = record.payload.info ?? {};
      for (const key of Object.keys(info)) bump(infoFieldPresence, key);

      const usage = info.total_token_usage ?? {};
      for (const key of Object.keys(usage)) bump(usageFieldPresence, key);

      const input = Number(usage.input_tokens) || 0;
      const cached = Number(usage.cached_input_tokens) || 0;
      const write = Number(usage.cache_write_input_tokens) || 0;
      const output = Number(usage.output_tokens) || 0;
      const reasoning = Number(usage.reasoning_output_tokens) || 0;
      const total = Number(usage.total_tokens) || 0;

      if ('cache_write_input_tokens' in usage) {
        cacheWrite.records += 1;
        if (write > 0) cacheWrite.nonZero += 1;
        cacheWrite.max = Math.max(cacheWrite.max, write);
      }
      if (total > 0) {
        identity.checked += 1;
        if (input + output === total) identity.inputPlusOutputEqualsTotal += 1;
        if (cached <= input) identity.cachedWithinInput += 1;
        if (reasoning <= output) identity.reasoningWithinOutput += 1;
      }

      const limits = record.payload.rate_limits;
      if (limits) {
        for (const key of Object.keys(limits)) bump(rateFieldPresence, key);
        if (limits.plan_type) bump(planTypes, String(limits.plan_type));
        const lanes = ['primary', 'secondary'].filter((lane) => limits[lane]);
        bump(windowCombos, lanes.length ? lanes.join(' + ') : '(둘 다 null)');
        for (const lane of lanes) bump(windowMinutes, `${lane}: ${limits[lane].window_minutes}분`);
      }
    }
  }

  const pct = (value) => (identity.checked ? `${((value / identity.checked) * 100).toFixed(1)}%` : '—');
  console.log('# NyangTracker Codex 로그 구조 리포트');
  console.log('# 프롬프트 본문·경로·세션 ID는 포함하지 않습니다. 그대로 붙여넣어도 안전합니다.');
  console.log('');
  console.log(`스캔 파일        : ${targets.length}개 (전체 ${files.length}개 중 최근순)`);
  console.log(`token_count 레코드: ${tokenCountRecords}개${parseFailures ? ` · 파싱 실패 ${parseFailures}줄` : ''}`);
  console.log('');
  console.log('## 토큰 회계 항등식');
  console.log(`  검사 대상            : ${identity.checked}건`);
  console.log(`  input + output = total: ${identity.inputPlusOutputEqualsTotal} (${pct(identity.inputPlusOutputEqualsTotal)})`);
  console.log(`  cached <= input      : ${identity.cachedWithinInput} (${pct(identity.cachedWithinInput)})`);
  console.log(`  reasoning <= output  : ${identity.reasoningWithinOutput} (${pct(identity.reasoningWithinOutput)})`);
  console.log('');
  console.log('## 캐시 쓰기 (cache_write_input_tokens)');
  console.log(`  필드 존재 레코드: ${cacheWrite.records}건`);
  console.log(`  0이 아닌 값     : ${cacheWrite.nonZero}건 · 최댓값 ${cacheWrite.max.toLocaleString('en-US')}`);
  console.log('');
  console.log('## 한도 레인 조합');
  console.log(renderCounts(windowCombos));
  console.log('## 창 길이');
  console.log(renderCounts(windowMinutes));
  console.log('');
  console.log('## usage 필드 출현');
  console.log(renderCounts(usageFieldPresence));
  console.log('## info 필드 출현');
  console.log(renderCounts(infoFieldPresence));
  console.log('## rate_limits 필드 출현');
  console.log(renderCounts(rateFieldPresence));
  console.log('');
  console.log('## 모델');
  console.log(renderCounts(models));
  console.log('## CLI 버전');
  console.log(renderCounts(cliVersions));
  console.log('## plan_type');
  console.log(renderCounts(planTypes));
  console.log('## cwd 표기');
  console.log(renderCounts(cwdStyles));
}

main();
