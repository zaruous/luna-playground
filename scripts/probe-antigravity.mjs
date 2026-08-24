#!/usr/bin/env node
// Antigravity CLI conversations/*.db 의 gen_metadata.data protobuf 필드를
// **숫자와 필드 번호만** 훑어 표로 냅니다. 대화 본문·프롬프트·도구 입출력은
// 출력하지 않습니다 — scripts/inspect-codex.mjs 와 같은 목적입니다.
//
//   node scripts/probe-antigravity.mjs
//   NYANG_ANTIGRAVITY_HOME=/path node scripts/probe-antigravity.mjs

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  antigravityConversationsDir,
  resolveAntigravityHome,
} from '../service/providers/gemini/detector.mjs';
import { scanProtobuf, toBytes } from '../service/providers/gemini/antigravity-protobuf.mjs';

function parseArgs(argv) {
  const args = { home: resolveAntigravityHome() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') args.home = path.resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function emptyFieldStats() {
  return {
    count: 0,
    min: null,
    max: null,
    last: null,
    increases: 0,
    decreases: 0,
    equal: 0,
  };
}

function noteValue(stats, value) {
  stats.count += 1;
  stats.min = stats.min == null ? value : Math.min(stats.min, value);
  stats.max = stats.max == null ? value : Math.max(stats.max, value);
  if (stats.last != null) {
    if (value > stats.last) stats.increases += 1;
    else if (value < stats.last) stats.decreases += 1;
    else stats.equal += 1;
  }
  stats.last = value;
}

function renderTable(rows) {
  const header = ['field', 'count', 'min', 'max', 'last', '↑', '↓', '='];
  const widths = header.map((key) => key.length);
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], String(cell).length);
    });
  }
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

function candidateIdentities(fieldStats) {
  const totals = [...fieldStats.entries()]
    .filter(([, stats]) => stats.count >= 3)
    .map(([field, stats]) => ({ field, last: stats.last, max: stats.max }));
  const partsFields = totals.filter((row) => row.field.includes('.3.') || row.field.endsWith('.3'));
  const sumFields = totals.filter((row) => row.field.endsWith('.2') || row.field.endsWith('.1'));
  const hits = [];
  for (const total of totals) {
    for (const parts of partsFields) {
      if (parts.field === total.field) continue;
      const siblings = [...fieldStats.entries()]
        .filter(([field, stats]) => field.startsWith(`${parts.field}.`) && field.endsWith('.4') && stats.last != null)
        .map(([, stats]) => stats.last);
      if (siblings.length < 2) continue;
      const sum = siblings.reduce((acc, value) => acc + value, 0);
      if (sum === total.last) {
        hits.push(`${parts.field} 조각 합 ${sum} == ${total.field} 선언 ${total.last}`);
      }
    }
  }
  if (!hits.length && sumFields.length >= 2) {
    hits.push('(자동 후보 없음 — 필드 경로를 수동으로 대조하세요)');
  }
  return hits;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('사용법: node scripts/probe-antigravity.mjs [--home DIR]');
    return;
  }

  const conversationsDir = antigravityConversationsDir(args.home);
  let files = [];
  try {
    files = fs.readdirSync(conversationsDir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => path.join(conversationsDir, name))
      .sort();
  } catch {
    console.log(`Antigravity conversations 를 찾지 못했습니다: ${conversationsDir}`);
    console.log('NYANG_ANTIGRAVITY_HOME 또는 --home 으로 위치를 지정해 보세요.');
    return;
  }

  if (!files.length) {
    console.log(`대화 DB 가 없습니다: ${conversationsDir}`);
    return;
  }

  const fieldStats = new Map();
  let rowsRead = 0;
  let blobsRead = 0;

  for (const filePath of files) {
    let db;
    try {
      db = new DatabaseSync(filePath, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gen_metadata'").get();
      if (!table) continue;
      const records = db.prepare('SELECT data FROM gen_metadata ORDER BY rowid').all();
      for (const record of records) {
        rowsRead += 1;
        const buffer = toBytes(record.data);
        scanProtobuf(buffer, (fieldPath, kind, value) => {
          if (kind !== 'varint') return;
          blobsRead += 1;
          const stats = fieldStats.get(fieldPath) ?? emptyFieldStats();
          noteValue(stats, value);
          fieldStats.set(fieldPath, stats);
        });
      }
    } finally {
      db.close();
    }
  }

  console.log(`home: ${args.home}`);
  console.log(`conversations: ${files.length}개 · gen_metadata 행 ${rowsRead}개 · varint ${blobsRead}개`);
  console.log('');
  console.log('숫자 varint 필드 (필드 경로 · 출현 · 범위 · 스텝 간 단조성):');
  const tableRows = [...fieldStats.entries()]
    .sort((left, right) => left[0].localeCompare(right[0], undefined, { numeric: true }))
    .map(([field, stats]) => [
      field,
      stats.count,
      stats.min,
      stats.max,
      stats.last,
      stats.increases,
      stats.decreases,
      stats.equal,
    ]);
  if (!tableRows.length) {
    console.log('  (varint 필드 없음)');
  } else {
    renderTable(tableRows);
  }

  console.log('');
  console.log('조각 합 == 선언 총합 후보 (자동 탐색 — 확정 아님):');
  for (const hit of candidateIdentities(fieldStats)) console.log(`  · ${hit}`);

  console.log('');
  console.log('주의: 1.9.10.1 은 컨텍스트 크기이지 소비 토큰이 아닙니다. 합산 금지.');
  console.log('      1.4.* 의 입력/출력/캐시/사고 구분은 아직 미확정입니다.');
}

main();
