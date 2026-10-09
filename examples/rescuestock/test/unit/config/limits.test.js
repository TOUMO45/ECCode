import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../../src/config.js';

function refusal(env) {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError, 'expected a ConfigError');
    return err;
  }
  assert.fail('expected the configuration to be refused');
}

test('F-TR-17: RS_REGISTER_PER_IP_PER_HOUR defaults to 5, above 5 refuses startup unless RS_TEST_OFFLINE=1, and 1000 is accepted in test mode (F-PL-4)', () => {
  assert.equal(loadConfig({}).registerPerIpPerHour, 5);
  assert.equal(loadConfig({ RS_REGISTER_PER_IP_PER_HOUR: '5' }).registerPerIpPerHour, 5);
  assert.equal(loadConfig({ RS_REGISTER_PER_IP_PER_HOUR: '1' }).registerPerIpPerHour, 1);

  for (const value of ['6', '7', '100', '1000']) {
    const err = refusal({ RS_REGISTER_PER_IP_PER_HOUR: value });
    assert.deepEqual(err.variables, ['RS_REGISTER_PER_IP_PER_HOUR'], value);
    assert.match(err.message, /RS_REGISTER_PER_IP_PER_HOUR/);
    assert.match(err.message, /RS_TEST_OFFLINE=1/);
  }
  // RS_TEST_OFFLINE=0 is the same as unset.
  assert.deepEqual(refusal({ RS_TEST_OFFLINE: '0', RS_REGISTER_PER_IP_PER_HOUR: '6' }).variables, ['RS_REGISTER_PER_IP_PER_HOUR']);

  const relaxed = loadConfig({ RS_TEST_OFFLINE: '1', RS_REGISTER_PER_IP_PER_HOUR: '1000' });
  assert.equal(relaxed.registerPerIpPerHour, 1000);
  assert.equal(relaxed.testOffline, true);
});

test('F-TR-17: RS_REGISTER_PER_IP_PER_HOUR must be an integer of at least 1', () => {
  for (const value of ['0', '-1', '2.5', 'five', '5 ', '1e3']) {
    assert.deepEqual(refusal({ RS_TEST_OFFLINE: '1', RS_REGISTER_PER_IP_PER_HOUR: value }).variables, ['RS_REGISTER_PER_IP_PER_HOUR'], value);
  }
});

test('RS_SAGA_LEASE_MS must be at least 3 times RS_PAYPAL_TIMEOUT_MS', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.sagaLeaseMs, 60000);
  assert.equal(defaults.paypalTimeoutMs, 20000);
  assert.ok(defaults.sagaLeaseMs >= 3 * defaults.paypalTimeoutMs);

  // The lease-takeover test uses exactly 3x.
  const exact = loadConfig({ RS_SAGA_LEASE_MS: '1500', RS_PAYPAL_TIMEOUT_MS: '500' });
  assert.equal(exact.sagaLeaseMs, 1500);

  const err = refusal({ RS_SAGA_LEASE_MS: '1499', RS_PAYPAL_TIMEOUT_MS: '500' });
  assert.deepEqual(err.variables, ['RS_SAGA_LEASE_MS']);
  assert.match(err.message, /3 times RS_PAYPAL_TIMEOUT_MS/);
  // Raising only the timeout can also break the rule.
  assert.deepEqual(refusal({ RS_PAYPAL_TIMEOUT_MS: '30000' }).variables, ['RS_SAGA_LEASE_MS']);
});

test('RS_DB_BUSY_TIMEOUT_MS is an integer from 0 to 5000 (default 5000)', () => {
  assert.equal(loadConfig({}).dbBusyTimeoutMs, 5000);
  assert.equal(loadConfig({ RS_DB_BUSY_TIMEOUT_MS: '0' }).dbBusyTimeoutMs, 0);
  assert.equal(loadConfig({ RS_DB_BUSY_TIMEOUT_MS: '5000' }).dbBusyTimeoutMs, 5000);
  for (const value of ['5001', '-1', '1.5', 'abc', '0x10']) {
    assert.deepEqual(refusal({ RS_DB_BUSY_TIMEOUT_MS: value }).variables, ['RS_DB_BUSY_TIMEOUT_MS'], value);
  }
});

test('RS_MODEL_CUSTOMER_DAILY_SHARE is a number from 0 to 1 (default 0.2)', () => {
  assert.equal(loadConfig({}).modelCustomerDailyShare, 0.2);
  assert.equal(loadConfig({ RS_MODEL_CUSTOMER_DAILY_SHARE: '1' }).modelCustomerDailyShare, 1);
  assert.equal(loadConfig({ RS_MODEL_CUSTOMER_DAILY_SHARE: '0' }).modelCustomerDailyShare, 0);
  for (const value of ['1.01', '-0.1', 'half']) {
    assert.deepEqual(refusal({ RS_MODEL_CUSTOMER_DAILY_SHARE: value }).variables, ['RS_MODEL_CUSTOMER_DAILY_SHARE'], value);
  }
});

test('boolean switches accept only 0 or 1', () => {
  for (const name of ['RS_ALLOW_SIGNUP', 'RS_TRUST_PROXY', 'RS_TEST_HOOKS', 'RS_TEST_OFFLINE', 'RS_EXPLAIN_REPHRASE']) {
    assert.deepEqual(refusal({ [name]: 'yes' }).variables, [name]);
    assert.deepEqual(refusal({ [name]: 'true' }).variables, [name]);
  }
  assert.equal(loadConfig({ RS_ALLOW_SIGNUP: '0' }).allowSignup, false);
  assert.equal(loadConfig({}).allowSignup, true);
});

test('RS_DEMO_DATE must be a real calendar date; the default is today in Asia/Amman', () => {
  assert.equal(loadConfig({ RS_DEMO_DATE: '2026-10-20' }).demoDate, '2026-10-20');
  for (const value of ['2026-02-30', '2026-13-01', '20-10-2026', 'today', '2026-1-1']) {
    assert.deepEqual(refusal({ RS_DEMO_DATE: value }).variables, ['RS_DEMO_DATE'], value);
  }
  // 21:30 UTC on Oct 19 is already Oct 20 in Amman (UTC+3).
  const late = Date.UTC(2026, 9, 19, 21, 30);
  assert.equal(loadConfig({}, { now: () => late }).demoDate, '2026-10-20');
  const early = Date.UTC(2026, 9, 19, 20, 30);
  assert.equal(loadConfig({}, { now: () => early }).demoDate, '2026-10-19');
});
