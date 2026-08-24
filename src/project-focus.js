// 프로젝트 화면에서 "지금 열려 있는 프로젝트" 를 정하는 규칙.
//
// 화면(views/ProjectView.jsx)과 갈라 둔 이유는 table-sort.js 와 같습니다 — 이
// 규칙은 표시가 아니라 **쓰기 대상**을 정합니다. 별칭 저장·경로 가림 버튼이
// 열린 프로젝트에 걸리므로, 고른 프로젝트를 조용히 다른 프로젝트로 갈아치우면
// 라벨이 틀리는 정도가 아니라 남의 프로젝트에 값을 씁니다.
//
// 그래서 계약은 둘입니다.
//   1. 고른 프로젝트가 목록에 있으면 **반드시 그것**을 연다 — 검색어에
//      가려졌더라도 마찬가지다. 검색은 왼쪽 목록을 좁히는 손잡이이고,
//      선택을 옮기는 손잡이가 아니다.
//   2. 목록에 아예 없으면 아무것도 열지 않고(missing) 그렇게 적는다.
export function resolveActiveProject({ list = [], filtered = null, selectedKey = null } = {}) {
  const all = Array.isArray(list) ? list : [];
  const visible = Array.isArray(filtered) ? filtered : all;
  if (selectedKey == null) {
    // 아직 아무것도 고르지 않았으면 보이는 첫 줄을 엽니다 — 사람이 고른 값을
    // 밀어내는 것이 아니므로 이 자리에서는 대체가 아닙니다.
    return { activeKey: visible[0]?.projectKey ?? null, missing: false };
  }
  if (all.some((project) => project?.projectKey === selectedKey)) {
    return { activeKey: selectedKey, missing: false };
  }
  return { activeKey: null, missing: true };
}
