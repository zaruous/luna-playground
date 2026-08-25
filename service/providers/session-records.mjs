// 상세 내역(프로젝트 → 세션 → 도구, 토큰량).
//
// 턴 상세가 "턴 하나가 무엇에 썼나" 를 답한다면, 여기는 **세션 전체**를 같은
// 규칙으로 모읍니다(docs/dev/menus/detail.md). 새 회계 규칙을 만들지 않는 것이
// 이 모듈의 핵심입니다 — 배분·중복 제거·범주 분류는 전부 turn-detail 의
// 빌더를 그대로 부르고, 여기서 더하는 것은 셋뿐입니다.
//
//   1. 턴 필터를 풀어 세션 전체를 담는다 (turnIndex: null)
//   2. 요청 행을 비용순/시간순으로 세우고 상한만큼 자른다
//   3. 자른 사실을 응답에 적는다 — 조용히 자르면 "뭐가 많았나" 의 답이 가려집니다
//
// 본문은 여기서도 읽지 않습니다. 도구 호출의 **본문**은 사람이 [내용 보기]를
// 눌렀을 때 tool-content.mjs 가 그 호출 하나만 따로 읽습니다.
import { collectTurnDetail, unsupportedTurnDetail } from './turn-detail.mjs';

// 화면이 고를 수 있는 행 수. 서버와 화면이 **같은 목록**을 봐야 "100행을 골랐는데
// 서버는 400행을 줬다" 가 생기지 않습니다.
export const ROW_LIMITS = Object.freeze([20, 50, 100, 1000]);
export const DEFAULT_ROW_LIMIT = 100;

// 비용순 정렬은 전체를 본 뒤에야 상위 N 을 고를 수 있습니다. 그래서 수집
// 단계의 상한은 표시 상한(최대 1000)보다 훨씬 큽니다. 그래도 무한은 아닙니다 —
// 요청이 수만 건인 세션에서 응답을 만들다 메모리를 다 쓰면 화면이 아니라
// 서비스가 죽습니다.
export const MAX_COLLECT_RECORDS = 20_000;

export const RECORD_ORDERS = Object.freeze(['cost', 'time']);

// 상한 밖의 값을 조용히 받아 주면 화면과 서버가 다른 것을 보게 됩니다.
export function normalizeRowLimit(value) {
  const requested = Number(value);
  return ROW_LIMITS.includes(requested) ? requested : DEFAULT_ROW_LIMIT;
}

export function normalizeOrder(value) {
  const requested = String(value ?? '').toLowerCase();
  return RECORD_ORDERS.includes(requested) ? requested : 'cost';
}

function recordCost(row) {
  return Number(row?.tokens?.totalTokens) || 0;
}

// 시간순은 오름차순(대화 순서), 비용순은 내림차순(큰 것부터)입니다.
// 동률은 seq 로 끊습니다 — 정렬이 안정적이지 않으면 같은 데이터인데도
// 새로고침마다 행 순서가 뒤바뀝니다.
function orderRecords(records, order) {
  const rows = [...records];
  if (order === 'time') {
    rows.sort((left, right) => {
      const a = Date.parse(left.at ?? '');
      const b = Date.parse(right.at ?? '');
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
      return left.seq - right.seq;
    });
    return rows;
  }
  rows.sort((left, right) => recordCost(right) - recordCost(left) || left.seq - right.seq);
  return rows;
}

// 도구별 토큰량. 턴 상세의 범주 트리(채팅 / 도구 / MCP / 파일)를 그대로 씁니다 —
// 같은 배분 규칙이므로 "세션 화면과 턴 화면의 도구 비중이 다르다" 가 생기지
// 않습니다. 파일 가지는 토큰을 매기지 않으므로(도구 안에서 다시 센 것) 여기서도
// 그대로 둡니다.
function toolBreakdownOf(categories) {
  return categories.map((row) => ({
    key: row.key,
    label: row.label,
    tokens: row.tokens,
    calls: row.calls,
    share: row.share ?? null,
    pie: Boolean(row.pie),
    children: row.children ?? [],
    ...(row.note ? { note: row.note } : {}),
  }));
}

export async function collectSessionRecords({
  provider,
  sourcePaths = [],
  createState,
  parseLine,
  mcpToolName,
  limit = DEFAULT_ROW_LIMIT,
  order = 'cost',
} = {}) {
  const rowLimit = normalizeRowLimit(limit);
  const rowOrder = normalizeOrder(order);
  // 턴 필터 없이(turnIndex: null) 세션 전체를 담습니다.
  const detail = await collectTurnDetail({
    provider,
    sourcePaths,
    turnIndex: null,
    createState,
    parseLine,
    mcpToolName,
    recordLimit: MAX_COLLECT_RECORDS,
  });

  // 표는 요청 행만 세웁니다. 턴 경계 표시는 행이 아니라 요청의 turnIndex 로
  // 이미 나타나므로, 표에 섞으면 정렬할 수 없는 줄이 끼어듭니다.
  const requests = detail.records.filter((row) => row.kind === 'request');
  const ordered = orderRecords(requests, rowOrder);
  const shown = ordered.slice(0, rowLimit);

  return {
    supported: detail.supported,
    available: detail.available,
    reason: detail.reason,
    totals: detail.totals,
    toolBreakdown: toolBreakdownOf(detail.categories),
    files: detail.files,
    records: shown,
    // recordCount 는 **잘리기 전 전체 요청 수**입니다. 화면이 "N행 / 전체 M행"
    // 을 적을 수 있어야 잘림이 답을 가리지 않습니다.
    recordCount: requests.length,
    duplicateCount: detail.duplicateCount,
    truncated: requests.length > shown.length,
    // 수집 자체가 상한에 걸린 경우. 위 truncated(표시 상한)와 다른 사실이라
    // 한 칸에 뭉뚱그리지 않습니다 — 이쪽이 켜지면 합계도 전체가 아닙니다.
    collectionTruncated: detail.truncated,
    limit: rowLimit,
    order: rowOrder,
    scanned: detail.scanned,
    filesMeasured: detail.filesMeasured ?? true,
  };
}

// 아직 붙이지 않은 provider 의 응답. 화면이 "빈 세션"과 "미지원"을 구분할 수
// 있어야 합니다 — 턴 상세와 같은 이유, 같은 모양입니다.
export function unsupportedSessionRecords(reason) {
  const base = unsupportedTurnDetail(reason);
  return {
    supported: base.supported,
    available: base.available,
    reason: base.reason,
    totals: base.totals,
    toolBreakdown: [],
    files: [],
    records: [],
    recordCount: 0,
    duplicateCount: 0,
    truncated: false,
    collectionTruncated: false,
    limit: DEFAULT_ROW_LIMIT,
    order: 'cost',
    scanned: [],
    filesMeasured: true,
  };
}
