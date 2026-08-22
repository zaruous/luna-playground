// 냥코멘트.
//
// 이 문구는 장식이 아니라 상태를 말하는 문장이고, 화면이 그중 하나를 **무작위로**
// 고릅니다. 그래서 "고른 하나"를 검사하면 안 됩니다 — 검사에서 빠진 변형이 어느 날
// 화면에 떠서 사실이 아닌 말을 하게 됩니다. 아래 단정은 전부 **모든 변형**에 겁니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { catComments, catCommentPayload, generalComments } from '../service/cat-comments.mjs';

const STATES = ['UNATTRIBUTED_SERVER_USAGE', 'LOCAL_AHEAD_OF_SERVER', 'SYNCED', null, 'UNKNOWN_STATUS'];

test('상태마다 여러 표현이 있고 모두 제목과 본문을 갖춘다', () => {
  let total = 0;
  for (const status of STATES) {
    for (const name of ['Codex', null]) {
      const list = catComments(status, name);
      assert.ok(list.length >= 3, `${status}/${name} 는 표현이 여럿이어야 합니다`);
      total += list.length;
      for (const item of list) {
        assert.ok(item.title && item.title.length > 2, '제목이 있어야 합니다');
        assert.ok(item.body && item.body.length > 10, '본문이 있어야 합니다');
        assert.match(item.title, /냥/, '냥코멘트 제목은 고양이 말투입니다');
      }
    }
  }
  assert.ok(total >= 20, `표현이 충분히 있어야 합니다 (지금 ${total}개)`);
});

test('자기 이름이 아닌 provider 를 대신 말하지 않는다 — 모든 변형', () => {
  for (const item of catComments('UNATTRIBUTED_SERVER_USAGE', 'Cursor')) {
    assert.match(item.body, /로컬 Cursor 로그/, '주인을 본문에 밝혀야 합니다');
    assert.doesNotMatch(`${item.title} ${item.body}`, /Codex|rollout/);
  }
  for (const item of catComments('SYNCED', 'Cursor')) {
    assert.match(item.title, /^Cursor /, 'SYNCED 제목은 주인 이름으로 시작합니다');
  }
});

test('이름을 못 받았으면 지어내지 않고 문장에서 뺀다', () => {
  for (const item of catComments(null, null)) {
    assert.doesNotMatch(`${item.title} ${item.body}`, /Codex|rollout/);
    assert.doesNotMatch(item.title, /provider|프로바이더/, '제목에 빈 자리를 남기지 않습니다');
  }
});

test('올 snapshot 이 없는데 "들어오면 대조합니다" 라고 약속하지 않는다', () => {
  // 이름이 없다 == 서버 원장을 주는 provider 가 하나도 없다. 그 상태에서
  // "snapshot 이 들어오면" 은 지킬 수 없는 약속입니다.
  for (const item of catComments(null, null)) {
    assert.doesNotMatch(item.body, /들어오면/);
    assert.match(item.body, /서버 한도 원장을 주는 곳이 없어요/);
  }
  // 이름이 있으면 snapshot 이 올 수 있으므로 그때는 약속해도 됩니다.
  for (const item of catComments(null, 'Codex')) {
    assert.match(item.body, /snapshot이 들어오면/);
  }
});

test('알 수 없는 상태는 관측 중 문구로 떨어지고 던지지 않는다', () => {
  const list = catComments('SOMETHING_NEW', 'Codex');
  assert.ok(list.length >= 3);
  for (const item of list) assert.match(item.body, /snapshot이 들어오면/);
});

test('payload 는 서버 원장을 가진 provider 것만 먹인다', () => {
  const snapshot = {
    providers: [
      // 원장이 없는 provider 가 먼저 와도 이쪽을 잡으면 안 됩니다 — Claude 데이터
      // 위에 Codex 의 대조 서사를 얹게 됩니다.
      { id: 'claude', name: 'Claude', integration: 'connected', capabilities: { serverQuota: false }, reconciliation: { status: 'SYNCED' } },
      { id: 'codex', name: 'Codex', integration: 'connected', capabilities: { serverQuota: true }, reconciliation: { status: 'LOCAL_AHEAD_OF_SERVER' } },
    ],
  };
  const payload = catCommentPayload(snapshot);
  assert.equal(payload.status, 'LOCAL_AHEAD_OF_SERVER');
  assert.equal(payload.provider.id, 'codex');
  assert.ok(payload.comments.length >= 3);
  // 사칭 금지는 **대조 서사**에 거는 단정입니다. 일반 문구는 회계를 설명하느라
  // 세 provider 를 예로 들 수 있고 그건 사칭이 아닙니다.
  for (const item of payload.comments.filter((c) => c.scope === 'status')) {
    assert.doesNotMatch(`${item.title} ${item.body}`, /Claude/);
  }
});

test('연결되지 않은 provider 는 원장 주인이 될 수 없다', () => {
  const payload = catCommentPayload({
    providers: [{ id: 'cursor', name: 'Cursor', integration: 'planned', capabilities: { serverQuota: true } }],
  });
  assert.equal(payload.provider, null, '준비 중인 provider 의 서사를 말하면 안 됩니다');
  for (const item of payload.comments.filter((c) => c.scope === 'status')) {
    assert.match(item.body, /서버 한도 원장을 주는 곳이 없어요/);
  }
});

test('스냅샷이 비어도 던지지 않는다', () => {
  for (const input of [null, {}, { providers: [] }]) {
    const payload = catCommentPayload(input);
    assert.equal(payload.provider, null);
    assert.ok(payload.comments.length >= 3);
  }
});

test('화면이 고를 수 있는 문구가 열 개다', () => {
  const payload = catCommentPayload({
    providers: [{ id: 'codex', name: 'Codex', integration: 'connected', capabilities: { serverQuota: true }, reconciliation: { status: 'SYNCED' } }],
  });
  assert.equal(payload.comments.length, 10, '상태별 3개 + 항상 참인 7개');
  // 제목이 겹치면 무작위로 골라도 같은 걸 본 것처럼 느껴집니다.
  assert.equal(new Set(payload.comments.map((c) => c.title)).size, 10, '제목이 모두 달라야 합니다');
});

test('항상 참인 문구는 대조 상태를 주장하지 않는다', () => {
  // 이 문구들은 어느 상태에서든 뜨므로, 서버-로컬 대조 결과를 말하면 안 됩니다.
  for (const item of generalComments()) {
    assert.doesNotMatch(item.body, /대조했|일치했|앞서 있|움직였지만/,
      `"${item.title}" 이 대조 결과를 주장합니다`);
    assert.equal(item.scope, 'general');
    // 이름을 예로 드는 것은 됩니다. 금지는 **그 provider 의 지금 상태**를 말하는 것입니다.
    assert.doesNotMatch(item.body, /Codex 의 서버|Claude 의 서버|지금 .*대조/,
      `"${item.title}" 이 특정 provider 의 현재 상태를 말합니다`);
  }
});

test('항상 참인 문구는 어느 상태에서도 함께 나온다', () => {
  const seen = new Set();
  for (const status of ['SYNCED', 'LOCAL_AHEAD_OF_SERVER', 'UNATTRIBUTED_SERVER_USAGE', null]) {
    const payload = catCommentPayload({
      providers: status === null ? [] : [{ id: 'codex', name: 'Codex', integration: 'connected', capabilities: { serverQuota: true }, reconciliation: { status } }],
    });
    assert.ok(payload.comments.length >= 10, `${status} 에서도 열 개 이상`);
    for (const item of generalComments()) {
      assert.ok(payload.comments.some((c) => c.title === item.title), `${status} 에 "${item.title}" 이 빠졌습니다`);
      seen.add(item.title);
    }
  }
  assert.equal(seen.size, generalComments().length);
});
