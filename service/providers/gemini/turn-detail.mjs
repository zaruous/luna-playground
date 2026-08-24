// Gemini 턴 상세 어댑터 — **템플릿입니다. 아직 켜지 않았습니다.**
//
// 골격만 Claude·Codex 와 같은 모양으로 두고, 실제 연결은 아래 TODO 를 확인한
// 뒤에 합니다. 반쯤 맞는 상세를 내보내는 것보다 "미지원"이라고 말하는 편이
// 이 화면의 규칙에 맞습니다(측정하지 않은 것을 화면이 말하지 않는다).
//
// TODO(gemini/turn-detail): 아래 넷을 실제 로그로 확인하고 켭니다.
//
//  1. 파일 형태. Claude·Codex 는 줄 단위 JSONL 이라 공용 스캐너
//     (turn-detail.mjs 의 readCompleteLines)가 그대로 듭니다. Gemini 는
//     `.json` 전체 스냅샷과 `.jsonl` 이 섞여 있습니다(collector.mjs 참고).
//     `.json` 쪽은 줄 스캐너로 읽을 수 없으므로, collectTurnDetail 에
//     "파일 하나를 통째로 파싱하는" 경로를 하나 더 열거나 이 어댑터가
//     자체 스캐너를 들고 있어야 합니다. 어느 쪽인지부터 정합니다.
//
//  2. 턴 경계. parser.mjs 는 turnIndex 를 이미 매기고 있지만, 그 경계가
//     사람 프롬프트와 1:1 인지 실측으로 확인된 적이 없습니다
//     (docs/dev/menus/session.md 의 provider 별 턴 경계 표에서 Gemini 는
//     여전히 "미확인"입니다). 경계가 틀리면 상세 전체가 엉뚱한 턴을 봅니다.
//
//  3. MCP 이름 규칙. Claude·Codex 는 `mcp__<서버>__<도구>` 를 씁니다.
//     Gemini CLI 의 MCP 도구 이름이 같은 모양인지 확인하고, 다르면 아래
//     geminiMcpToolName 을 그 규칙으로 채웁니다. 확인 전까지 전부 일반
//     도구로 세는 것이 안전합니다(없는 서버 이름을 지어내지 않습니다).
//
//  4. 파일 경로. tool-phases.mjs 주석대로 Gemini 도구 어휘에는 MCP·프로젝트
//     전용 이름이 섞여 있습니다. 파서가 touchedPaths 를 채우는지, 채운다면
//     Claude 와 같은 "뒷단 두 조각" 규칙인지 맞춰야 표가 갈라지지 않습니다.
//
// 켤 때는 이 파일에서 supported 를 true 로 올리고 createState/parseLine 을
// gemini/parser.mjs 에 연결한 뒤, test/turn-detail.test.mjs 에 Claude·Codex 와
// 같은 픽스처 테스트를 추가합니다.

// TODO(gemini/turn-detail): 위 3번을 확인한 뒤 실제 규칙으로 채웁니다.
export function geminiMcpToolName() {
  return null;
}

export const geminiTurnDetail = Object.freeze({
  provider: 'gemini',
  supported: false,
  // 화면이 그대로 보여 줄 수 있는 이유 문자열입니다. api-server 가 reason 을
  // 그대로 싣고, 화면은 reason 별 문구를 고릅니다.
  reason: 'provider_not_implemented',
  mcpToolName: geminiMcpToolName,
  // TODO(gemini/turn-detail): `.json` 스냅샷도 읽을 수 있게 된 뒤 연결합니다.
  //   createState: ({ filePath }) => createGeminiParserState({ filePath }),
  //   parseLine: parseGeminiLine,
  createState: null,
  parseLine: null,
});
