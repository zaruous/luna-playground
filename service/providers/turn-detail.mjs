// 턴 상세(비싼 턴 → 무엇에 썼나).
//
// 세션 흐름 화면의 "비싼 턴" 표는 턴 하나가 얼마를 썼는지까지 말합니다.
// 여기서 한 겹 더 내려가 **그 턴 안에서 무엇이 토큰을 가져갔는지**를 만듭니다:
// 채팅(도구 없는 응답) / 도구 / MCP / 파일.
//
// 세 가지 원칙을 지킵니다.
//
//  1. 본문은 읽지 않습니다. 이 모듈은 원본 로그를 **다시 열지만**, 해석은
//     provider 파서에게 맡기고 파서가 이미 내보내는 구조 메타데이터
//     (도구 이름·경로 뒷단·토큰·시각)만 씁니다. 파서가 프롬프트 텍스트를
//     내보내지 않으므로 여기서도 나올 곳이 없습니다
//     (docs/dev/menus/session.md 의 경계 표).
//  2. 저장하지 않습니다. 원장(SQLite)에는 아무것도 쓰지 않고, 요청이 올 때
//     파일을 읽어 응답만 만듭니다. 원본이 지워졌으면 상세는 없습니다 —
//     지어내지 않고 "원본 없음"으로 답합니다.
//  3. 원장과 어긋나면 어긋난다고 말합니다. 파일을 다시 읽은 합계가 원장의
//     턴 합계와 다를 수 있습니다(재개 복사본 중복 제거, 스캔 이후 추가 기록).
//     조용히 한쪽을 고르지 않고 둘 다 실어 보냅니다.
import fsp from 'node:fs/promises';
import { readCompleteLines } from './jsonl-tail.mjs';
import { promptSideTokens } from './accounting.mjs';
import { phaseOfTool } from './tool-phases.mjs';

// 응답에 싣는 메타데이터 로그의 상한. 한 턴에 요청이 수백 개인 경우가 실제로
// 있어서(실측 88요청, 그보다 긴 턴도 있음) 제한을 두고 잘렸음을 표시합니다.
export const TURN_DETAIL_RECORD_LIMIT = 400;

export const CATEGORY_LABELS = Object.freeze({
  chat: '채팅',
  tool: '도구',
  mcp: 'MCP',
  file: '파일',
});

// 파이 차트에 들어가는 범주는 서로 겹치지 않는 셋뿐입니다. 파일은 도구·MCP
// 안에서 **다시 센 것**이라 같은 원에 넣으면 합이 100%를 넘습니다.
export const PIE_CATEGORIES = Object.freeze(['chat', 'tool', 'mcp']);

function emptyBucket(key) {
  return { key, label: CATEGORY_LABELS[key] ?? key, tokens: 0, calls: 0, children: new Map() };
}

function childOf(bucket, key, label) {
  let child = bucket.children.get(key);
  if (!child) {
    child = { key, label, tokens: 0, calls: 0, children: new Map() };
    bucket.children.set(key, child);
  }
  return child;
}

function toTree(node) {
  const children = [...node.children.values()]
    .map(toTree)
    .sort((left, right) => right.tokens - left.tokens || right.calls - left.calls);
  return {
    key: node.key,
    label: node.label,
    tokens: Math.round(node.tokens),
    calls: node.calls,
    ...(node.phase ? { phase: node.phase } : {}),
    ...(children.length ? { children } : { children: [] }),
  };
}

// 경로는 파서가 이미 뒷단 두 조각으로 줄여 놓았습니다. 여기서 다시 자르지
// 않는 이유는 두 곳이 다른 규칙을 쓰면 같은 파일이 두 줄로 갈리기 때문입니다.
function addFile(files, suffix, count, toolName) {
  let entry = files.get(suffix);
  if (!entry) {
    entry = { path: suffix, calls: 0, tools: {} };
    files.set(suffix, entry);
  }
  entry.calls += count;
  // 한 요청에 도구가 여럿이면 어느 도구가 이 파일을 만졌는지 로그가 말해 주지
  // 않습니다. 억지로 나누지 않고 '(혼합)' 으로 둡니다.
  const name = toolName ?? '(혼합)';
  entry.tools[name] = (entry.tools[name] ?? 0) + count;
}

// 턴 필터. `turnIndex: null` 은 "세션 전체" 입니다 — 상세 내역 화면
// (docs/dev/menus/detail.md)이 같은 배분 규칙으로 세션 전체를 모을 때 씁니다.
// 0 은 "경계 미확인 버킷"이라는 **실제 턴 번호**이므로 null 과 구분해야 합니다.
function matchesTurn(turnIndex, eventTurn) {
  if (turnIndex == null) return true;
  return (eventTurn ?? 0) === turnIndex;
}

export function createTurnDetailBuilder({
  provider,
  turnIndex,
  recordLimit = TURN_DETAIL_RECORD_LIMIT,
  // provider 마다 MCP 도구 이름 규칙이 다릅니다. 모르는 provider 는 null 을
  // 돌려주면 되고, 그러면 그 도구는 일반 도구로 셉니다.
  mcpToolName = () => null,
} = {}) {
  const buckets = new Map();
  const files = new Map();
  const records = [];
  const seen = new Set();
  const totals = {
    totalTokens: 0, promptTokens: 0, outputTokens: 0, reasoningTokens: 0,
    requestCount: 0, toolCalls: 0,
  };
  let recordCount = 0;
  let duplicateCount = 0;

  function bucket(key) {
    let found = buckets.get(key);
    if (!found) {
      found = emptyBucket(key);
      buckets.set(key, found);
    }
    return found;
  }

  function classify(name) {
    const mcp = mcpToolName(name);
    if (mcp) return { category: 'mcp', server: mcp.server, tool: mcp.tool };
    return { category: 'tool', server: null, tool: name };
  }

  return {
    // provider 파서가 내보낸 turn 이벤트. 경계 시각과 컴팩션 표시만 씁니다.
    addTurn(event, origin) {
      if (!matchesTurn(turnIndex, event.turnIndex)) return;
      if (records.length < recordLimit) {
        records.push({
          seq: recordCount,
          kind: 'turn-start',
          at: event.startedAt ?? null,
          turnIndex: event.turnIndex ?? 0,
          file: origin.label,
          line: origin.line,
          compacted: Boolean(event.compacted),
        });
      }
      recordCount += 1;
    },

    addUsage(event, origin) {
      if (!matchesTurn(turnIndex, event.turnIndex)) return;
      // 재개 복사본은 같은 요청을 다른 파일에 다시 씁니다. 원장이 eventKey 로
      // 접는 것과 같은 기준으로 여기서도 접습니다 — 안 그러면 상세 합계만
      // 부풀어 "표는 4M 인데 상세는 8M" 이 됩니다.
      if (event.eventKey) {
        if (seen.has(event.eventKey)) { duplicateCount += 1; return; }
        seen.add(event.eventKey);
      }

      const delta = event.delta ?? {};
      const prompt = promptSideTokens(provider, delta);
      const output = Number(delta.outputTokens) || 0;
      const tokens = prompt + output;
      totals.promptTokens += prompt;
      totals.outputTokens += output;
      totals.reasoningTokens += Number(delta.reasoningTokens) || 0;
      totals.totalTokens += tokens;
      totals.requestCount += 1;

      const toolEntries = Object.entries(event.toolCounts ?? {})
        .map(([name, count]) => [name, Number(count) || 0])
        .filter(([, count]) => count > 0);
      const callSum = toolEntries.reduce((sum, [, count]) => sum + count, 0);
      totals.toolCalls += callSum;

      let category = 'chat';
      if (!callSum) {
        // 도구를 부르지 않은 요청 = 사람과 주고받은 말. 턴의 첫 응답과 마지막
        // 정리가 보통 여기 들어갑니다.
        const chat = bucket('chat');
        chat.tokens += tokens;
        childOf(chat, 'chat:reply', '도구 없는 응답').tokens += tokens;
      } else {
        // 한 요청 안에 도구가 섞이면 호출 비율로 나눕니다 — 단계별 배분과 같은
        // 규칙이고, 인과가 아니라 배분입니다.
        const share = new Map();
        for (const [name, count] of toolEntries) {
          const part = (tokens * count) / callSum;
          const kind = classify(name);
          const target = bucket(kind.category);
          target.tokens += part;
          target.calls += count;
          if (kind.category === 'mcp') {
            const server = childOf(target, `mcp:${kind.server}`, kind.server);
            server.tokens += part;
            server.calls += count;
            const tool = childOf(server, `mcp:${kind.server}:${kind.tool}`, kind.tool);
            tool.tokens += part;
            tool.calls += count;
          } else {
            const tool = childOf(target, `tool:${name}`, name);
            tool.tokens += part;
            tool.calls += count;
            tool.phase = phaseOfTool(provider, name);
          }
          share.set(kind.category, (share.get(kind.category) ?? 0) + count);
        }
        category = [...share.entries()].sort((left, right) => right[1] - left[1])[0][0];
      }

      const soleTool = toolEntries.length === 1 ? toolEntries[0][0] : null;
      for (const [suffix, count] of Object.entries(event.touchedPaths ?? {})) {
        addFile(files, suffix, Number(count) || 0, soleTool);
      }

      if (records.length < recordLimit) {
        records.push({
          seq: recordCount,
          kind: 'request',
          at: event.eventTimestamp ?? null,
          turnIndex: event.turnIndex ?? 0,
          file: origin.label,
          line: origin.line,
          category,
          model: event.session?.model ?? null,
          requestId: event.requestId ?? null,
          messageId: event.messageId ?? null,
          sidechain: Boolean(event.sidechain),
          measurementQuality: event.measurementQuality ?? null,
          tokens: {
            inputTokens: Number(delta.inputTokens) || 0,
            cachedInputTokens: Number(delta.cachedInputTokens) || 0,
            cacheWriteInputTokens: Number(delta.cacheWriteInputTokens) || 0,
            outputTokens: output,
            reasoningTokens: Number(delta.reasoningTokens) || 0,
            promptTokens: prompt,
            totalTokens: tokens,
          },
          tools: Object.fromEntries(toolEntries),
          paths: { ...(event.touchedPaths ?? {}) },
          // 도구 호출 손잡이(id + 이름). 본문이 아니라 "어느 호출인가" 를
          // 가리키는 값이고, 이것이 있어야 상세 내역 화면이 [내용 보기]로
          // 그 호출 하나만 따로 읽을 수 있습니다.
          toolCalls: (event.toolCalls ?? []).map((call) => ({ id: call.id, tool: call.tool })),
        });
      }
      recordCount += 1;
    },

    finish() {
      const pieTotal = PIE_CATEGORIES
        .reduce((sum, key) => sum + (buckets.get(key)?.tokens ?? 0), 0);
      const categories = PIE_CATEGORIES
        .filter((key) => buckets.has(key))
        .map((key) => {
          const node = toTree(buckets.get(key));
          return { ...node, pie: true, share: pieTotal > 0 ? node.tokens / pieTotal : 0 };
        })
        .sort((left, right) => right.tokens - left.tokens);

      const fileList = [...files.values()].sort((left, right) => right.calls - left.calls);
      if (fileList.length) {
        categories.push({
          key: 'file',
          label: CATEGORY_LABELS.file,
          // 파일은 도구·MCP 안에서 다시 센 것이라 토큰을 매기지 않습니다.
          // 매기면 파이의 합이 100%를 넘습니다.
          tokens: null,
          calls: fileList.reduce((sum, entry) => sum + entry.calls, 0),
          share: null,
          pie: false,
          note: '도구가 만진 파일 — 도구·MCP 안에서 다시 센 것이라 토큰은 매기지 않습니다',
          children: fileList.map((entry) => ({
            key: `file:${entry.path}`,
            label: entry.path,
            tokens: null,
            calls: entry.calls,
            tools: entry.tools,
            children: [],
          })),
        });
      }

      return {
        totals: {
          ...totals,
          totalTokens: Math.round(totals.totalTokens),
          promptTokens: Math.round(totals.promptTokens),
        },
        categories,
        files: fileList,
        records,
        recordCount,
        duplicateCount,
        truncated: recordCount > records.length,
      };
    },
  };
}

// 파일 하나를 provider 파서로 다시 훑습니다. 커서(offset)를 쓰지 않고 항상
// 처음부터 읽는 이유는 턴 번호가 **파일 처음부터 사람 프롬프트를 센 결과**라,
// 중간부터 읽으면 번호를 알 수 없기 때문입니다.
async function scanFile({ filePath, label, createState, parseLine, builder }) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    // 원본이 지워졌거나 다른 사용자의 것입니다. 지어내지 않고 건너뜁니다.
    return { path: filePath, label, exists: false, lines: 0, bytes: 0 };
  }
  const state = createState({ filePath });
  let line = 0;
  await readCompleteLines(filePath, 0, (text) => {
    line += 1;
    const origin = { label, line };
    for (const event of parseLine(text, state)) {
      if (event.type === 'usage') builder.addUsage(event, origin);
      else if (event.type === 'turn') builder.addTurn(event, origin);
    }
  });
  return { path: filePath, label, exists: true, lines: line, bytes: stat.size };
}

// provider 어댑터가 주는 것: 파서 상태 생성기와 줄 파서. 나머지 규칙(턴 필터,
// 범주 분류, 중복 제거, 상한)은 전부 공용입니다 — provider 가 늘어도 여기는
// 그대로입니다.
export async function collectTurnDetail({
  provider,
  sourcePaths = [],
  turnIndex,
  createState,
  parseLine,
  mcpToolName,
  recordLimit = TURN_DETAIL_RECORD_LIMIT,
} = {}) {
  const builder = createTurnDetailBuilder({ provider, turnIndex, recordLimit, mcpToolName });
  const scanned = [];
  for (const [index, filePath] of sourcePaths.entries()) {
    scanned.push(await scanFile({
      filePath,
      label: index === 0 ? 'main' : `file-${index}`,
      createState,
      parseLine,
      builder,
    }));
  }
  const missing = scanned.filter((file) => !file.exists).length;
  const detail = builder.finish();
  // 읽을 파일이 하나도 남아 있지 않으면 상세가 없습니다. 원장의 숫자만으로
  // 범주를 지어내지 않습니다.
  if (scanned.length && missing === scanned.length) {
    return { supported: true, available: false, reason: 'source_missing', scanned, ...detail };
  }
  if (!scanned.length) {
    return { supported: true, available: false, reason: 'no_source', scanned, ...detail };
  }
  return { supported: true, available: true, reason: null, scanned, ...detail };
}

// 아직 이 기능을 붙이지 않은 provider 의 응답. 화면이 "빈 상세"와 "미지원"을
// 구분할 수 있어야 합니다.
export function unsupportedTurnDetail(reason) {
  return {
    supported: false,
    available: false,
    reason,
    scanned: [],
    totals: {
      totalTokens: 0, promptTokens: 0, outputTokens: 0, reasoningTokens: 0,
      requestCount: 0, toolCalls: 0,
    },
    categories: [],
    files: [],
    records: [],
    recordCount: 0,
    duplicateCount: 0,
    truncated: false,
  };
}
