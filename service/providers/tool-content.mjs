// 도구 호출 **내용** 열람 (상세 내역 화면의 [내용 보기]).
//
// 이 저장소에서 대화 본문에 닿는 **유일한 경로**입니다. 그래서 다른 모듈과
// 반대의 규칙을 지킵니다 — 나머지 전부가 "본문을 읽지 않는다" 라면, 여기는
// "본문을 읽되 다음 조건에서만" 입니다(docs/dev/menus/detail.md).
//
//   1. 사람이 [내용 보기]를 눌렀을 때만 불립니다. 목록·집계 응답에는 본문이
//      없고, 화면이 목록을 그리면서 미리 당기지도 않습니다.
//   2. 요청한 tool_use_id **하나**의 input·결과만 담습니다. 파일 전체나
//      다른 호출은 나가지 않습니다.
//   3. 아무것도 저장하지 않습니다 — 원장에도, 캐시에도. 읽어서 응답만
//      만들고 버립니다.
//   4. 파서를 타지 않습니다. 파서가 내보내는 이벤트에는 여전히 본문이 없어야
//      하므로, 이 리더는 원본 레코드를 직접 열어 필요한 블록만 꺼냅니다.
//
// 크기 상한이 있는 이유는 실측입니다 — 도구 결과 하나가 수 MB 인 로그가
// 실제로 있습니다(Codex 세션 파일이 GB 로 붇는 원인이 이것입니다). 상한을
// 넘으면 앞부분만 싣고 잘렸다고 적습니다. 조용히 자르면 사람이 "결과가
// 이게 전부" 라고 읽습니다.
import fsp from 'node:fs/promises';
import { readCompleteLines } from './jsonl-tail.mjs';

export const TOOL_CONTENT_LIMIT_BYTES = 256 * 1024;

// 문자열이 아닌 값(도구 input 객체, 블록 배열)은 JSON 으로 폅니다. 읽기 좋게
// 들여쓰되, 상한을 넘기면 자릅니다.
function stringify(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

// tool_result 의 content 는 문자열이거나 블록 배열입니다. 배열이면 텍스트
// 블록만 이어 붙이고, 텍스트가 아닌 블록(이미지 등)은 종류만 적습니다 —
// 이미지 바이트를 base64 로 실어 보내면 상한이 의미가 없어집니다.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringify(content);
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (block?.type === 'text' && typeof block.text === 'string') { parts.push(block.text); continue; }
    parts.push(`[${block?.type ?? 'unknown'} 블록 — 본문 대신 종류만 표시]`);
  }
  return parts.join('\n');
}

// 자를 때는 **바이트** 기준입니다. 문자수로 자르면 한글이 섞인 로그에서 상한을
// 세 배까지 넘깁니다. 잘린 자리에서 UTF-8 시퀀스가 갈라지지 않도록 Buffer 로
// 자른 뒤 되돌립니다.
export function capText(text) {
  if (typeof text !== 'string') return { content: null, chars: 0, bytes: 0, truncated: false };
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= TOOL_CONTENT_LIMIT_BYTES) {
    return { content: text, chars: text.length, bytes: buffer.length, truncated: false };
  }
  const clipped = buffer.subarray(0, TOOL_CONTENT_LIMIT_BYTES).toString('utf8').replace(/�$/, '');
  return { content: clipped, chars: text.length, bytes: buffer.length, truncated: true };
}

// Claude transcript 에서 한 호출의 input 과 결과를 꺼냅니다.
//
// 결과는 두 곳에 저장돼 있습니다 — `toolUseResult`(도구가 낸 원본)와
// `message.content[].tool_result`(모델에 되먹인 것). **뒤엣것**을 읽습니다:
// 앞엣것은 잘리기 전 원본이라 모델이 실제로 본 것과 다를 수 있고, 이 화면의
// 질문은 "모델이 무엇을 받았길래 토큰이 늘었나" 이기 때문입니다.
function claudeToolContent(record, toolUseId) {
  const blocks = Array.isArray(record?.message?.content) ? record.message.content : [];
  if (record?.type === 'assistant') {
    for (const block of blocks) {
      if (block?.type === 'tool_use' && String(block.id) === toolUseId) {
        return {
          kind: 'input',
          tool: block.name ?? null,
          at: record.timestamp ?? null,
          text: stringify(block.input),
        };
      }
    }
    return null;
  }
  if (record?.type === 'user') {
    for (const block of blocks) {
      if (block?.type === 'tool_result' && String(block.tool_use_id) === toolUseId) {
        return {
          kind: 'result',
          at: record.timestamp ?? null,
          isError: Boolean(block.is_error),
          text: resultText(block.content),
        };
      }
    }
  }
  return null;
}

export const TOOL_CONTENT_ADAPTERS = Object.freeze({
  claude: { supported: true, extract: claudeToolContent },
  // 아래 셋은 "빈 내용" 이 아니라 미지원입니다. Codex 는 function_call /
  // function_call_output 이 call_id 로 이어지는 것을 웹 자료로만 확인했고
  // 실물 로그로 재보지 않았습니다 — 반쯤 맞는 화면을 보여 주지 않습니다.
  codex: { supported: false, reason: 'provider_unverified' },
  gemini: { supported: false, reason: 'provider_not_implemented' },
  cursor: { supported: false, reason: 'provider_has_no_turns' },
});

export function toolContentAdapter(provider) {
  return TOOL_CONTENT_ADAPTERS[String(provider ?? '').toLowerCase()] ?? null;
}

function unavailable(reason, supported = false) {
  return {
    supported,
    available: false,
    reason,
    tool: null,
    at: null,
    turnIndex: null,
    input: null,
    result: null,
    source: null,
  };
}

// 파일들을 훑어 그 호출의 input 과 결과를 찾습니다. 찾으면 **즉시 멈추지
// 않는** 이유는 결과가 input 보다 뒤에 오기 때문입니다 — 둘 다 찾으면 멈춥니다.
export async function readToolCallContent({ provider, sourcePaths = [], toolUseId } = {}) {
  const adapter = toolContentAdapter(provider);
  if (!adapter) return unavailable('provider_unknown');
  if (!adapter.supported) return unavailable(adapter.reason ?? 'provider_not_implemented');

  const wanted = String(toolUseId ?? '').trim();
  if (!wanted) return unavailable('tool_call_not_specified', true);

  let found = null;
  let missingFiles = 0;
  for (const filePath of sourcePaths) {
    try {
      await fsp.stat(filePath);
    } catch {
      // 원본이 지워졌거나 다른 사용자의 것입니다. 지어내지 않고 건너뜁니다.
      missingFiles += 1;
      continue;
    }
    let line = 0;
    let stop = false;
    await readCompleteLines(filePath, 0, (text) => {
      if (stop || !text?.trim()) return;
      line += 1;
      let record;
      try { record = JSON.parse(text); } catch { return; }
      const hit = adapter.extract(record, wanted);
      if (!hit) return;
      found ??= { tool: null, at: null, input: null, result: null, path: filePath, line: null, isError: false };
      if (hit.kind === 'input') {
        found.tool = hit.tool ?? found.tool;
        found.at = hit.at ?? found.at;
        found.input = capText(hit.text);
        found.line = line;
      } else {
        found.result = capText(hit.text);
        found.isError = hit.isError;
      }
      if (found.input && found.result) stop = true;
    });
    if (stop) break;
  }

  if (!found) {
    return unavailable(missingFiles === sourcePaths.length && sourcePaths.length ? 'source_missing' : 'tool_call_not_found', true);
  }
  return {
    supported: true,
    available: true,
    reason: null,
    tool: found.tool,
    at: found.at,
    isError: found.isError,
    input: found.input,
    // 결과가 없는 호출도 있습니다 — 사람이 중단했거나 도구가 아직 안 돌아온
    // 경우입니다. 빈 문자열로 채우면 "결과가 비었다" 로 읽히므로 null 로 둡니다.
    result: found.result,
    source: { path: found.path, line: found.line },
  };
}
