// provider → 턴 상세 어댑터 등록표.
//
// 표를 한 곳에 두는 이유는 api-server 가 provider 이름으로 분기하지 않게
// 하려는 것입니다 — provider 가 늘어도 라우트는 그대로입니다.
import { collectTurnDetail, unsupportedTurnDetail } from './turn-detail.mjs';
import { collectSessionRecords, unsupportedSessionRecords } from './session-records.mjs';
import { claudeTurnDetail } from './claude/turn-detail.mjs';
import { codexTurnDetail } from './codex/turn-detail.mjs';
import { geminiTurnDetail } from './gemini/turn-detail.mjs';
import { cursorTurnDetail } from './cursor/turn-detail.mjs';

export const TURN_DETAIL_ADAPTERS = Object.freeze({
  claude: claudeTurnDetail,
  codex: codexTurnDetail,
  gemini: geminiTurnDetail,
  cursor: cursorTurnDetail,
});

export function turnDetailAdapter(provider) {
  return TURN_DETAIL_ADAPTERS[String(provider ?? '').toLowerCase()] ?? null;
}

export async function readTurnDetail({ provider, sourcePaths = [], turnIndex, recordLimit } = {}) {
  const adapter = turnDetailAdapter(provider);
  if (!adapter) return unsupportedTurnDetail('provider_unknown');
  if (!adapter.supported || !adapter.createState || !adapter.parseLine) {
    return unsupportedTurnDetail(adapter.reason ?? 'provider_not_implemented');
  }
  const detail = await collectTurnDetail({
    provider: adapter.provider,
    sourcePaths,
    turnIndex,
    createState: adapter.createState,
    parseLine: adapter.parseLine,
    mcpToolName: adapter.mcpToolName,
    recordLimit,
  });
  // 경로를 뽑지 않는 provider 에서 "파일 0개"는 0이 아니라 미측정입니다(R7).
  return { ...detail, filesMeasured: adapter.filesMeasured !== false };
}

// 상세 내역 화면(세션 전체 요청 행 + 도구별 토큰량). 어댑터 등록표는 턴 상세와
// **같은 것**을 씁니다 — 한 provider 를 켜고 다른 쪽만 끄는 상태가 생기면
// 화면 둘이 같은 세션을 다르게 설명합니다.
export async function readSessionRecords({ provider, sourcePaths = [], limit, order } = {}) {
  const adapter = turnDetailAdapter(provider);
  if (!adapter) return unsupportedSessionRecords('provider_unknown');
  if (!adapter.supported || !adapter.createState || !adapter.parseLine) {
    return unsupportedSessionRecords(adapter.reason ?? 'provider_not_implemented');
  }
  const records = await collectSessionRecords({
    provider: adapter.provider,
    sourcePaths,
    createState: adapter.createState,
    parseLine: adapter.parseLine,
    mcpToolName: adapter.mcpToolName,
    limit,
    order,
  });
  return { ...records, filesMeasured: adapter.filesMeasured !== false };
}
