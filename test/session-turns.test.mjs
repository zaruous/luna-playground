// 두 화면이 같이 쓰는 순수 규칙 두 개를 검사합니다.
//
//   1. 비싼 턴 표에 무엇을 담는지 (src/session-turns.js)
//      — 세션 흐름 화면과 프로젝트 상세의 세션 표가 같은 세션을 같은 목록으로
//        읽어야 합니다. 한쪽에서만 자르는 규칙이 바뀌면 같은 세션이 두 화면에서
//        다르게 보입니다.
//   2. 프로젝트 화면에서 무엇을 여는지 (src/project-focus.js)
//      — 이 규칙은 표시가 아니라 **쓰기 대상**을 정합니다. 별칭 저장·경로 가림이
//        열린 프로젝트에 걸리므로, 조용한 대체는 남의 프로젝트에 값을 씁니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { topTools, topTurnsOf } from '../src/session-turns.js';
import { resolveActiveProject } from '../src/project-focus.js';
import { sortRows } from '../src/table-sort.js';

const TURN_COLUMNS = [
  { key: 'turnIndex', label: '턴', type: 'number' },
  { key: 'startedAt', label: '시각', type: 'time' },
  { key: 'totalTokens', label: '토큰', type: 'number' },
];

function flowOf(...totals) {
  return { turns: totals.map((totalTokens, index) => ({ turnIndex: index + 1, totalTokens })) };
}

test('비싼 턴 목록은 토큰 상위 N개를 담는다 — 앞에서 자르지 않는다', () => {
  const flow = flowOf(10, 900, 50, 4_000, 7);
  assert.deepEqual(topTurnsOf(flow, 3).map((turn) => turn.turnIndex), [4, 2, 3]);
  // 상한보다 짧은 세션은 있는 만큼만 담습니다.
  assert.equal(topTurnsOf(flowOf(1, 2), 8).length, 2);
});

test('무엇을 담을지와 어떤 순서로 세울지는 서로 다른 규칙이다', () => {
  // 표 헤더로 정렬을 바꿔도 담긴 8개는 그대로여야 합니다 — 정렬은 뽑기가
  // 아닙니다. 그래서 topTurnsOf 로 뽑고 sortRows 로 세웁니다.
  const flow = flowOf(10, 900, 50, 4_000, 7);
  const picked = topTurnsOf(flow, 3);
  const byTurn = sortRows(picked, TURN_COLUMNS, { key: 'turnIndex', direction: 'asc' });
  assert.deepEqual(byTurn.map((turn) => turn.turnIndex), [2, 3, 4]);
  assert.deepEqual(picked.map((turn) => turn.turnIndex), [4, 2, 3], 'sortRows 는 원본 목록을 뒤집지 않는다');
});

test('흐름이 아직 없으면 빈 목록을 준다 — 지어내지 않는다', () => {
  assert.deepEqual(topTurnsOf(null), []);
  assert.deepEqual(topTurnsOf({}), []);
  assert.deepEqual(topTurnsOf({ turns: [] }), []);
});

test('도구 칸은 많이 부른 순으로 상위 몇 개만 적는다', () => {
  assert.equal(topTools({ Read: 3, Bash: 11, Edit: 7 }, 2), 'Bash×11 Edit×7');
  assert.equal(topTools(null), '');
});

test('고른 프로젝트가 검색어에 가려져도 그 프로젝트를 그대로 연다', () => {
  const list = [{ projectKey: 'aaa', name: 'alpha' }, { projectKey: 'bbb', name: 'beta' }];
  const filtered = [{ projectKey: 'bbb', name: 'beta' }];
  assert.deepEqual(
    resolveActiveProject({ list, filtered, selectedKey: 'aaa' }),
    { activeKey: 'aaa', missing: false },
  );
});

test('고른 프로젝트가 목록에 아예 없으면 다른 프로젝트로 갈아치우지 않는다', () => {
  // 세션 흐름에서 넘어온 키가 이번 달 목록에 없는 상황입니다. 예전에는 1위
  // 프로젝트를 대신 열었고, 별칭 저장이 그쪽에 걸렸습니다.
  const list = [{ projectKey: 'aaa', name: 'alpha' }];
  assert.deepEqual(
    resolveActiveProject({ list, filtered: list, selectedKey: 'zzz' }),
    { activeKey: null, missing: true },
  );
});

test('아직 아무것도 고르지 않았으면 보이는 첫 줄을 연다', () => {
  const list = [{ projectKey: 'aaa' }, { projectKey: 'bbb' }];
  assert.deepEqual(
    resolveActiveProject({ list, filtered: [{ projectKey: 'bbb' }], selectedKey: null }),
    { activeKey: 'bbb', missing: false },
  );
  assert.deepEqual(resolveActiveProject({ list: [], filtered: [], selectedKey: null }), { activeKey: null, missing: false });
});
