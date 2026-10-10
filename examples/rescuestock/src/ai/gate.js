// Runtime controls for model calls (NFR6, SEC-10, F-TR-10, F-TR-12).
//
// Money for the model is held in INTEGER MICRO-DOLLARS. Decimal strings are parsed by string arithmetic (at most
// six decimals; more digits round half up at the sixth), so there is no floating-point comparison anywhere.
//
//   1. Rate        takeRate(customerId): one BEGIN IMMEDIATE counts rate_events (u:<id>, extract_or_upload, last
//                  10 min) and inserts, so count and insert are atomic across processes. Uploads count too.
//   2. Concurrency reserve(): a customer with a model_spend row in status 'reserved' (an in-flight call) is refused
//                  with 429 RATE_LIMITED details.limit = 'model_concurrency'.
//   3. Budget      reserve(): in the same transaction, spend + cap <= budget is allowed (spend + cap = budget passes),
//                  otherwise 503 MODEL_BUDGET_EXHAUSTED with details.scope = 'global'. When the per-customer share
//                  is below 1, the same test runs on the customer's own spend against floor(share x budget) and a
//                  refusal carries details.scope = 'customer'. The reservation row (reserved_micro_usd = cap) is
//                  inserted BEFORE the provider is called.
//   4. Settlement  settle() writes the reported cost; refund() releases a failed call (cost 0 unless the failure
//                  carried a billed usage). A crashed call's row is settled at its cap by settleStale().
//
// The gate never calls a provider inside a transaction; run() reserves, calls outside any transaction, settles.
import { AppError } from '../domain/errors.js';
import { localDay } from '../domain/time.js';

export const RATE_KIND = 'extract_or_upload';
export const DEFAULT_RATE_LIMIT = 10;
export const DEFAULT_RATE_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_CUSTOMER_DAILY_SHARE = 0.2;
export const DEFAULT_CONCURRENCY_RETRY_AFTER_S = 5;

/**
 * Config field names the gate reads (d3 wires them in src/config.js; until then the USD fields are converted here):
 *   modelDailyBudgetMicroUsd   integer, from RS_MODEL_DAILY_BUDGET_USD   (fallback: modelDailyBudgetUsd)
 *   modelCallCapMicroUsd       integer, from RS_MODEL_CALL_CAP_USD       (fallback: modelCallCapUsd)
 *   fakeModelCostMicroUsd      integer, from RS_FAKE_MODEL_COST_USD      (fallback: fakeModelCostUsd)
 *   modelCustomerDailyShare    number 0..1, from RS_MODEL_CUSTOMER_DAILY_SHARE (default 0.2; 1 = off)
 */
export const CONFIG_FIELDS = Object.freeze({
  dailyBudget: ['modelDailyBudgetMicroUsd', 'modelDailyBudgetUsd'],
  callCap: ['modelCallCapMicroUsd', 'modelCallCapUsd'],
  fakeCost: ['fakeModelCostMicroUsd', 'fakeModelCostUsd'],
  share: ['modelCustomerDailyShare'],
});

/**
 * "0.0037" -> 3700. Accepts a decimal string or a finite non-negative number (rendered with toString, or toFixed(9)
 * for exponent forms). More than six decimals round half up at the sixth. Returns an integer.
 */
export function toMicroUsd(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('micro-dollar amount must be a finite non-negative number');
    text = /e/i.test(String(value)) ? value.toFixed(9) : String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new TypeError('micro-dollar amount must be a decimal string or number');
  }
  const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(text);
  if (!m) throw new RangeError('micro-dollar amount must be a plain decimal');
  const frac = (m[2] ?? '').padEnd(7, '0');
  let micro = BigInt(m[1]) * 1_000_000n + BigInt(frac.slice(0, 6));
  if (frac.charCodeAt(6) >= 53) micro += 1n; // seventh digit >= 5 rounds the sixth up
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('micro-dollar amount is too large');
  return Number(micro);
}

// A 0..1 share as parts per million, by string arithmetic.
export function shareToPpm(share) {
  const ppm = toMicroUsd(typeof share === 'number' || typeof share === 'string' ? share : Number.NaN);
  if (ppm > 1_000_000) throw new RangeError('share must be between 0 and 1');
  return ppm;
}

// floor(share x budget) in integer micro-dollars.
export function customerShareCap(budgetMicroUsd, share) {
  return Number((BigInt(budgetMicroUsd) * BigInt(shareToPpm(share))) / 1_000_000n);
}

// The micro-dollar cost a provider reported: costMicroUsd when it is an integer, else costUsd converted.
export function microUsdOfUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  if (usage.costMicroUsd !== undefined) {
    if (!Number.isSafeInteger(usage.costMicroUsd) || usage.costMicroUsd < 0) throw new RangeError('usage.costMicroUsd must be a non-negative integer');
    return usage.costMicroUsd;
  }
  if (usage.costUsd === undefined || usage.costUsd === null) return 0;
  return toMicroUsd(usage.costUsd);
}

function pick(config, names) {
  for (const name of names) if (config[name] !== undefined && config[name] !== null) return [name, config[name]];
  return [null, undefined];
}

/** gateLimitsFromConfig(config) -> limits for createGate (see CONFIG_FIELDS for the field names). */
export function gateLimitsFromConfig(config) {
  const micro = (names, label) => {
    const [name, value] = pick(config, names);
    if (name === null) throw new TypeError(`config.${names[0]} is required for the model gate (${label})`);
    return name.endsWith('MicroUsd') ? checkMicro(value, name) : toMicroUsd(value);
  };
  const [, share] = pick(config, CONFIG_FIELDS.share);
  return {
    dailyBudgetMicroUsd: micro(CONFIG_FIELDS.dailyBudget, 'daily budget'),
    callCapMicroUsd: micro(CONFIG_FIELDS.callCap, 'per-call cap'),
    customerDailyShare: share === undefined ? DEFAULT_CUSTOMER_DAILY_SHARE : share,
  };
}

function checkMicro(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function refusal(status, code, details, retryAfterS) {
  const err = new AppError(status, code, 'Refused by the model runtime controls.', details);
  if (retryAfterS !== undefined) err.headers = { 'Retry-After': String(retryAfterS) };
  return err;
}

/**
 * createGate({ db, clock, limits })
 *   db      { tx(fn), prepare(sql) } (src/db/connection.js)
 *   clock   { now(): ms } injected
 *   limits  { dailyBudgetMicroUsd, callCapMicroUsd, customerDailyShare = 0.2, rateLimit = 10,
 *             rateWindowMs = 600000, concurrencyRetryAfterS = 5 }
 */
export function createGate({ db, clock, limits }) {
  const dailyBudget = checkMicro(limits?.dailyBudgetMicroUsd, 'dailyBudgetMicroUsd');
  const callCap = checkMicro(limits?.callCapMicroUsd, 'callCapMicroUsd');
  if (callCap === 0) throw new RangeError('callCapMicroUsd must be positive');
  const share = limits.customerDailyShare ?? DEFAULT_CUSTOMER_DAILY_SHARE;
  const sharePpm = shareToPpm(share);
  const customerCap = customerShareCap(dailyBudget, share);
  const rateLimit = limits.rateLimit ?? DEFAULT_RATE_LIMIT;
  const rateWindowMs = limits.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const retryAfterConcurrency = limits.concurrencyRetryAfterS ?? DEFAULT_CONCURRENCY_RETRY_AFTER_S;
  if (!Number.isSafeInteger(rateLimit) || rateLimit < 1 || !Number.isSafeInteger(rateWindowMs) || rateWindowMs < 1) {
    throw new RangeError('rateLimit and rateWindowMs must be positive integers');
  }

  const isoNow = () => new Date(clock.now()).toISOString();
  const today = () => localDay(clock.now());

  // Counts one extract or upload of the customer, or throws 429 RATE_LIMITED { limit: 'extract_upload' }.
  function takeRate(customerId) {
    const nowMs = clock.now();
    const cutoff = new Date(nowMs - rateWindowMs).toISOString();
    const key = `u:${customerId}`;
    const decision = db.tx(() => {
      db.prepare('DELETE FROM rate_events WHERE kind = ? AND user_key = ? AND at <= ?').run(RATE_KIND, key, cutoff);
      const row = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_events WHERE kind = ? AND user_key = ? AND at > ?').get(RATE_KIND, key, cutoff);
      if (row.n >= rateLimit) {
        return { allowed: false, retryAfterS: Math.max(1, Math.ceil((Date.parse(row.oldest) + rateWindowMs - nowMs) / 1000)) };
      }
      db.prepare('INSERT INTO rate_events (user_key, kind, at) VALUES (?, ?, ?)').run(key, RATE_KIND, new Date(nowMs).toISOString());
      return { allowed: true };
    });
    if (!decision.allowed) throw refusal(429, 'RATE_LIMITED', { limit: 'extract_upload' }, decision.retryAfterS);
  }

  // Reserves the per-call cap BEFORE the provider is called. Throws AppError 429 / 503 on refusal.
  function reserve({ customerId, requestId = null, purpose = 'extract' }) {
    if (purpose !== 'extract' && purpose !== 'rephrase') throw new RangeError('purpose must be extract or rephrase');
    const day = today();
    const decision = db.tx(() => {
      const busy = db.prepare("SELECT 1 AS x FROM model_spend WHERE customer_id = ? AND status = 'reserved' LIMIT 1").get(customerId);
      if (busy) return { refused: 'concurrency' };
      const spend = Number(db.prepare('SELECT COALESCE(SUM(COALESCE(actual_micro_usd, reserved_micro_usd)), 0) AS s FROM model_spend WHERE day = ?').get(day).s);
      if (spend + callCap > dailyBudget) return { refused: 'global' };
      if (sharePpm < 1_000_000) {
        const own = Number(db.prepare('SELECT COALESCE(SUM(COALESCE(actual_micro_usd, reserved_micro_usd)), 0) AS s FROM model_spend WHERE day = ? AND customer_id = ?').get(day, customerId).s);
        if (own + callCap > customerCap) return { refused: 'customer' };
      }
      const res = db.prepare(
        "INSERT INTO model_spend (day, customer_id, request_id, purpose, reserved_micro_usd, actual_micro_usd, status, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'reserved', ?)",
      ).run(day, customerId, requestId, purpose, callCap, isoNow());
      return { id: Number(res.lastInsertRowid) };
    });
    if (decision.refused === 'concurrency') throw refusal(429, 'RATE_LIMITED', { limit: 'model_concurrency' }, retryAfterConcurrency);
    if (decision.refused === 'global') throw refusal(503, 'MODEL_BUDGET_EXHAUSTED', { scope: 'global' });
    if (decision.refused === 'customer') throw refusal(503, 'MODEL_BUDGET_EXHAUSTED', { scope: 'customer' });
    return Object.freeze({ id: decision.id, day, customerId, purpose, reservedMicroUsd: callCap });
  }

  function settle(reservation, actualMicroUsd) {
    checkMicro(actualMicroUsd, 'actualMicroUsd');
    const changes = db.tx(() => Number(db.prepare(
      "UPDATE model_spend SET actual_micro_usd = ?, status = 'settled' WHERE id = ? AND status = 'reserved'",
    ).run(actualMicroUsd, reservation.id).changes));
    return changes === 1;
  }

  // A failed call gives its reservation back: settled at the billed cost when the failure carried one, else 0.
  function refund(reservation, { actualMicroUsd = 0 } = {}) {
    return settle(reservation, actualMicroUsd);
  }

  // Settles rows still 'reserved' after `olderThanMs` (a crashed call) at their cap. Returns the number settled.
  function settleStale({ olderThanMs }) {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new RangeError('olderThanMs must be a non-negative integer');
    const cutoff = new Date(clock.now() - olderThanMs).toISOString();
    return db.tx(() => Number(db.prepare(
      "UPDATE model_spend SET actual_micro_usd = reserved_micro_usd, status = 'settled' WHERE status = 'reserved' AND created_at <= ?",
    ).run(cutoff).changes));
  }

  /**
   * run({ customerId, requestId, purpose, rate, call }) -> whatever call() resolves with.
   * Order: rate (extract only, unless rate === false) -> reserve -> call (outside any transaction) -> settle.
   * A call that rejects is refunded (at err.usage's cost when present) and the error is rethrown unchanged.
   * The resolved value must carry `usage`; its cost settles the reservation.
   */
  async function run({ customerId, requestId = null, purpose = 'extract', rate = purpose === 'extract', call }) {
    if (typeof call !== 'function') throw new TypeError('run needs a call function');
    if (rate) takeRate(customerId);
    const reservation = reserve({ customerId, requestId, purpose });
    let result;
    try {
      result = await call(reservation);
    } catch (err) {
      let billed = 0;
      try {
        billed = microUsdOfUsage(err?.usage);
      } catch {
        billed = reservation.reservedMicroUsd; // an unreadable usage is charged at the cap, never at zero
      }
      refund(reservation, { actualMicroUsd: billed });
      throw err;
    }
    let actual;
    try {
      actual = microUsdOfUsage(result?.usage);
    } catch (err) {
      settle(reservation, reservation.reservedMicroUsd);
      throw err;
    }
    settle(reservation, actual);
    return result;
  }

  function spendToday(customerId) {
    const day = today();
    const sql = 'SELECT COALESCE(SUM(COALESCE(actual_micro_usd, reserved_micro_usd)), 0) AS s FROM model_spend WHERE day = ?';
    return Number(customerId === undefined
      ? db.prepare(sql).get(day).s
      : db.prepare(`${sql} AND customer_id = ?`).get(day, customerId).s);
  }

  return Object.freeze({
    takeRate, reserve, settle, refund, settleStale, run, spendToday,
    limits: Object.freeze({ dailyBudgetMicroUsd: dailyBudget, callCapMicroUsd: callCap, customerCapMicroUsd: customerCap, customerDailyShare: share, rateLimit, rateWindowMs }),
  });
}
