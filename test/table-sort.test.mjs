import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDirection, nextSort, sortRows } from '../src/table-sort.js';
import { formatTokens, measurementPending, providerActivityLabel, tokensText, tokensOrDash, percentText, PENDING_LABEL } from '../src/shared.js';

const COLUMNS = [
  { key: 'name', label: '프로젝트', type: 'text' },
  { key: 'totalTokens', label: '토큰', type: 'number' },
  { key: 'lastActivity', label: '시각', type: 'time' },
  { key: 'reuse', label: '재독', type: 'number' },
  { key: 'go', label: '이동', sortable: false },
];

test('숫자 열은 화면 글자가 아니라 원본 값으로 정렬한다', () => {
  // 이 셋은 formatTokens 를 거치면 '4.60B' / '319.6M' / '737K' 가 됩니다.
  // 글자를 사전순으로 세우면 '319.6M' < '4.60B' < '737K' 라서 순서가 뒤집힙니다.
  const rows = [
    { name: 'b', totalTokens: 319_600_000 },
    { name: 'a', totalTokens: 4_600_000_000 },
    { name: 'c', totalTokens: 737_000 },
  ];
  assert.deepEqual(
    rows.map((row) => row.totalTokens).sort((l, r) => r - l).map(formatTokens),
    ['4.60B', '319.6M', '737K'],
    '전제 확인: 이 값들은 서로 다른 단위 접미사로 그려진다',
  );

  const desc = sortRows(rows, COLUMNS, { key: 'totalTokens', direction: 'desc' });
  assert.deepEqual(desc.map((row) => row.name), ['a', 'b', 'c']);

  const asc = sortRows(rows, COLUMNS, { key: 'totalTokens', direction: 'asc' });
  assert.deepEqual(asc.map((row) => row.name), ['c', 'b', 'a']);

  // 글자 정렬로 세웠다면 나올 순서와 실제로 달라야 합니다.
  const byText = [...rows].sort((l, r) => formatTokens(r.totalTokens).localeCompare(formatTokens(l.totalTokens)));
  assert.notDeepEqual(desc.map((row) => row.name), byText.map((row) => row.name));
});

test('못 잰 값은 오름차순에서도 내림차순에서도 끝에 남는다', () => {
  // null 을 0 으로 바꿔 세면 "관측 없음"이 "재독 0배"와 같은 자리로 섞입니다.
  const rows = [
    { name: 'a', reuse: 3 },
    { name: 'b', reuse: null },
    { name: 'c', reuse: 0 },
    { name: 'd', reuse: undefined },
  ];
  const desc = sortRows(rows, COLUMNS, { key: 'reuse', direction: 'desc' }).map((row) => row.name);
  const asc = sortRows(rows, COLUMNS, { key: 'reuse', direction: 'asc' }).map((row) => row.name);

  assert.deepEqual(desc.slice(0, 2), ['a', 'c'], '내림차순: 잰 값이 먼저');
  assert.deepEqual(new Set(desc.slice(2)), new Set(['b', 'd']), '내림차순: 못 잰 값이 끝');
  assert.deepEqual(asc.slice(0, 2), ['c', 'a'], '오름차순: 잰 값이 먼저');
  assert.deepEqual(new Set(asc.slice(2)), new Set(['b', 'd']), '오름차순에서도 못 잰 값이 끝');
});

test('시각 열은 문자열이 아니라 시각으로 비교한다', () => {
  // 같은 순간을 다른 표기로 적어도 순서가 흔들리지 않아야 합니다.
  const rows = [
    { name: 'old', lastActivity: '2026-01-02T00:00:00.000Z' },
    { name: 'new', lastActivity: '2026-08-21T09:00:00+09:00' },
    { name: 'mid', lastActivity: '2026-03-15T12:00:00.000Z' },
  ];
  assert.deepEqual(
    sortRows(rows, COLUMNS, { key: 'lastActivity', direction: 'desc' }).map((row) => row.name),
    ['new', 'mid', 'old'],
  );
});

test('정렬 불가 열과 없는 열은 순서를 건드리지 않는다', () => {
  const rows = [{ name: 'b', go: 2 }, { name: 'a', go: 1 }];
  assert.deepEqual(sortRows(rows, COLUMNS, { key: 'go', direction: 'asc' }), rows);
  assert.deepEqual(sortRows(rows, COLUMNS, { key: 'nope', direction: 'asc' }), rows);
  assert.deepEqual(sortRows(rows, COLUMNS, null), rows);
});

test('정렬은 원본 배열을 뒤집지 않는다', () => {
  const rows = [{ name: 'b', totalTokens: 1 }, { name: 'a', totalTokens: 2 }];
  const before = rows.map((row) => row.name);
  sortRows(rows, COLUMNS, { key: 'totalTokens', direction: 'desc' });
  assert.deepEqual(rows.map((row) => row.name), before);
});

test('첫 클릭 방향은 열 종류가 정하고, 같은 열을 또 누르면 뒤집힌다', () => {
  assert.equal(initialDirection({ type: 'number' }), 'desc');
  assert.equal(initialDirection({ type: 'time' }), 'desc');
  assert.equal(initialDirection({ type: 'text' }), 'asc');

  const first = nextSort(COLUMNS, { key: 'name', direction: 'asc' }, 'totalTokens');
  assert.deepEqual(first, { key: 'totalTokens', direction: 'desc' });
  assert.deepEqual(nextSort(COLUMNS, first, 'totalTokens'), { key: 'totalTokens', direction: 'asc' });
  // 정렬 불가 열을 눌러도 현재 정렬이 유지됩니다.
  assert.deepEqual(nextSort(COLUMNS, first, 'go'), first);
});

test('측정값 미도착과 관측된 0 은 다른 글자로 적는다', () => {
  // 스냅샷이 아직 없다 → 로딩
  assert.equal(measurementPending(null), true);
  // 스캔 중이고 이벤트가 하나도 없다 → 로딩 (0 이라고 단정하면 안 됨)
  assert.equal(measurementPending({ warmup: { phase: 'scanning' }, totals: { eventCount: 0 } }), true);
  // 스캔 중이지만 이미 들어온 값이 있다 → 부분값이므로 숫자를 보여준다
  assert.equal(measurementPending({ warmup: { phase: 'scanning' }, totals: { eventCount: 7 } }), false);
  // 스캔이 끝났으면 0 은 진짜 0 이다
  assert.equal(measurementPending({ warmup: { phase: 'ready' }, totals: { eventCount: 0 } }), false);

  assert.equal(tokensText(0, true), PENDING_LABEL);
  assert.equal(tokensText(0, false), '0');
  assert.equal(percentText(null, true), PENDING_LABEL);
  assert.equal(percentText(null, false), '—', '관측 없음은 로딩이 아니라 —');
  assert.equal(percentText(0, false), '0%', '잰 0% 는 — 이 아니다');
  assert.equal(tokensOrDash(0, true), PENDING_LABEL);
  assert.equal(tokensOrDash(0, false), '—');
  assert.equal(tokensOrDash(1500, false), '1.5K');
});

test('값이 0 인 이유마다 다른 문구를 적는다', () => {
  const label = (overrides) => providerActivityLabel({ periodTokens: 0, allTimeTokens: 0, ...overrides });

  // 첫 스캔이 아직 이 provider 에 닿지 않았다
  assert.equal(label({ pending: true, allTimeTokens: 999 }), '측정값 대기');
  // 이 기간 관측이 있다 → 품질 배지가 이깁니다
  assert.equal(label({ badgeLabel: '로컬 관측', periodTokens: 5 }), '로컬 관측');
  // 관측한 적은 있는데 이 기간 활동이 없다 — "관측 대기" 라고 하면 거짓입니다
  assert.equal(
    label({ periodTokens: 0, allTimeTokens: 987_546_843, measurement: 'local_observed' }),
    '이번 달 기록 없음 · 전체 987.5M',
  );
  // 기간이 이번 달이 아니면 등급이 없습니다. 값이 찍힌 행에 "관측 대기" 를
  // 적으면 거짓이므로 등급이 없다는 사실을 적습니다.
  assert.equal(
    label({ periodTokens: 1_890_000_000, allTimeTokens: 1_890_000_000, measurement: 'local_observed', gradeUnavailable: true }),
    '등급 없음',
  );
  // 등급이 없어도 값이 0 이면 등급 이야기를 하지 않습니다.
  assert.equal(
    label({ periodTokens: 0, allTimeTokens: 0, measurement: 'local_observed', gradeUnavailable: true }),
    '관측 대기',
  );
  // 한 번도 관측된 적이 없다 (어댑터는 있음)
  assert.equal(label({ measurement: 'local_observed' }), '관측 대기');
  // 어댑터 자체가 없다 → 카탈로그 상태
  assert.equal(label({ status: '준비 중' }), '준비 중');
  // measurement 가 있으면 status 보다 앞섭니다 — 어댑터가 붙은 provider 에
  // '준비 중' 을 적으면 안 됩니다.
  assert.equal(label({ measurement: 'local_observed', status: '준비 중' }), '관측 대기');
});
