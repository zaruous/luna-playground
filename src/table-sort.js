// 표 헤더 클릭 정렬의 순수 로직. 컴포넌트(Bits.jsx TableHead)와 갈라 둔 이유는
// 이 규칙이 화면과 무관하게 검증돼야 하기 때문입니다 — 아래 "원본 값으로
// 정렬한다"는 계약이 깨지면 표가 조용히 거짓 순서를 보여줍니다.
//
// 정렬 기준은 **화면에 찍힌 글자가 아니라 원본 값**입니다. 이 표들의 토큰 수는
// formatTokens 를 거쳐 '4.60B' / '319.6M' / '737K' 같은 글자가 되는데, 그 글자를
// 사전순으로 세우면 319.6M 이 4.60B 보다 크다고 나옵니다. 그래서 컬럼은 자기
// 원본 값을 어떻게 꺼내는지(value)와 어떤 종류인지(type)를 같이 들고 다닙니다.
const SORT_TYPES = new Set(['number', 'text', 'time']);

function readSortValue(column, row) {
  const read = column.value ?? ((item) => item?.[column.key]);
  return read(row);
}

// 못 잰 값은 0 이 아닙니다. 0 으로 바꿔 세면 "관측 없음"이 "0 토큰"과 같은
// 자리에 섞여, 정렬이 없는 사실을 만들어냅니다(R7). 그래서 오름/내림과 무관하게
// 항상 끝으로 보냅니다.
function isMissing(value) {
  if (value == null || value === '') return true;
  return typeof value === 'number' && !Number.isFinite(value);
}

function compareValues(type, left, right) {
  if (type === 'time') {
    const a = Date.parse(left);
    const b = Date.parse(right);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (type === 'number') {
    const a = Number(left);
    const b = Number(right);
    // isMissing 이 이미 걸러 주지만, 숫자로 안 읽히는 값이 섞여 들어와도
    // 순서를 지어내지 않도록 둡니다.
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return String(left).localeCompare(String(right), 'ko-KR');
}

export function sortRows(rows, columns, sort) {
  const list = Array.isArray(rows) ? rows : [];
  if (!sort?.key) return list;
  const column = (columns ?? []).find((item) => item.key === sort.key);
  if (!column || column.sortable === false) return list;
  const type = SORT_TYPES.has(column.type) ? column.type : 'text';
  const factor = sort.direction === 'asc' ? 1 : -1;
  // 원본 배열을 제자리에서 뒤집지 않습니다 — 호출자가 준 목록은 그대로 둡니다.
  return [...list].sort((left, right) => {
    const a = readSortValue(column, left);
    const b = readSortValue(column, right);
    const missingA = isMissing(a);
    const missingB = isMissing(b);
    if (missingA && missingB) return 0;
    // 방향을 곱하기 전에 처리해야 내림차순에서도 끝에 남습니다.
    if (missingA) return 1;
    if (missingB) return -1;
    return factor * compareValues(type, a, b);
  });
}

// 숫자·시각은 큰 값·최근 값이 궁금한 열이므로 첫 클릭이 내림차순입니다.
// 이름은 반대로 가나다순이 자연스럽습니다.
export function initialDirection(column) {
  return column?.type === 'number' || column?.type === 'time' ? 'desc' : 'asc';
}

export function nextSort(columns, current, key) {
  const column = (columns ?? []).find((item) => item.key === key);
  if (!column || column.sortable === false) return current;
  if (current?.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: initialDirection(column) };
}
