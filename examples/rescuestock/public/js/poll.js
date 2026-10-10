// Polling for a request page whose status is still changing. Every 2 s while the status is transient, backing off
// to 10 s after 2 minutes, and paused while the page is hidden. Timers and the visibility test are injected.

export const POLL_FAST_MS = 2000;
export const POLL_SLOW_MS = 10000;
export const POLL_BACKOFF_AFTER_MS = 120000;

const TRANSIENT_RESCUE_STATUSES = Object.freeze(['stock_reserved', 'payment_authorized', 'cancelling', 'refunding', 'replanning']);

// RequestView -> bool: true while something is about to change by itself.
export function isTransient(view) {
  if (!view || typeof view !== 'object') return false;
  if (TRANSIENT_RESCUE_STATUSES.includes(view.rescueStatus?.status)) return true;
  const current = Array.isArray(view.plans) ? view.plans.find((p) => p.id === view.currentPlanId) : null;
  return current?.status === 'executing';
}

export function nextDelay(elapsedMs) {
  return elapsedMs >= POLL_BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS;
}

/**
 * createPoller({ load, onData, isTransient, isHidden, now, setTimer, clearTimer })
 *   load()   -> Promise<data>        one refresh
 *   onData   (data)                  called with each answer
 * start() begins; stop() ends; resume() is called when the page becomes visible again.
 */
export function createPoller({
  load,
  onData,
  onError = () => {},
  transient = isTransient,
  isHidden = () => globalThis.document?.hidden === true,
  now = () => Date.now(),
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (t) => globalThis.clearTimeout(t),
}) {
  let timer = null;
  let running = false;
  let startedAt = 0;
  let lastData = null;

  function schedule() {
    if (!running || timer !== null) return;
    if (!transient(lastData)) {
      running = false;
      return;
    }
    timer = setTimer(tick, nextDelay(now() - startedAt));
  }

  async function tick() {
    timer = null;
    if (!running) return;
    if (isHidden()) return; // paused: resume() restarts the cycle
    try {
      lastData = await load();
      onData(lastData);
    } catch (err) {
      onError(err);
    }
    schedule();
  }

  return {
    // `initial` is the data already on screen; polling only continues while it is transient.
    start(initial) {
      lastData = initial;
      startedAt = now();
      running = transient(initial);
      schedule();
    },
    resume() {
      if (!running || timer !== null || isHidden()) return;
      timer = setTimer(tick, 0);
    },
    stop() {
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    get active() {
      return running;
    },
  };
}
