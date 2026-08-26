#!/usr/bin/env node
// 압축(compaction)이 이미 일어난 상태의 컨텍스트 구성 스냅샷을 CLI+IDE 양쪽에서
// 모읍니다 — summarized_conversation > 0 인 breakdown만 골라 distinct 값을
// 나열합니다. CLI(store.db)는 rowid 순서가 있어 전후 비교가 가능하지만, IDE
// (cursorDiskKV)는 blob이 content-addressed라 순서를 매길 수 없어 "그 순간
// 상태"만 모읍니다 — docs/dev/cursor/커서컨텍스트관리.md의 "더 많은 압축 사례"
// 절이 이 스크립트 결과입니다.
//
//   node scripts/probe-cursor-compaction-samples.mjs
//   NYANG_CURSOR_HOME=/path node scripts/probe-cursor-compaction-samples.mjs
//   NYANG_CURSOR_APPDATA=/path node scripts/probe-cursor-compaction-samples.mjs

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
  }
  return args;
}

function isPlainTextBlob(buffer) {
  if (!buffer?.length) return true;
  const head = buffer[0];
  return head === 0x7b || head === 0x5b;
}

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const seen = new Set();
  const samples = [];

  function consider(breakdown, source) {
    const sc = breakdown.categories.find((c) => c.label === 'summarized_conversation');
    if (!sc || sc.tokens <= 0) return;
    const key = `${breakdown.total}|${breakdown.windowSize}|${breakdown.categories.map((c) => c.tokens).join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    samples.push({ source, total: breakdown.total, windowSize: breakdown.windowSize, categories: breakdown.categories });
  }

  // CLI
  const chatsRoot = path.join(args.cursorHome, 'chats');
  let cliBinary = 0;
  let workspaceDirs = [];
  try { workspaceDirs = fs.readdirSync(chatsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* none */ }
  for (const wd of workspaceDirs) {
    const wpath = path.join(chatsRoot, wd.name);
    let chatDirs = [];
    try { chatDirs = fs.readdirSync(wpath, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const cd of chatDirs) {
      const dbPath = path.join(wpath, cd.name, 'store.db');
      if (!fs.existsSync(dbPath)) continue;
      let db;
      try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { continue; }
      let rows;
      try { rows = db.prepare('SELECT data FROM blobs').all(); } catch { db.close(); continue; }
      db.close();
      for (const row of rows) {
        const buffer = Buffer.from(row.data);
        if (isPlainTextBlob(buffer)) continue;
        cliBinary += 1;
        let breakdown;
        try { breakdown = extractBreakdown(buffer); } catch { continue; }
        if (breakdown.total == null || !breakdown.categories.length) continue;
        consider(breakdown, `cli:${cd.name}`);
      }
    }
  }

  // IDE
  let ideBinary = 0;
  if (args.cursorAppData) {
    const idePath = path.join(args.cursorAppData, 'globalStorage', 'state.vscdb');
    if (fs.existsSync(idePath)) {
      let db;
      try { db = new DatabaseSync(idePath, { readOnly: true }); } catch { db = null; }
      if (db) {
        try {
          const iter = db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'").iterate();
          for (const row of iter) {
            const buffer = Buffer.from(row.value);
            if (isPlainTextBlob(buffer)) continue;
            ideBinary += 1;
            let breakdown;
            try { breakdown = extractBreakdown(buffer); } catch { continue; }
            if (breakdown.total == null || !breakdown.categories.length) continue;
            consider(breakdown, 'ide');
          }
        } catch { /* 테이블 없음 */ } finally { db.close(); }
      }
    }
  }

  console.log(`CLI 이진 blob ${cliBinary}개, IDE 이진 blob ${ideBinary}개 스캔`);
  console.log(`summarized_conversation > 0 인 distinct 스냅샷: ${samples.length}개`);
  samples.sort((a, b) => a.total - b.total);
  for (const s of samples) {
    const map = Object.fromEntries(s.categories.map((c) => [c.label, c.tokens]));
    console.log(`[${s.source}] total=${s.total} window=${s.windowSize} summarized_conversation=${map.summarized_conversation} conversation=${map.conversation} system_prompt=${map.system_prompt} tools=${map.tools} rules=${map.rules} skills=${map.skills} mcp=${map.mcp} subagents=${map.subagents}`);
  }
}

main();
