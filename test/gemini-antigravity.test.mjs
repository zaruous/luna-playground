import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  antigravityConversationsDir,
  detectAntigravity,
  resolveAntigravityHome,
} from '../service/providers/gemini/detector.mjs';
import { scanProtobuf, toBytes } from '../service/providers/gemini/antigravity-protobuf.mjs';

test('toBytes 는 콤마 구분 십진 문자열을 바이트로 되돌린다', () => {
  assert.deepEqual([...toBytes('18,1,2,0,0')], [18, 1, 2, 0, 0]);
});

test('scanProtobuf 는 중첩 varint 필드 경로를 번호로 낸다', () => {
  const buffer = Buffer.from([0x08, 0x7b, 0x12, 0x04, 0x08, 0x01, 0x10, 0x02]);
  const fields = [];
  scanProtobuf(buffer, (fieldPath, kind, value) => {
    if (kind === 'varint') fields.push([fieldPath, value]);
  });
  assert.deepEqual(fields, [['1', 123], ['2.1', 1], ['2.2', 2]]);
});

test('detectAntigravity 는 conversations/*.db 를 찾고 없으면 present false', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyang-agy-detect-'));
  const prev = process.env.NYANG_ANTIGRAVITY_HOME;
  process.env.NYANG_ANTIGRAVITY_HOME = root;
  try {
    const empty = await detectAntigravity(resolveAntigravityHome());
    assert.deepEqual(empty, { present: false, conversationCount: 0, lastActivityAt: null });

    const conv = antigravityConversationsDir(root);
    fs.mkdirSync(conv, { recursive: true });
    const dbPath = path.join(conv, 'sample.db');
    fs.writeFileSync(dbPath, '');
    const found = await detectAntigravity(root);
    assert.equal(found.present, true);
    assert.equal(found.conversationCount, 1);
    assert.match(found.lastActivityAt, /T/);
  } finally {
    if (prev == null) delete process.env.NYANG_ANTIGRAVITY_HOME;
    else process.env.NYANG_ANTIGRAVITY_HOME = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
