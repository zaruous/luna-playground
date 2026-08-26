import { readVarint, scanProtobuf } from '../gemini/antigravity-protobuf.mjs';
import { projectNameFromCwd } from '../../utils.mjs';
import { resolveIdeCwd } from './detector.mjs';

export { readVarint, scanProtobuf };

// 스키마/파싱 규칙이 바뀌면 올립니다 — provider_scan_state.parser_version 과
// cursor_local_activity.parser_version 이 이 값보다 낮은 행은 재해석 대상입니다
// (다른 provider 와 같은 관례, 예: gemini/parser.mjs 의 GEMINI_PARSER_VERSION).
export const CURSOR_PARSER_VERSION = 1;

// blob 이 평문 JSON(본문)인지 첫 바이트로만 판정합니다 — 본문은 절대 열지
// 않습니다(docs/dev/cursor/decisions.md 결정 2). probe-cursor.mjs 와 동일.
export function isPlainTextBlob(buffer) {
  if (!buffer?.length) return true;
  const head = buffer[0];
  return head === 0x7b || head === 0x5b; // '{' 또는 '['
}

// 평문 JSON blob 에서 role 만 뽑고 나머지는 즉시 버립니다 — content 필드는
// 파싱 결과를 담는 변수에조차 담지 않습니다.
export function blobRole(buffer) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  const role = parsed?.role;
  return typeof role === 'string' ? role : null;
}

// 5.1(총 토큰)/5.2(창 크기)/5.3.3[](카테고리별 토큰) breakdown. 카테고리 키는
// 고정 어휘(system_prompt 등)만 취급하고 다른 문자열 필드는 읽지 않습니다 —
// probe-cursor.mjs 의 extractBreakdown 을 그대로 이식(탐사에서 실측 검증됨,
// CLI+IDE 1,818/1,818 blob 에서 카테고리 합 == 총합 항등식 일치).
export function extractBreakdown(buffer) {
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

// 이진 blob 하나를 breakdown 으로 바꿉니다. scanProtobuf 는 protobuf 가 아닌
// 바이트에 물리면 예외를 던질 수 있어(varint too long) 호출하는 쪽이 blob
// 단위로 감싸야 합니다 — 파일/소스 단위로 감싸면 예외 이후 행이 전부 조용히
// 사라집니다(실제로 이 버그로 probe-cursor.mjs 1차 조사가 IDE 쪽 6행만 본 적
// 있음, docs/dev/cursor/measurements.md).
function tryExtractBreakdown(buffer) {
  try {
    const breakdown = extractBreakdown(buffer);
    if (breakdown.total == null || !breakdown.categories.length) return null;
    return breakdown;
  } catch {
    return null;
  }
}

function breakdownToObject(breakdown) {
  const out = {};
  for (const category of breakdown.categories) out[category.label] = category.tokens;
  return out;
}

function toIso(epochMs) {
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

// CLI 대화 하나(store.db 의 blobs 전체 + meta.json)를 cursor_local_activity
// 이벤트 하나로 접습니다. blobRows 는 collector 가 `ORDER BY rowid ASC` 로
// 읽어 넘깁니다 — rowid 오름차순이라야 "가장 나중 breakdown" 이 곧 "최신
// 관측값"입니다(docs/dev/cursor/decisions.md 결정 4 완료 기준: 최신 관측값 승리).
export function parseCliChat({ chatId, cwd, createdAtMs, updatedAtMs, blobRows }) {
  let requestCount = 0;
  let latestBreakdown = null;
  for (const row of blobRows) {
    const buffer = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    if (isPlainTextBlob(buffer)) {
      if (blobRole(buffer) === 'user') requestCount += 1;
      continue;
    }
    const breakdown = tryExtractBreakdown(buffer);
    if (breakdown) latestBreakdown = breakdown;
  }

  return {
    type: 'cursor_activity',
    surface: 'cli',
    composerId: chatId,
    workspaceId: null,
    cwd: cwd ?? null,
    projectName: cwd ? projectNameFromCwd(cwd) : null,
    createdAt: toIso(createdAtMs) ?? new Date().toISOString(),
    lastUpdatedAt: toIso(updatedAtMs) ?? toIso(createdAtMs) ?? new Date().toISOString(),
    requestCount,
    linesAdded: null,
    linesRemoved: null,
    contextUsagePercent: null,
    contextTotalTokens: latestBreakdown?.total ?? null,
    contextWindowTokens: latestBreakdown?.windowSize ?? null,
    contextBreakdown: latestBreakdown ? breakdownToObject(latestBreakdown) : null,
    parserVersion: CURSOR_PARSER_VERSION,
  };
}

// IDE composerHeaders 행 하나 → 이벤트 하나. cursorDiskKV 의 이진 blob(절대
// 토큰 breakdown)은 content-addressed 라 어느 blob 이 어느 composerId 것인지
// 연결할 근거가 없어(docs/dev/cursor/decisions.md, Phase 0b) **여기서 다루지
// 않습니다** — contextTotalTokens/contextWindowTokens/contextBreakdown 은 IDE
// 표면에서 항상 null 입니다. cwd/시각/변경 라인 수/contextUsagePercent(백분율)는
// composerHeaders 자체가 컴포저별로 주므로 그대로 씁니다.
export function parseIdeComposerHeader({ composerId, workspaceId, createdAt, lastUpdatedAt, value }) {
  let parsedValue;
  try {
    parsedValue = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    parsedValue = null;
  }
  const cwd = resolveIdeCwd(parsedValue);
  return {
    type: 'cursor_activity',
    surface: 'ide',
    composerId,
    workspaceId: workspaceId ?? null,
    cwd,
    projectName: cwd ? projectNameFromCwd(cwd) : null,
    createdAt: toIso(createdAt) ?? new Date().toISOString(),
    lastUpdatedAt: toIso(lastUpdatedAt) ?? toIso(createdAt) ?? new Date().toISOString(),
    // IDE 쪽 blob 을 composerId 에 귀속시킬 근거가 없어 요청 수는 알 수 없습니다
    // (0 이 아니라 "미확인" — 이 값을 이번 패스의 화면 어디에서도 쓰지 않는
    // 이유이기도 합니다). 스키마가 NOT NULL DEFAULT 0 이라 0 을 넣지만, 나중에
    // 이 값을 쓰는 화면을 만들 때는 surface==='ide' 행에서 반드시 "미확인"으로
    // 따로 표시해야 합니다(R7).
    requestCount: 0,
    linesAdded: Number.isFinite(parsedValue?.totalLinesAdded) ? parsedValue.totalLinesAdded : null,
    linesRemoved: Number.isFinite(parsedValue?.totalLinesRemoved) ? parsedValue.totalLinesRemoved : null,
    contextUsagePercent: Number.isFinite(parsedValue?.contextUsagePercent) ? parsedValue.contextUsagePercent : null,
    contextTotalTokens: null,
    contextWindowTokens: null,
    contextBreakdown: null,
    parserVersion: CURSOR_PARSER_VERSION,
  };
}
