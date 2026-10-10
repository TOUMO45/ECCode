// Unit tests for src/ai/gate.js: integer micro-dollars, reservation before the call, refunds, global and customer
// refusals, concurrency 1 per customer, and the 10-per-10-minutes extract/upload rate (all on a real SQLite file).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_FIELDS, createGate, customerShareCap, gateLimitsFromConfig, microUsdOfUsage, shareToPpm, toMicroUsd,
} from '../../../src/ai/gate.js';
import { createFakeProvider } from '../../../src/ai/fake.js';
import { loadConfig } from '../../../src/config.js';
import { adoptAppError } from '../../../src/http/envelope.js';
import { insertUser, openTestDb } from '../auth/helpers.js';

const fx = openTestDb();
after(() => fx.close());

let seq = 0;
const customer = () => insertUser(fx.db, { username: `gate-${seq += 1}` });
const rows = (id) => fx.db.prepare('SELECT * FROM model_spend WHERE customer_id = ? ORDER BY id').all(id);

// Fresh gate and clean tables for each test.
function setup(limits) {
  fx.db.exec('DELETE FROM model_spend; DELETE FROM rate_events;');
  return createGate({ db: fx.db, clock: fx.clock, limits: { customerDailyShare: 1, ...limits } });
}

const fakeCall = (provider) => () => provider.extract({ text: 'I need 200 cups and 200 lids', signal: new AbortController().signal });
const refusal = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a refusal');
  return null;
};

describe('integer micro-dollars (F-TR-12)', () => {
  test('NFR6: decimal strings parse by string arithmetic, six decimals, half up at the sixth', () => {
    assert.equal(toMicroUsd('0.0037'), 3700);
    assert.equal(toMicroUsd('1.00'), 1_000_000);
    assert.equal(toMicroUsd('0.05'), 50_000);
    assert.equal(toMicroUsd('0.299999'), 299_999);
    assert.equal(toMicroUsd('0.0000005'), 1, 'seventh digit 5 rounds the sixth up');
    assert.equal(toMicroUsd('0.0000004'), 0);
    assert.equal(toMicroUsd('0.1234565'), 123_457);
    assert.equal(toMicroUsd(0.1), 100_000);
    assert.equal(toMicroUsd(0.07), 70_000, 'no floating-point drift');
    assert.equal(toMicroUsd(5e-7), 1, 'exponent forms are rendered as plain decimals');
    for (const bad of ['', '-1', '1e3', '1,5', 'abc', Number.NaN, -0.5, Infinity, null, undefined, {}]) {
      assert.throws(() => toMicroUsd(bad), (e) => e instanceof RangeError || e instanceof TypeError, String(bad));
    }
  });

  test('NFR6: the customer share is floor(share x budget) in integers', () => {
    assert.equal(shareToPpm(0.2), 200_000);
    assert.equal(shareToPpm(1), 1_000_000);
    assert.equal(customerShareCap(1_000_000, 0.2), 200_000);
    assert.equal(customerShareCap(1_000_001, 0.2), 200_000, 'floor');
    assert.equal(customerShareCap(250_000, 0.3), 75_000);
    assert.equal(customerShareCap(1_000_000, 0), 0);
    assert.throws(() => shareToPpm(1.5), RangeError);
  });

  test('usage cost: costMicroUsd wins when it is an integer, costUsd is converted, anything else is 0', () => {
    assert.equal(microUsdOfUsage({ costMicroUsd: 3700, costUsd: 9 }), 3700);
    assert.equal(microUsdOfUsage({ costUsd: 0.0037 }), 3700);
    assert.equal(microUsdOfUsage({}), 0);
    assert.equal(microUsdOfUsage(undefined), 0);
    assert.throws(() => microUsdOfUsage({ costMicroUsd: 1.5 }), RangeError);
    assert.throws(() => microUsdOfUsage({ costMicroUsd: -1 }), RangeError);
  });

  test('config field names: micro-dollar fields win; USD fields are converted; the share defaults to 0.2', () => {
    assert.deepEqual(CONFIG_FIELDS.dailyBudget, ['modelDailyBudgetMicroUsd', 'modelDailyBudgetUsd']);
    const fromUsd = gateLimitsFromConfig({ modelDailyBudgetUsd: 0.25, modelCallCapUsd: 0.1 });
    assert.deepEqual(fromUsd, { dailyBudgetMicroUsd: 250_000, callCapMicroUsd: 100_000, customerDailyShare: 0.2 });
    const fromMicro = gateLimitsFromConfig({ modelDailyBudgetMicroUsd: 1_000_000, modelCallCapMicroUsd: 50_000, modelCustomerDailyShare: 1, modelDailyBudgetUsd: 99 });
    assert.deepEqual(fromMicro, { dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 50_000, customerDailyShare: 1 });
    assert.throws(() => gateLimitsFromConfig({}), TypeError);
    assert.throws(() => gateLimitsFromConfig({ modelDailyBudgetMicroUsd: 1.5, modelCallCapMicroUsd: 1 }), RangeError);
  });

  test('NFR6: the real config (rework-1 shape) feeds the gate: defaults are budget 1.00 USD, cap 0.05 USD, share 0.2', () => {
    const limits = gateLimitsFromConfig(loadConfig({ RS_TEST_OFFLINE: '1' }));
    assert.deepEqual(limits, { dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 50_000, customerDailyShare: 0.2 });
    const pinned = gateLimitsFromConfig(loadConfig({ RS_TEST_OFFLINE: '1', RS_MODEL_DAILY_BUDGET_USD: '0.25', RS_MODEL_CALL_CAP_USD: '0.10', RS_MODEL_CUSTOMER_DAILY_SHARE: '1' }));
    assert.deepEqual(pinned, { dailyBudgetMicroUsd: 250_000, callCapMicroUsd: 100_000, customerDailyShare: 1 });
  });

  test('NFR6: the default model in config is haiku', () => {
    assert.equal(loadConfig({ RS_TEST_OFFLINE: '1' }).model, 'haiku');
  });
});

describe('reservation before the call, settlement and refund', () => {
  test('NFR6: budget is reserved BEFORE the provider is called and settled with the reported cost afterwards', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 100_000 });
    const c = customer();
    const provider = createFakeProvider({ costMicroUsd: 3700, sleep: async () => {} });
    let during;
    await gate.run({
      customerId: c, requestId: 7, call: async (reservation) => {
        during = rows(c);
        assert.equal(reservation.reservedMicroUsd, 100_000);
        return fakeCall(provider)();
      },
    });
    assert.equal(during.length, 1, 'the row exists while the provider call is running');
    assert.deepEqual([during[0].status, during[0].reserved_micro_usd, during[0].actual_micro_usd, during[0].purpose, during[0].request_id], ['reserved', 100_000, null, 'extract', 7]);
    const after = rows(c);
    assert.deepEqual([after[0].status, after[0].actual_micro_usd], ['settled', 3700]);
    assert.equal(gate.spendToday(), 3700);
    assert.equal(gate.spendToday(c), 3700);
  });

  test('NFR6: a failed call is refunded (actual 0) and the error is rethrown unchanged; its cost frees the budget', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 150_000, callCapMicroUsd: 100_000 });
    const c = customer();
    const failing = createFakeProvider({ costMicroUsd: 100_000, faults: () => 'error', sleep: async () => {} });
    await assert.rejects(gate.run({ customerId: c, call: fakeCall(failing) }), { code: 'PROVIDER_UNAVAILABLE' });
    assert.deepEqual(rows(c).map((r) => [r.status, r.actual_micro_usd]), [['settled', 0]]);
    assert.equal(gate.spendToday(), 0);
    // refunded: a second call fits even though 2 x cap would exceed the budget
    const good = createFakeProvider({ costMicroUsd: 100_000, sleep: async () => {} });
    await gate.run({ customerId: c, call: fakeCall(good) });
    assert.equal(gate.spendToday(), 100_000);
  });

  test('NFR6: a failure that carries a billed usage settles at that cost, not at zero', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 100_000 });
    const c = customer();
    const err = Object.assign(new Error('billed failure'), { usage: { costMicroUsd: 2500 } });
    await assert.rejects(gate.run({ customerId: c, call: async () => { throw err; } }), err);
    assert.deepEqual(rows(c).map((r) => r.actual_micro_usd), [2500]);
    const garbled = Object.assign(new Error('garbled'), { usage: { costMicroUsd: 'x' } });
    await assert.rejects(gate.run({ customerId: c, call: async () => { throw garbled; } }), garbled);
    assert.deepEqual(rows(c).map((r) => r.actual_micro_usd), [2500, 100_000], 'unreadable usage is charged at the cap, never at zero');
  });

  test('a result with unreadable usage is settled at the cap and the error surfaces', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 100_000 });
    const c = customer();
    await assert.rejects(gate.run({ customerId: c, call: async () => ({ usage: { costMicroUsd: -5 } }) }), RangeError);
    assert.deepEqual(rows(c).map((r) => [r.status, r.actual_micro_usd]), [['settled', 100_000]]);
  });

  test('settling twice changes nothing; a crashed call is settled at its cap by settleStale after the grace period', () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 100_000 });
    const c = customer();
    const r = gate.reserve({ customerId: c });
    assert.equal(gate.settle(r, 1000), true);
    assert.equal(gate.settle(r, 9999), false);
    assert.equal(rows(c)[0].actual_micro_usd, 1000);
    const crashed = customer();
    gate.reserve({ customerId: crashed });
    assert.equal(gate.settleStale({ olderThanMs: 60_000 }), 0, 'too young');
    fx.clock.advance(60_001);
    assert.equal(gate.settleStale({ olderThanMs: 60_000 }), 1);
    assert.deepEqual(rows(crashed).map((x) => [x.status, x.actual_micro_usd]), [['settled', 100_000]]);
    assert.throws(() => gate.settleStale({ olderThanMs: -1 }), RangeError);
  });

  test('purpose must be extract or rephrase and a rephrase reservation is recorded as such', () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 100_000 });
    const c = customer();
    assert.throws(() => gate.reserve({ customerId: c, purpose: 'chat' }), RangeError);
    const r = gate.reserve({ customerId: c, purpose: 'rephrase' });
    assert.equal(rows(c)[0].purpose, 'rephrase');
    gate.refund(r);
  });
});

describe('budget refusals (NFR6, SEC-10)', () => {
  async function extracts(gate, c, cost, n) {
    const provider = createFakeProvider({ costMicroUsd: cost, sleep: async () => {} });
    const outcomes = [];
    for (let i = 0; i < n; i++) {
      try {
        await gate.run({ customerId: c, rate: false, call: fakeCall(provider) });
        outcomes.push('ok');
      } catch (err) {
        outcomes.push(`${err.status}:${err.code}:${err.details?.scope ?? err.details?.limit}`);
      }
    }
    return outcomes;
  }

  test('NFR6: with cap 0.10, budget 0.25 and fake cost 0.10 the third extract is refused (200000 + 100000 > 250000) without calling the provider', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 250_000, callCapMicroUsd: 100_000 });
    const c = customer();
    let calls = 0;
    const provider = createFakeProvider({ costMicroUsd: 100_000, sleep: async () => {} });
    const counting = () => { calls += 1; return fakeCall(provider)(); };
    const results = [];
    for (let i = 0; i < 3; i++) {
      try {
        await gate.run({ customerId: c, rate: false, call: counting });
        results.push('ok');
      } catch (err) {
        results.push(err.code);
        assert.equal(err.status, 503);
        assert.deepEqual(err.details, { scope: 'global' });
      }
    }
    assert.deepEqual(results, ['ok', 'ok', 'MODEL_BUDGET_EXHAUSTED']);
    assert.equal(calls, 2, 'the provider was not invoked for the refused call');
    assert.equal(rows(c).length, 2, 'a refusal inserts no reservation row');
  });

  test('NFR6: boundaries in micro-dollars: budget 0.30 allows the third call (300000 = 300000); 0.299999 refuses it', async () => {
    const exact = setup({ dailyBudgetMicroUsd: toMicroUsd('0.30'), callCapMicroUsd: 100_000 });
    assert.deepEqual(await extracts(exact, customer(), 100_000, 4), ['ok', 'ok', 'ok', '503:MODEL_BUDGET_EXHAUSTED:global']);
    const under = setup({ dailyBudgetMicroUsd: toMicroUsd('0.299999'), callCapMicroUsd: 100_000 });
    assert.deepEqual(await extracts(under, customer(), 100_000, 3), ['ok', 'ok', '503:MODEL_BUDGET_EXHAUSTED:global']);
  });

  test('NFR6: the budget counts the actual spend of settled calls, not their cap', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 250_000, callCapMicroUsd: 100_000 });
    // fake cost 3700: six calls settle at 22200 total; the seventh still fits (22200 + 100000 <= 250000)
    assert.deepEqual(await extracts(gate, customer(), 3700, 7), Array(7).fill('ok'));
    assert.equal(gate.spendToday(), 7 * 3700);
  });

  test('NFR6: spend is per Asia/Amman day: the next local day starts at zero', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 100_000, callCapMicroUsd: 100_000 });
    const c = customer();
    assert.deepEqual(await extracts(gate, c, 100_000, 2), ['ok', '503:MODEL_BUDGET_EXHAUSTED:global']);
    fx.clock.advance(24 * 3600 * 1000);
    assert.deepEqual(await extracts(gate, c, 100_000, 1), ['ok']);
    fx.clock.advance(-24 * 3600 * 1000);
  });

  test('SEC-10: with the default share 0.2, budget 1.00 and cap = fake cost = 0.05 the 5th call of one customer is refused with scope customer; another customer succeeds', async () => {
    fx.db.exec('DELETE FROM model_spend; DELETE FROM rate_events;');
    const gate = createGate({ db: fx.db, clock: fx.clock, limits: { dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 50_000 } });
    assert.equal(gate.limits.customerDailyShare, 0.2);
    assert.equal(gate.limits.customerCapMicroUsd, 200_000);
    const a = customer();
    const b = customer();
    assert.deepEqual(await extracts(gate, a, 50_000, 5), ['ok', 'ok', 'ok', 'ok', '503:MODEL_BUDGET_EXHAUSTED:customer']);
    assert.deepEqual(await extracts(gate, b, 50_000, 1), ['ok']);
  });

  test('SEC-10: the scope is customer when only the share is exceeded and global when the budget is exhausted', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 100_000, callCapMicroUsd: 100_000, customerDailyShare: 0.2 });
    // the share cap (20000) is below one cap-sized call, so even the first call of a customer is a customer refusal
    assert.deepEqual(await extracts(gate, customer(), 100_000, 1), ['503:MODEL_BUDGET_EXHAUSTED:customer']);
    const g2 = setup({ dailyBudgetMicroUsd: 100_000, callCapMicroUsd: 100_000, customerDailyShare: 1 });
    const x = customer();
    assert.deepEqual(await extracts(g2, x, 100_000, 1), ['ok']);
    assert.deepEqual(await extracts(g2, customer(), 100_000, 1), ['503:MODEL_BUDGET_EXHAUSTED:global']);
  });

  test('SEC-10: a refusal carries a status and code the HTTP layer adopts, with Retry-After for the 429 case', () => {
    const gate = setup({ dailyBudgetMicroUsd: 100_000, callCapMicroUsd: 100_000 });
    const c = customer();
    gate.reserve({ customerId: c });
    const busy = refusal(() => gate.reserve({ customerId: c }));
    const adopted = adoptAppError(busy);
    assert.equal(adopted.status, 429);
    assert.equal(adopted.code, 'RATE_LIMITED');
    assert.deepEqual(adopted.details, { limit: 'model_concurrency' });
    assert.equal(adopted.headers['Retry-After'], '5');
    const full = refusal(() => gate.reserve({ customerId: customer() }));
    const adoptedFull = adoptAppError(full);
    assert.equal(adoptedFull.status, 503);
    assert.equal(adoptedFull.code, 'MODEL_BUDGET_EXHAUSTED');
    assert.deepEqual(adoptedFull.details, { scope: 'global' });
  });
});

describe('concurrency 1 per customer (SEC-10)', () => {
  test('SEC-10: a second call while one is in flight is refused with 429 RATE_LIMITED model_concurrency; another customer is unaffected', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 50_000 });
    const a = customer();
    const b = customer();
    let release;
    const gateOpen = new Promise((resolve) => { release = resolve; });
    const first = gate.run({ customerId: a, rate: false, call: async () => { await gateOpen; return { usage: { costMicroUsd: 1000 } }; } });
    const err = await gate.run({ customerId: a, rate: false, call: async () => ({ usage: {} }) }).catch((e) => e);
    assert.equal(err.status, 429);
    assert.deepEqual(err.details, { limit: 'model_concurrency' });
    await gate.run({ customerId: b, rate: false, call: async () => ({ usage: { costMicroUsd: 1000 } }) });
    release();
    await first;
    await gate.run({ customerId: a, rate: false, call: async () => ({ usage: {} }) });
    assert.equal(rows(a).length, 2, 'the refused call left no row');
  });

  test('SEC-10: a failed call frees the customer slot', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 50_000 });
    const a = customer();
    await assert.rejects(gate.run({ customerId: a, rate: false, call: async () => { throw new Error('boom'); } }), /boom/);
    await gate.run({ customerId: a, rate: false, call: async () => ({ usage: {} }) });
  });
});

describe('rate: 10 extracts or uploads per customer per 10 minutes (F-TR-10)', () => {
  test('NFR6: the 11th call within 10 minutes is refused with 429 RATE_LIMITED extract_upload and Retry-After; it is not counted', () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 50_000 });
    const c = customer();
    for (let i = 0; i < 10; i++) {
      gate.takeRate(c);
      fx.clock.advance(1000);
    }
    const err = refusal(() => gate.takeRate(c));
    assert.equal(err.status, 429);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.deepEqual(err.details, { limit: 'extract_upload' });
    assert.equal(err.headers['Retry-After'], String(600 - 10), 'seconds until the oldest event leaves the window');
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE user_key = ? AND kind = 'extract_or_upload'").get(`u:${c}`).n, 10);
    gate.takeRate(customer());
    fx.clock.advance(590_000);
    gate.takeRate(c);
  });

  test('NFR6: count and insert run inside one BEGIN IMMEDIATE transaction', () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 50_000 });
    const seen = [];
    const spy = {
      tx: (fn) => fx.db.tx(fn),
      prepare(sql) {
        const stmt = fx.db.prepare(sql);
        return {
          get: (...a) => (seen.push(fx.db.inTx), stmt.get(...a)),
          run: (...a) => (seen.push(fx.db.inTx), stmt.run(...a)),
        };
      },
    };
    createGate({ db: spy, clock: fx.clock, limits: { dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 50_000 } }).takeRate(customer());
    assert.ok(seen.length >= 3 && seen.every(Boolean), JSON.stringify(seen));
    assert.ok(gate);
  });

  test('NFR6: run() takes the rate first for extracts; a rate refusal never reserves budget or calls the provider', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 1000, rateLimit: 2 });
    const c = customer();
    let calls = 0;
    const call = async () => { calls += 1; return { usage: { costMicroUsd: 1 } }; };
    await gate.run({ customerId: c, call });
    await gate.run({ customerId: c, call });
    const err = await gate.run({ customerId: c, call }).catch((e) => e);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.deepEqual(err.details, { limit: 'extract_upload' });
    assert.equal(calls, 2);
    assert.equal(rows(c).length, 2);
  });

  test('a rephrase call is not counted against the extract/upload rate', async () => {
    const gate = setup({ dailyBudgetMicroUsd: 1_000_000, callCapMicroUsd: 1000, rateLimit: 1 });
    const c = customer();
    for (let i = 0; i < 3; i++) await gate.run({ customerId: c, purpose: 'rephrase', call: async () => ({ usage: {} }) });
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM rate_events').get().n, 0);
  });

  test('bad limits are refused', () => {
    const base = { db: fx.db, clock: fx.clock };
    assert.throws(() => createGate({ ...base, limits: { dailyBudgetMicroUsd: 1.5, callCapMicroUsd: 1 } }), RangeError);
    assert.throws(() => createGate({ ...base, limits: { dailyBudgetMicroUsd: 10, callCapMicroUsd: 0 } }), RangeError);
    assert.throws(() => createGate({ ...base, limits: { dailyBudgetMicroUsd: 10, callCapMicroUsd: 1, rateLimit: 0 } }), RangeError);
    assert.throws(() => createGate({ ...base, limits: { dailyBudgetMicroUsd: 10, callCapMicroUsd: 1, customerDailyShare: 2 } }), RangeError);
  });
});
