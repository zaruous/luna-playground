// 비싼 턴 표의 순수 로직. 표를 그리는 컴포넌트(views/SessionTurns.jsx)와 갈라 둔
// 이유는 table-sort.js 와 같습니다 — "무엇을 담을지" 는 화면 없이 검증돼야
// 하는 계약입니다. 이 표는 두 화면(세션 흐름·프로젝트 상세)이 같이 쓰므로,
// 담는 규칙이 한쪽에서만 바뀌면 같은 세션이 두 화면에서 다르게 보입니다.

// 무엇을 담을지(토큰 상위 limit 개)만 정합니다. 어떤 순서로 세울지는 표
// 헤더가 정합니다 — 그래서 여기서 자른 목록을 sortRows 가 다시 세웁니다.
export function topTurnsOf(flow, limit = 8) {
  const turns = Array.isArray(flow?.turns) ? flow.turns : [];
  const size = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
  return [...turns]
    .sort((left, right) => (Number(right?.totalTokens) || 0) - (Number(left?.totalTokens) || 0))
    .slice(0, size);
}

// 도구 이름은 많으면 줄을 넘기므로 상위 몇 개만 적습니다. 나머지를 '+3' 처럼
// 뭉개지 않는 이유는, 이 칸이 "무엇을 많이 불렀나" 를 보는 자리이지 총 개수를
// 세는 자리가 아니기 때문입니다.
export function topTools(toolCounts, limit = 4) {
  return Object.entries(toolCounts ?? {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([name, count]) => `${name}×${count}`)
    .join(' ');
}
