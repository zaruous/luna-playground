// Codex 턴 상세 어댑터. 구조는 Claude 쪽과 같습니다 — 줄 파싱은 parser.mjs,
// 여기서 정하는 것은 파서 상태와 MCP 이름 판별뿐입니다.
import { createCodexParserState, parseCodexRolloutLine } from './parser.mjs';

// Codex 도 MCP 도구를 `mcp__<서버>__<도구>` 로 부르는 것이 관측됐습니다.
// 다만 확인한 표본이 Claude 쪽만큼 넓지 않아, 규칙에 맞지 않는 이름은 억지로
// 서버를 짜내지 않고 일반 도구로 셉니다(모르는 것은 모른다고 두는 편이
// "MCP 서버 (미상)" 한 줄보다 정직합니다).
//
// 알려진 한계: parser.mjs 의 TOOL_CALL_TYPES 는 `function_call` /
// `custom_tool_call` / `local_shell_call` / `tool_search_call` 만 셉니다.
// Codex 가 MCP 호출을 별도 레코드 타입으로 남기는 버전이 있다면 그 호출은
// 원장에도 이 화면에도 잡히지 않습니다 — 실제 로그로 확인한 뒤에 넓힙니다.
const CODEX_MCP_PATTERN = /^mcp__(.+)__([^_]+(?:_[^_]+)*)$/;

export function codexMcpToolName(name) {
  const matched = CODEX_MCP_PATTERN.exec(String(name ?? ''));
  if (!matched) return null;
  return { server: matched[1], tool: matched[2] };
}

export const codexTurnDetail = Object.freeze({
  provider: 'codex',
  supported: true,
  mcpToolName: codexMcpToolName,
  createState: ({ filePath }) => createCodexParserState({ filePath }),
  parseLine: parseCodexRolloutLine,
  // Codex 파서는 도구 **이름**만 모으고 경로는 뽑지 않습니다(payload 를 읽지
  // 않기로 한 경계). 그래서 이 provider 의 상세에는 '파일' 가지가 비어 있고,
  // 화면은 그것을 "미제공"으로 적어야 합니다 — 0개가 아니라 미측정입니다.
  filesMeasured: false,
});
