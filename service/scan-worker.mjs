import fsp from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { readCompleteLines } from './providers/jsonl-tail.mjs';
import { createCodexParserState, parseCodexRolloutLine } from './providers/codex/parser.mjs';
import { createClaudeParserState, parseClaudeTranscriptLine } from './providers/claude/parser.mjs';
import { readGeminiSessionFile } from './providers/gemini/detector.mjs';
import {
  createGeminiParserState,
  parseGeminiLogLine,
  parseGeminiSessionFile,
  withSourceOffsets,
} from './providers/gemini/parser.mjs';

// 워커는 **읽기와 해석만** 합니다. 스토어는 건드리지 않습니다.
// SQLite 연결이 메인 스레드에 하나뿐인 채로 남아야 하기 때문입니다 — 쓰기
// 주체가 여러 스레드로 갈라지면 턴 번호(세션 단위 상태)와 누적 diff 회계가
// 서로를 덮어씁니다. 그래서 비싼 쪽(JSON 파싱)만 떼어 옵니다.
//
// 전략은 두 종류이고 provider 가 아니라 **파일**이 정합니다 — Gemini 는 한
// provider 안에 둘이 섞여 있습니다(`.jsonl` 증분 로그와 `.json` 스냅샷).
//   line     줄이 뒤에만 붙는다 → 저장된 바이트 오프셋부터 이어 읽는다
//   snapshot 파일이 매번 전체 재작성된다 → 전부 다시 읽고 내용 해시로 판정
const STRATEGIES = {
  'codex:line': { kind: 'line', create: createCodexParserState, parse: parseCodexRolloutLine },
  'claude:line': { kind: 'line', create: createClaudeParserState, parse: parseClaudeTranscriptLine },
  'gemini:line': { kind: 'line', create: createGeminiParserState, parse: parseGeminiLogLine },
  'gemini:snapshot': {
    kind: 'snapshot',
    create: createGeminiParserState,
    read: readGeminiSessionFile,
    parse: parseGeminiSessionFile,
    offsets: withSourceOffsets,
  },
};

// 배치가 너무 작으면 postMessage 왕복이, 너무 크면 메인 스레드의 적재 지연과
// 메모리가 늘어납니다.
const DEFAULT_BATCH_SIZE = 256;

if (!parentPort) throw new Error('scan-worker 는 워커 스레드에서만 실행됩니다');

// 파서가 파일 끝에서 들고 있던 상태. 메인 스레드가 커서를 저장할 때 필요합니다
// (Codex 의 누적 카운터, 확정된 sessionId, 품질 통계).
function tailOf(state) {
  return {
    previousUsage: state.previousUsage ?? null,
    session: state.session ?? null,
    stats: state.stats ?? null,
  };
}

function batchSizeOf(job) {
  return Number(job.batchSize) > 0 ? Number(job.batchSize) : DEFAULT_BATCH_SIZE;
}

function postError(error) {
  parentPort.postMessage({
    type: 'error',
    message: String(error?.message ?? error),
    code: error?.code ?? null,
  });
}

async function handleLineJob(job, parser) {
  // 파서 상태는 생성 인자만으로 결정됩니다. 메인 스레드가 만든 것과 같은
  // 씨앗을 넣으면 같은 상태가 나옵니다 — 그래서 상태를 나르지 않고 씨앗을
  // 나릅니다.
  const state = parser.create({ filePath: job.filePath, ...(job.seed ?? {}) });
  const limit = batchSizeOf(job);
  let batch = [];

  const flush = () => {
    if (!batch.length) return;
    parentPort.postMessage({ type: 'batch', events: batch });
    batch = [];
  };

  const result = await readCompleteLines(job.filePath, job.startOffset ?? 0, (line, sourceOffset) => {
    for (const event of parser.parse(line, state)) {
      batch.push({ event, sourceOffset });
      if (batch.length >= limit) flush();
    }
  });
  flush();
  parentPort.postMessage({
    type: 'done',
    result: {
      finalOffset: result.finalOffset,
      fileSize: result.fileSize,
      mtimeMs: result.mtimeMs,
      truncated: result.truncated,
      tail: tailOf(state),
    },
  });
}

async function handleSnapshotJob(job, snapshot) {
  const state = snapshot.create({ filePath: job.filePath, ...(job.seed ?? {}) });
  const stat = await fsp.stat(job.filePath);
  const read = await snapshot.read(job.filePath);
  const base = {
    // 이어 읽을 지점이 없으므로 "여기까지 다 읽었다"는 뜻의 파일 크기입니다.
    finalOffset: read.byteLength,
    fileSize: read.byteLength,
    mtimeMs: stat.mtimeMs,
    truncated: false,
    contentHash: read.contentHash,
  };

  // 내용이 그대로인 재작성이면 파싱과 적재를 건너뜁니다 — 이 어댑터에서
  // 가장 비싼 단계가 JSON.parse 입니다.
  if (job.knownContentHash && job.knownContentHash === read.contentHash) {
    parentPort.postMessage({ type: 'done', result: { ...base, skippedParse: true, tail: tailOf(state) } });
    return;
  }

  const limit = batchSizeOf(job);
  let batch = [];
  for (const entry of snapshot.offsets(snapshot.parse(read.text, state))) {
    batch.push(entry);
    if (batch.length >= limit) {
      parentPort.postMessage({ type: 'batch', events: batch });
      batch = [];
    }
  }
  if (batch.length) parentPort.postMessage({ type: 'batch', events: batch });
  parentPort.postMessage({ type: 'done', result: { ...base, skippedParse: false, tail: tailOf(state) } });
}

parentPort.on('message', async (job) => {
  const key = `${job?.provider}:${job?.strategy ?? 'line'}`;
  const strategy = STRATEGIES[key];
  if (!strategy) {
    parentPort.postMessage({ type: 'error', message: `알 수 없는 스캔 전략: ${key}` });
    return;
  }
  try {
    if (strategy.kind === 'snapshot') await handleSnapshotJob(job, strategy);
    else await handleLineJob(job, strategy);
  } catch (error) {
    postError(error);
  }
});
