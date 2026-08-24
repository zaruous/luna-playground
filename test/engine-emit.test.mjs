import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrailingEmitThrottle } from '../service/engine.mjs';

test('ready 스로틀은 창 안의 연속 갱신을 줄이고 trailing 으로 마지막 값을 낸다', () => {
  let clock = 1000;
  const timers = [];
  const throttle = createTrailingEmitThrottle({
    intervalMs: 100,
    now: () => clock,
    schedule: (fn, delayMs) => {
      const entry = { fn, at: clock + delayMs };
      timers.push(entry);
      return timers.length;
    },
    cancelTimer: () => {},
  });

  const emits = [];
  throttle.request(() => emits.push('first'));
  assert.deepEqual(emits, ['first'], '유휴 직후 첫 갱신은 즉시 나갑니다');

  clock = 1010;
  throttle.request(() => emits.push('second'));
  throttle.request(() => emits.push('third'));
  assert.deepEqual(emits, ['first'], '창 안의 중간 갱신은 묶입니다');
  assert.ok(timers.length >= 1, 'trailing emit 이 한 번 예약됩니다');

  clock = timers.at(-1).at;
  timers.at(-1).fn();
  assert.deepEqual(emits, ['first', 'third'], 'trailing emit 은 마지막 콜백만 실행합니다');
});

test('ready 스로틀은 간격이 지난 뒤 다시 즉시 emit 한다', () => {
  let clock = 0;
  const throttle = createTrailingEmitThrottle({
    intervalMs: 50,
    now: () => clock,
    schedule: (fn, delayMs) => {
      clock += delayMs;
      fn();
      return 1;
    },
    cancelTimer: () => {},
  });

  const emits = [];
  throttle.request(() => emits.push('a'));
  throttle.request(() => emits.push('b'));
  assert.deepEqual(emits, ['a', 'b']);
});
