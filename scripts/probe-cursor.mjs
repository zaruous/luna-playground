#!/usr/bin/env node
// Cursor IDE(Composer)·CLI(cursor-agent) 로컬 blob 저장소에 토큰류 필드가
// 있는지 훑습니다. blob은 두 종류입니다 — 첫 바이트가 '{'/'['이면 평문 JSON
// (본문이 그대로 들어 있어 **절대 열지 않고 건너뜁니다**), 그 외는 필드 이름
// 없는 protobuf류 이진입니다. 이진만 scanProtobuf 로 재귀 훑어 필드 번호·값만
// 표로 냅니다 — scripts/probe-antigravity.mjs 와 같은 목적, 같은 방법입니다.
//
//   node scripts/probe-cursor.mjs
//   NYANG_CURSOR_HOME=/path node scripts/probe-cursor.mjs        (~/.cursor 대체)
//   NYANG_CURSOR_APPDATA=/path node scripts/probe-cursor.mjs     (Cursor User 데이터 대체)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { scanProtobuf } from '../service/providers/gemini/antigravity-protobuf.mjs';

function parseArgs(argv) {
  const args = {
    cursorHome: process.env.NYANG_CURSOR_HOME || path.join(os.homedir(), '.cursor'),
    cursorAppData: process.env.NYANG_CURSOR_APPDATA
      || (process.platform === 'win32'
        ? path.join(process.env.APPDATA || os.homedir(), 'Cursor', 'User')
        : null),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') args.cursorHome = path.resolve(argv[++i]);
    else if (argv[i] === '--appdata') args.cursorAppData = path.resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function emptyFieldStats() {
  return { count: 0, min: null, max: null, last: null, increases: 0, decreases: 0, equal: 0, sources: new Set() };
}

function noteValue(stats, value, source) {
  stats.count += 1;
  stats.min = stats.min == null ? value : Math.min(stats.min, value);
  stats.max = stats.max == null ? value : Math.max(stats.max, value);
  if (stats.last != null) {
    if (value > stats.last) stats.increases += 1;
    else if (value < stats.last) stats.decreases += 1;
    else stats.equal += 1;
  }
  stats.last = value;
  stats.sources.add(source);
}

function renderTable(rows, header) {
  const widths = header.map((key) => key.length);
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i], String(cell).length); });
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

// blob 이 평문 JSON(본문)인지 첫 바이트로만 판정합니다 — 내용은 절대 안 읽습니다.
function isPlainTextBlob(buffer) {
  if (!buffer?.length) return true;
  const head = buffer[0];
  return head === 0x7b || head === 0x5b; // '{' 또는 '['
}

function walkSqliteBlobColumn(dbPath, sql, onRow) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return 0;
  }
  let count = 0;
  try {
    const rows = db.prepare(sql).all();
    for (const row of rows) { onRow(row); count += 1; }
  } catch {
    // 테이블이 없거나 스키마가 다른 버전 — 조용히 건너뜁니다.
  } finally {
    db.close();
  }
  return count;
}

function collectChatDbPaths(cursorHome) {
  const chatsRoot = path.join(cursorHome, 'chats');
  const dbPaths = [];
  let workspaceDirs = [];
  try {
    workspaceDirs = fs.readdirSync(chatsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return dbPaths;
  }
  for (const wd of workspaceDirs) {
    const wpath = path.join(chatsRoot, wd.name);
    let chatDirs = [];
    try {
      chatDirs = fs.readdirSync(wpath, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const cd of chatDirs) {
      const dbPath = path.join(wpath, cd.name, 'store.db');
      if (fs.existsSync(dbPath)) dbPaths.push(dbPath);
    }
  }
  return dbPaths;
}

function candidateIdentities(fieldStats) {
  const totals = [...fieldStats.entries()]
    .filter(([, stats]) => stats.count >= 3)
    .map(([field, stats]) => ({ field, last: stats.last, max: stats.max }));
  const partsFields = totals.filter((row) => row.field.includes('.') && !row.field.endsWith('.1'));
  const hits = [];
  for (const total of totals) {
    for (const parts of partsFields) {
      if (parts.field === total.field) continue;
      const siblingPrefix = `${parts.field}.`;
      const siblings = [...fieldStats.entries()]
        .filter(([field, stats]) => field.startsWith(siblingPrefix) && stats.last != null)
        .map(([, stats]) => stats.last);
      if (siblings.length < 2) continue;
      const sum = siblings.reduce((acc, value) => acc + value, 0);
      if (sum > 0 && sum === total.last) {
        hits.push(`${parts.field}.* 조각 합 ${sum} == ${total.field} 마지막 관측 ${total.last}`);
      }
    }
  }
  return hits;
}

// 토큰 수라면 그럴싸한 범위(두 자리~수백만)인 varint 필드만 후보로 좁힙니다.
// 순수 카운트(호출 횟수 등)나 epoch-ms 시각, 고정 상수와 구분하기 위한
// 1차 거름망입니다 — 확정이 아니라 사람이 다음에 볼 후보를 줄이는 용도입니다.
function looksTokenShaped(stats) {
  if (stats.count < 5) return false;
  if (stats.max == null || stats.max < 10) return false;
  if (stats.max > 50_000_000) return false; // epoch-ms 등 거름
  const spread = stats.increases + stats.decreases;
  if (spread === 0) return false; // 고정값(상수 플래그류)은 후보에서 뺍니다
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('사용법: node scripts/probe-cursor.mjs [--home DIR] [--appdata DIR]');
    return;
  }

  const fieldStats = new Map();
  let blobsTotal = 0;
  let blobsPlainText = 0;
  let blobsBinary = 0;
  let dbFiles = 0;
  let sourcesScanned = 0;

  // [1] CLI: ~/.cursor/chats/<workspaceHash>/<chatId>/store.db (blobs 테이블)
  const chatDbPaths = collectChatDbPaths(args.cursorHome);
  for (const dbPath of chatDbPaths) {
    dbFiles += 1;
    const source = `cli:${path.basename(path.dirname(dbPath))}`;
    const n = walkSqliteBlobColumn(dbPath, 'SELECT id, data FROM blobs', (row) => {
      blobsTotal += 1;
      const buffer = Buffer.from(row.data);
      if (isPlainTextBlob(buffer)) { blobsPlainText += 1; return; }
      blobsBinary += 1;
      scanProtobuf(buffer, (fieldPath, kind, value) => {
        if (kind !== 'varint') return;
        const stats = fieldStats.get(fieldPath) ?? emptyFieldStats();
        noteValue(stats, value, source);
        fieldStats.set(fieldPath, stats);
      });
    });
    if (n > 0) sourcesScanned += 1;
  }

  // [2] IDE: <Cursor User>/globalStorage/state.vscdb 의 cursorDiskKV(agentKv:blob:%)
  let ideCount = 0;
  if (args.cursorAppData) {
    const idePath = path.join(args.cursorAppData, 'globalStorage', 'state.vscdb');
    if (fs.existsSync(idePath)) {
      dbFiles += 1;
      ideCount = walkSqliteBlobColumn(
        idePath,
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'",
        (row) => {
          blobsTotal += 1;
          const buffer = Buffer.from(row.value);
          if (isPlainTextBlob(buffer)) { blobsPlainText += 1; return; }
          blobsBinary += 1;
          scanProtobuf(buffer, (fieldPath, kind, value) => {
            if (kind !== 'varint') return;
            const stats = fieldStats.get(fieldPath) ?? emptyFieldStats();
            noteValue(stats, value, 'ide:cursorDiskKV');
            fieldStats.set(fieldPath, stats);
          });
        },
      );
      if (ideCount > 0) sourcesScanned += 1;
    }
  }

  console.log(`cursorHome: ${args.cursorHome}`);
  console.log(`cursorAppData: ${args.cursorAppData ?? '(미지정)'}`);
  console.log(`CLI 대화(store.db): ${chatDbPaths.length}개 · IDE cursorDiskKV agentKv:blob 행: ${ideCount}개`);
  console.log(`blob 총 ${blobsTotal}개 — 평문 JSON(건너뜀) ${blobsPlainText}개 · 이진(스캔) ${blobsBinary}개`);
  console.log('');

  const allRows = [...fieldStats.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([field, s]) => [field, s.count, s.min, s.max, s.last, s.increases, s.decreases, s.equal, s.sources.size]);
  console.log(`varint 필드 경로 ${allRows.length}종 (상위 40, count 내림차순):`);
  if (allRows.length) renderTable(allRows.slice(0, 40), ['field', 'count', 'min', 'max', 'last', '↑', '↓', '=', 'sources']);
  else console.log('  (varint 필드 없음)');
  console.log('');

  const tokenShaped = [...fieldStats.entries()].filter(([, s]) => looksTokenShaped(s));
  console.log(`토큰 수처럼 보이는 후보(두 자리~5천만, 값이 바뀜, 관측 5회 이상): ${tokenShaped.length}종`);
  if (tokenShaped.length) {
    renderTable(
      tokenShaped
        .sort((a, b) => b[1].count - a[1].count)
        .map(([field, s]) => [field, s.count, s.min, s.max, s.last, s.increases, s.decreases]),
      ['field', 'count', 'min', 'max', 'last', '↑', '↓'],
    );
  } else {
    console.log('  없음 — 이 스캔 범위에서는 토큰류로 보이는 varint 필드를 찾지 못했습니다.');
  }
  console.log('');

  console.log('조각 합 == 선언 총합 후보 (자동 탐색 — 확정 아님):');
  const identities = candidateIdentities(fieldStats);
  if (identities.length) identities.forEach((hit) => console.log(`  · ${hit}`));
  else console.log('  (없음)');

  console.log('');
  console.log(`스캔한 DB 파일: ${dbFiles}개 (그중 blob/행이 1개 이상 나온 파일 ${sourcesScanned}개)`);
  console.log('주의: 여기 나온 숫자는 필드 "번호"일 뿐 의미가 확정된 것이 아닙니다.');
  console.log('      토큰류로 확정하려면 다른 실측(예: contextUsagePercent 변화)과 대조해야 합니다.');
}

main();
