const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleTokenExpiry, MAX_TIMER_DELAY } = require('../src/utils/tokenExpiry');

function clock(start = 0) {
  let time = start;
  let pending;
  const delays = [];
  let unrefs = 0;
  return {
    delays,
    get pending() { return pending; },
    get unrefs() { return unrefs; },
    options: {
      now: () => time,
      setTimer: (callback, delay) => {
        assert.ok(delay > 0 && delay <= MAX_TIMER_DELAY, 'Node must receive a supported timer delay');
        delays.push(delay);
        pending = { callback, at: time + delay, unref() { unrefs++; } };
        return pending;
      },
      clearTimer: timer => { if (timer === pending) pending = undefined; }
    },
    tick: () => {
      const next = pending;
      assert.ok(next, 'An expiry check is scheduled');
      pending = undefined;
      time = next.at;
      next.callback();
    },
    setTime: value => { time = value; }
  };
}

test('a 365-day socket session survives every bounded timer chunk and disconnects exactly at expiry', () => {
  const timers = clock();
  const deadline = 365 * 24 * 3600 * 1000;
  let disconnected = 0;
  scheduleTokenExpiry(deadline, () => { disconnected++; }, timers.options);
  assert.equal(timers.delays[0], MAX_TIMER_DELAY);
  while (timers.pending.at < deadline) {
    timers.tick();
    assert.equal(disconnected, 0);
  }
  assert.equal(timers.pending.at, deadline);
  timers.tick();
  assert.equal(disconnected, 1);
  assert.equal(timers.pending, undefined);
  assert.equal(timers.delays.reduce((sum, delay) => sum + delay, 0), deadline);
  assert.equal(timers.unrefs, timers.delays.length);
});

test('socket disconnection cancels expiry and prevents a queued callback from rescheduling', () => {
  const timers = clock();
  let disconnected = 0;
  const cancel = scheduleTokenExpiry(365 * 24 * 3600 * 1000, () => { disconnected++; }, timers.options);
  const queued = timers.pending.callback;
  cancel();
  assert.equal(timers.pending, undefined);
  queued();
  assert.equal(disconnected, 0);
  assert.equal(timers.delays.length, 1);
});

test('expiry rechecks the wall clock after a suspended process and rejects an expired deadline immediately', () => {
  const timers = clock();
  let disconnected = 0;
  scheduleTokenExpiry(365 * 24 * 3600 * 1000, () => { disconnected++; }, timers.options);
  const queued = timers.pending.callback;
  timers.setTime(366 * 24 * 3600 * 1000);
  queued();
  assert.equal(disconnected, 1);
  assert.equal(timers.delays.length, 1);

  const expired = clock(1000);
  scheduleTokenExpiry(999, () => { disconnected++; }, expired.options);
  assert.equal(disconnected, 2);
  assert.equal(expired.pending, undefined);
});
