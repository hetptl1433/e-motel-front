const MAX_TIMER_DELAY = 2 ** 31 - 1;

// Node clamps larger delays to 1 ms. Recheck the deadline in bounded chunks so
// a long-lived session stays connected and still expires at its actual expiry.
function scheduleTokenExpiry(expiresAt, onExpire, {
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let timer;
  let cancelled = false;
  const check = () => {
    if (cancelled) return;
    const remaining = expiresAt - now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      cancelled = true;
      onExpire();
      return;
    }
    timer = setTimer(check, Math.min(remaining, MAX_TIMER_DELAY));
    timer.unref?.();
  };
  check();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimer(timer);
  };
}

module.exports = { scheduleTokenExpiry, MAX_TIMER_DELAY };
