// Claude 턴 상세 어댑터.
//
// 파일을 다시 열지만 해석은 하지 않습니다 — 줄 파싱은 parser.mjs 를 그대로
// 부르고, 이 모듈이 정하는 것은 두 가지뿐입니다.
//
//   1) 어떤 파서 상태로 읽을 것인가 (턴 번호는 파일 처음부터 세야 나옵니다)
//   2) 도구 이름이 MCP 인가
//
// 이렇게 갈라 두면 로그 포맷이 바뀌어도 고칠 곳이 파서 한 군데입니다.
import { createClaudeParserState, parseClaudeTranscriptLine } from './parser.mjs';

// Claude 의 MCP 도구 이름은 `mcp__<서버>__<도구>` 입니다. 서버 이름 자체에
// `_` 가 들어갈 수 있으므로(`Claude_Code_Remote`) 구분자는 **두 겹 밑줄**로만
// 끊습니다 — 첫 `__` 뒤부터 마지막 `__` 앞까지가 서버입니다.
const CLAUDE_MCP_PATTERN = /^mcp__(.+)__([^_]+(?:_[^_]+)*)$/;

export function claudeMcpToolName(name) {
  const matched = CLAUDE_MCP_PATTERN.exec(String(name ?? ''));
  if (!matched) return null;
  return { server: matched[1], tool: matched[2] };
}

export const claudeTurnDetail = Object.freeze({
  provider: 'claude',
  supported: true,
  mcpToolName: claudeMcpToolName,
  createState: ({ filePath }) => createClaudeParserState({ filePath }),
  parseLine: parseClaudeTranscriptLine,
});
