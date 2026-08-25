#!/usr/bin/env node
// Cursor IDE(Composer)·CLI(cursor-agent) 로컬 blob 저장소에 토큰류 필드가
// 있는지 훑습니다. blob은 두 종류입니다 — 첫 바이트가 '{'/'['이면 평문 JSON
// (본문이 그대로 들어 있어 **절대 열지 않고 건너뜁니다**), 그 외는 필드 이름
// 없는 protobuf류 이진입니다. 이진만 scanProtobuf 로 재귀 훑어 필드 번호·값만
// 표로 냅니다 — scripts/probe-antigravity.mjs 와 같은 목적, 같은 방법입니다.
//
// 확인된 것(2026-08-25, docs/dev/cursor/measurements.md): 필드 경로 5.1/5.2/
// 5.3.3[] 에 이름 있는 컨텍스트 구성 breakdown이 있습니다 — 5.1 = 그 시점
// 컨텍스트 총 토큰, 5.2 = 컨텍스트 창 크기, 5.3.3[] = 카테고리(system_prompt/
// tools/rules/skills/mcp/subagents/summarized_conversation/conversation)별
// 토큰·문자 수. 이 스크립트는 그 구조를 직접 찾아 항등식(카테고리 합 == 총합)을
// 검증하고, 그 밖의 varint 필드는 일반 통계로 남깁니다.
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

// 5.1(총 토큰)/5.2(창 크기)/5.3.3[](카테고리별 토큰) breakdown을 한 blob에서
// 뽑습니다. 카테고리 키·표시명은 고정 어휘(system_prompt 등)만 취하고, 다른
// 문자열 필드는 안 봅니다 — 본문에 닿지 않기 위해서입니다.
function extractBreakdown(buffer) {
  let total = null;
  let windowSize = null;
  const categories = [];
  let currentLabel = null;
  let currentTokens = null;
  scanProtobuf(buffer, (fieldPath, kind, value) => {
    if (fieldPath === '5.1' && kind === 'varint') total = value;
    if (fieldPath === '5.2' && kind === 'varint') windowSize = value;
    if (fieldPath === '5.3.3.1' && kind === 'bytes') {
      if (currentLabel != null) categories.push({ label: currentLabel, tokens: currentTokens ?? 0 });
      currentLabel = value.toString('utf8');
      currentTokens = null;
    }
    if (fieldPath === '5.3.3.3' && kind === 'varint') currentTokens = value;
  });
  if (currentLabel != null) categories.push({ label: currentLabel, tokens: currentTokens ?? 0 });
  return { total, windowSize, categories };
}

// 이진 blob을 한 소스(파일 또는 IDE 전역 테이블)에서 훑습니다. scanProtobuf는
// 진짜 protobuf가 아닌 바이트에 물리면 예외를 던질 수 있어(varint too long),
// **행 단위**로 감싸 건너뜁니다 — 파일/소스 단위로 감싸면 예외가 난 행 이후가
// 전부 조용히 사라집니다(실제로 이 버그로 IDE 쪽 1차 조사가 6행만 본 적 있음).
function scanBlobs(rows, source, sink) {
  for (const row of rows) {
    const buffer = Buffer.from(row.data ?? row.value);
    sink.blobsTotal += 1;
    if (isPlainTextBlob(buffer)) { sink.blobsPlainText += 1; continue; }
    sink.blobsBinary += 1;

    let breakdown;
    try {
      breakdown = extractBreakdown(buffer);
    } catch {
      sink.scanErrors += 1;
      continue;
    }
    if (breakdown.total != null && breakdown.categories.length) {
      sink.breakdownBlobs += 1;
      const sum = breakdown.categories.reduce((acc, c) => acc + c.tokens, 0);
      if (sum === breakdown.total) sink.breakdownMatches += 1;
      else {
        sink.breakdownMismatches += 1;
        if (sink.mismatchExamples.length < 5) {
          sink.mismatchExamples.push({ source, total: breakdown.total, sum, categories: breakdown.categories });
        }
      }
      sink.windowSizes.set(breakdown.windowSize, (sink.windowSizes.get(breakdown.windowSize) ?? 0) + 1);
      for (const c of breakdown.categories) sink.labels.add(c.label);
    }

    try {
      scanProtobuf(buffer, (fieldPath, kind, value) => {
        if (kind !== 'varint') return;
        const stats = sink.fieldStats.get(fieldPath) ?? emptyFieldStats();
        noteValue(stats, value, source);
        sink.fieldStats.set(fieldPath, stats);
      });
    } catch {
      // 위 extractBreakdown 이 이미 이 blob을 한 번 훑었으므로 여기서 또 던지면
      // 그냥 일반 필드 통계만 못 채우는 것 — breakdown 판정에는 영향 없습니다.
    }
  }
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

// 토큰 수라면 그럴싸한 범위(두 자리~수백만)인 varint 필드만 후보로 좁힙니다.
function looksTokenShaped(stats) {
  if (stats.count < 5) return false;
  if (stats.max == null || stats.max < 10) return false;
  if (stats.max > 50_000_000) return false;
  const spread = stats.increases + stats.decreases;
  if (spread === 0) return false;
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('사용법: node scripts/probe-cursor.mjs [--home DIR] [--appdata DIR]');
    return;
  }

  const sink = {
    blobsTotal: 0, blobsPlainText: 0, blobsBinary: 0, scanErrors: 0,
    breakdownBlobs: 0, breakdownMatches: 0, breakdownMismatches: 0,
    mismatchExamples: [], windowSizes: new Map(), labels: new Set(),
    fieldStats: new Map(),
  };

  // [1] CLI: ~/.cursor/chats/<workspaceHash>/<chatId>/store.db (blobs 테이블)
  const chatDbPaths = collectChatDbPaths(args.cursorHome);
  let dbFiles = 0;
  for (const dbPath of chatDbPaths) {
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { continue; }
    dbFiles += 1;
    const source = `cli:${path.basename(path.dirname(dbPath))}`;
    try {
      const rows = db.prepare('SELECT id, data FROM blobs').all();
      scanBlobs(rows, source, sink);
    } catch { /* 테이블 없음 등 — 건너뜀 */ } finally { db.close(); }
  }

  // [2] IDE: <Cursor User>/globalStorage/state.vscdb 의 cursorDiskKV(agentKv:blob:%)
  // 이 테이블은 수만~수십만 행일 수 있어 iterate() 로 한 행씩 흘립니다.
  if (args.cursorAppData) {
    const idePath = path.join(args.cursorAppData, 'globalStorage', 'state.vscdb');
    if (fs.existsSync(idePath)) {
      let db;
      try { db = new DatabaseSync(idePath, { readOnly: true }); } catch { db = null; }
      if (db) {
        dbFiles += 1;
        try {
          const iter = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'").iterate();
          scanBlobs(iter, 'ide:cursorDiskKV', sink);
        } catch { /* 테이블/스키마 없음 */ } finally { db.close(); }
      }
    }
  }

  console.log(`cursorHome: ${args.cursorHome}`);
  console.log(`cursorAppData: ${args.cursorAppData ?? '(미지정)'}`);
  console.log(`CLI 대화(store.db) 파일: ${chatDbPaths.length}개 · 스캔한 DB 파일 총: ${dbFiles}개`);
  console.log(`blob 총 ${sink.blobsTotal}개 — 평문 JSON(건너뜀) ${sink.blobsPlainText}개 · 이진(스캔) ${sink.blobsBinary}개 · scanProtobuf 예외로 건너뜀 ${sink.scanErrors}개`);
  console.log('');

  console.log(`=== 컨텍스트 구성 breakdown (5.1/5.2/5.3.3[]) ===`);
  console.log(`breakdown 있는 blob: ${sink.breakdownBlobs}개`);
  console.log(`카테고리 합 == 5.1 총합: ${sink.breakdownMatches} · 불일치: ${sink.breakdownMismatches}`);
  console.log(`창 크기(5.2) 분포:`, [...sink.windowSizes.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)));
  console.log(`카테고리 라벨:`, [...sink.labels]);
  if (sink.breakdownMismatches) {
    console.log('불일치 예시:');
    sink.mismatchExamples.forEach((m) => console.log(JSON.stringify(m)));
  }
  console.log('');

  const allRows = [...sink.fieldStats.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([field, s]) => [field, s.count, s.min, s.max, s.last, s.increases, s.decreases, s.equal, s.sources.size]);
  console.log(`=== 그 밖의 varint 필드 경로 ${allRows.length}종 (상위 20, count 내림차순) ===`);
  if (allRows.length) renderTable(allRows.slice(0, 20), ['field', 'count', 'min', 'max', 'last', '↑', '↓', '=', 'sources']);
  else console.log('  (varint 필드 없음)');
  console.log('');

  const tokenShaped = [...sink.fieldStats.entries()].filter(([field, s]) => !field.startsWith('5.') && looksTokenShaped(s));
  console.log(`토큰 수처럼 보이는 그 밖의 후보(5.* 제외, 두 자리~5천만): ${tokenShaped.length}종`);
  if (tokenShaped.length) {
    renderTable(
      tokenShaped.sort((a, b) => b[1].count - a[1].count).slice(0, 20)
        .map(([field, s]) => [field, s.count, s.min, s.max, s.last, s.increases, s.decreases]),
      ['field', 'count', 'min', 'max', 'last', '↑', '↓'],
    );
  } else {
    console.log('  없음');
  }

  console.log('');
  console.log('주의: breakdown 이 아닌 필드는 번호일 뿐 의미가 확정된 것이 아닙니다.');
}

main();
