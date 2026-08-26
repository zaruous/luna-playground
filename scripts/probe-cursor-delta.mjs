#!/usr/bin/env node
// Phase 0b 실측: 대화(chat) 하나 안의 연속 breakdown 스냅샷을 순서대로 diff해서
// "구간 추정치"를 만들 때, 두 가지가 실제로 얼마나 문제가 되는지 잽니다.
//
//   1. 압축(compaction) — 5.1/conversation이 줄어드는 지점이 실제로 몇 번,
//      얼마나 큰 폭으로 나타나는가. 음수 델타를 0으로 클램프했을 때 얼마나
//      "손실"(과소집계)이 생기는가.
//   2. 카테고리 선택 민감도 — 5.1(전체) 기준 diff 합계와 conversation 카테고리만
//      기준 diff 합계가 얼마나 다른가(비율).
//
// 대상은 CLI 대화(~/.cursor/chats/<workspaceHash>/<chatId>/store.db)만입니다 —
// 파일 하나 = 대화 하나로 자연히 묶이기 때문입니다. IDE 쪽(cursorDiskKV)은 blob이
// content-addressed라 별도 대화 귀속 조사 없이는 순서를 못 매겨 이번 패스에서는
// 뺍니다(docs/dev/cursor/measurements.md에 스코프로 기록).
//
// 순서 기준은 SQLite 암묵 rowid(삽입 순서)입니다 — blob 자체엔 신뢰할 만한 시각
// 필드가 없어서(measurements.md "확인되지 않은 것"), 이게 지금 쓸 수 있는 유일한
// 순서 신호입니다.
//
//   node scripts/probe-cursor-delta.mjs
//   NYANG_CURSOR_HOME=/path node scripts/probe-cursor-delta.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { scanProtobuf } from '../service/providers/gemini/antigravity-protobuf.mjs';

function parseArgs(argv) {
  const args = { cursorHome: process.env.NYANG_CURSOR_HOME || path.join(os.homedir(), '.cursor') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') args.cursorHome = path.resolve(argv[++i]);
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
      if (fs.existsSync(dbPath)) dbPaths.push({ dbPath, chatId: cd.name });
    }
  }
  return dbPaths;
}

// 한 대화의 순서 있는 breakdown 시퀀스에서 diff 합계를 냅니다.
// clamp: 음수 델타(압축 등으로 값이 줄어든 구간)는 0으로 눌러 담습니다.
function diffSeries(values) {
  let clampedSum = 0;
  let rawSum = 0; // 클램프 없이 그냥 다 더한 것(참고용 — 음수가 껴서 과소집계됨)
  let compactionEvents = 0;
  let compactionLoss = 0; // 클램프로 인해 "버려진" 음수 폭의 합(절대값)
  let maxDrop = 0;
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    rawSum += delta;
    if (delta < 0) {
      compactionEvents += 1;
      compactionLoss += -delta;
      maxDrop = Math.min(maxDrop, delta);
    } else {
      clampedSum += delta;
    }
  }
  return { clampedSum, rawSum, compactionEvents, compactionLoss, maxDrop, steps: Math.max(0, values.length - 1) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const chatDbs = collectChatDbPaths(args.cursorHome);

  const perChat = [];
  let scannedDbs = 0;
  let totalBlobsSeen = 0;
  let totalBinaryBlobs = 0;
  let totalBreakdownBlobs = 0;

  for (const { dbPath, chatId } of chatDbs) {
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { continue; }
    scannedDbs += 1;

    let rows;
    try {
      rows = db.prepare('SELECT rowid AS seq, data FROM blobs ORDER BY rowid').all();
    } catch {
      db.close();
      continue;
    }
    db.close();

    const fullSeries = [];
    const convSeries = [];
    for (const row of rows) {
      totalBlobsSeen += 1;
      const buffer = Buffer.from(row.data);
      if (isPlainTextBlob(buffer)) continue;
      totalBinaryBlobs += 1;
      let breakdown;
      try { breakdown = extractBreakdown(buffer); } catch { continue; }
      if (breakdown.total == null || !breakdown.categories.length) continue;
      totalBreakdownBlobs += 1;
      fullSeries.push(breakdown.total);
      const conv = breakdown.categories.find((c) => c.label === 'conversation');
      convSeries.push(conv ? conv.tokens : 0);
    }

    if (fullSeries.length < 2) continue; // diff 낼 게 없음(스냅샷 0~1개)

    const fullDiff = diffSeries(fullSeries);
    const convDiff = diffSeries(convSeries);
    perChat.push({
      chatId, snapshots: fullSeries.length,
      firstTotal: fullSeries[0], lastTotal: fullSeries[fullSeries.length - 1],
      fullDiff, convDiff,
    });
  }

  console.log(`cursorHome: ${args.cursorHome}`);
  console.log(`CLI 대화(store.db) 파일: ${chatDbs.length}개 · 열린 DB: ${scannedDbs}개`);
  console.log(`blob 총 ${totalBlobsSeen}개 · 이진 ${totalBinaryBlobs}개 · breakdown 있음 ${totalBreakdownBlobs}개`);
  console.log(`diff 가능한 대화(스냅샷 2개 이상): ${perChat.length}개 / 전체 ${chatDbs.length}개`);
  console.log('');

  if (!perChat.length) {
    console.log('diff 낼 수 있는 대화가 없습니다(스냅샷이 대화당 1개 이하) — 감도 분석 불가.');
    return;
  }

  // ---- 1) 압축(compaction) 빈도·크기 ----
  const chatsWithCompaction = perChat.filter((c) => c.fullDiff.compactionEvents > 0);
  const totalSteps = perChat.reduce((a, c) => a + c.fullDiff.steps, 0);
  const totalCompactionEvents = perChat.reduce((a, c) => a + c.fullDiff.compactionEvents, 0);
  const totalCompactionLoss = perChat.reduce((a, c) => a + c.fullDiff.compactionLoss, 0);
  const totalClampedFull = perChat.reduce((a, c) => a + c.fullDiff.clampedSum, 0);

  console.log('=== 1) 압축(compaction) 빈도 — 5.1(전체) 기준 ===');
  console.log(`구간(step) 총 ${totalSteps}개 중 음수 델타(값이 줄어든 구간) ${totalCompactionEvents}개`);
  console.log(`압축 발생한 대화: ${chatsWithCompaction.length}개 / diff 가능한 대화 ${perChat.length}개`);
  console.log(`클램프로 버려진 감소분 합계(=과소집계 위험 총량): ${totalCompactionLoss.toLocaleString()} 토큰`);
  console.log(`클램프 적용 후 합계 총량: ${totalClampedFull.toLocaleString()} 토큰`);
  console.log(`과소집계 위험 비율(버려진 감소분 / 클램프 후 합계): ${totalClampedFull ? ((totalCompactionLoss / totalClampedFull) * 100).toFixed(2) : 'n/a'}%`);
  if (chatsWithCompaction.length) {
    console.log('압축 발생 대화 상위 5개(감소폭 큰 순):');
    chatsWithCompaction
      .sort((a, b) => a.fullDiff.maxDrop - b.fullDiff.maxDrop)
      .slice(0, 5)
      .forEach((c) => console.log(`  ${c.chatId}: 스냅샷 ${c.snapshots}개, 압축 ${c.fullDiff.compactionEvents}회, 최대 감소폭 ${c.fullDiff.maxDrop}, 손실합 ${c.fullDiff.compactionLoss}`));
  }
  console.log('');

  // ---- 2) 카테고리 선택 민감도 — 5.1(전체) diff 합 vs conversation-only diff 합 ----
  const totalClampedConv = perChat.reduce((a, c) => a + c.convDiff.clampedSum, 0);
  console.log('=== 2) 카테고리 선택 민감도 — 전체(5.1) diff 합 vs conversation-only diff 합 ===');
  console.log(`전체(5.1) 기준 클램프 합계:        ${totalClampedFull.toLocaleString()} 토큰`);
  console.log(`conversation 전용 기준 클램프 합계: ${totalClampedConv.toLocaleString()} 토큰`);
  const ratio = totalClampedConv ? (totalClampedFull / totalClampedConv) : null;
  console.log(`비율(전체 / conversation-only): ${ratio ? ratio.toFixed(2) + '배' : 'n/a'}`);
  console.log(`=> 전체 기준이 conversation-only보다 이만큼 더 잡습니다(도구/룰/MCP 등 설정성 증가분 포함) — 이 차이가 "카테고리 선택 민감도"입니다.`);
  console.log('');

  console.log('=== 대화별 상세(스냅샷 3개 이상만, 최대 10개) ===');
  const detailed = perChat.filter((c) => c.snapshots >= 3).slice(0, 10);
  for (const c of detailed) {
    console.log(`- ${c.chatId}: 스냅샷 ${c.snapshots}개, 5.1 첫값 ${c.firstTotal} → 마지막값 ${c.lastTotal}`);
    console.log(`    전체diff 클램프합=${c.fullDiff.clampedSum}, 압축${c.fullDiff.compactionEvents}회(손실 ${c.fullDiff.compactionLoss})`);
    console.log(`    conv diff 클램프합=${c.convDiff.clampedSum}, 압축${c.convDiff.compactionEvents}회(손실 ${c.convDiff.compactionLoss})`);
  }
}

main();
