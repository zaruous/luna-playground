// Cursor 턴 상세 어댑터 — **템플릿입니다. 원본에 정보가 없습니다.**
//
// 다른 provider 와 달리 이것은 "아직 안 만들었다"가 아니라 "만들 근거가
// 없다" 쪽입니다. Cursor Admin API 는 이벤트 단위 집계만 주고 대화 구조를
// 주지 않습니다 — 턴도, 도구 호출 이름도, 파일 경로도 없습니다
// (docs/dev/menus/session.md 의 provider 별 턴 경계 표에서 Cursor 는 "불가").
// 그래서 상세를 만들 수 없고, 화면은 그것을 결함이 아니라 사실로 적어야
// 합니다.
//
// TODO(cursor/turn-detail): 아래 둘 중 하나가 사실로 바뀌면 다시 봅니다.
//
//  1. 로컬 로그. Cursor 가 대화 구조를 담은 로컬 파일을 남기는 경로가
//     확인되면(다른 provider 처럼 JSONL 이라면 공용 스캐너를 그대로 씁니다),
//     createState/parseLine 을 채우고 supported 를 올립니다. 이때도 턴 경계가
//     사람 프롬프트와 1:1 인지 실측이 먼저입니다.
//
//  2. Admin API 확장. 집계에 도구·요청 단위 내역이 추가되면, 파일을 읽는 대신
//     그 응답을 같은 범주(채팅/도구/MCP/파일)로 접는 어댑터를 여기 둡니다.
//     그 경우 collectTurnDetail 대신 API 응답을 builder 에 밀어 넣는 형태가
//     됩니다 — turn-detail.mjs 의 createTurnDetailBuilder 는 그대로 재사용할
//     수 있게 파일 읽기와 분리해 두었습니다.
//
// 둘 다 아니라면 이 파일은 이대로 두는 것이 맞습니다.

// TODO(cursor/turn-detail): 위 1번이 확인되면 실제 규칙으로 채웁니다.
export function cursorMcpToolName() {
  return null;
}

export const cursorTurnDetail = Object.freeze({
  provider: 'cursor',
  supported: false,
  reason: 'provider_has_no_turns',
  mcpToolName: cursorMcpToolName,
  createState: null,
  parseLine: null,
});
