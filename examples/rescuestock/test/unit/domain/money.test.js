// Money: integer cents, basis-point tax rounded half up per supplier order, PayPal values without floating point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCents, formatUsd, fromPayPalValue, isCents, supplierOrderTotals, sumCents, taxCents, toPayPalValue,
} from '../../../src/domain/money.js';

test('money: cents are safe non-negative integers, nothing else is accepted', () => {
  for (const ok of [0, 1, 8400, 100_000_000_000]) assert.equal(isCents(ok), true, String(ok));
  for (const bad of [-1, 1.5, NaN, Infinity, '100', null, undefined, 100_000_000_001, 2 ** 53, 0.1 + 0.2]) {
    assert.equal(isCents(bad), false, String(bad));
    assert.throws(() => assertCents(bad), RangeError);
  }
  assert.equal(sumCents([4000, 4400]), 8400);
  assert.throws(() => sumCents([1, 0.5]), RangeError);
});

test('money: tax in basis points is rounded half up, in integer arithmetic', () => {
  assert.equal(taxCents(4000, 0), 0);
  assert.equal(taxCents(0, 1600), 0);
  assert.equal(taxCents(4000, 1600), 640);
  assert.equal(taxCents(50, 100), 1, '0.5 cents rounds up');
  assert.equal(taxCents(49, 100), 0, '0.49 cents rounds down');
  assert.equal(taxCents(150, 100), 2, '1.5 cents rounds up');
  assert.equal(taxCents(250, 100), 3, '2.5 cents rounds up (half up, not half to even)');
  assert.equal(taxCents(1, 5000), 1, '0.5 -> 1');
  assert.equal(taxCents(4333, 825), 357, '357.4725 -> 357');
  assert.equal(taxCents(4363, 825), 360, '359.9475 -> 360');
  // exhaustive check against exact rational arithmetic on a grid
  for (let base = 0; base <= 400; base += 1) {
    for (const bp of [1, 5, 99, 100, 825, 1600, 2000, 9999]) {
      const exact = Number((BigInt(base) * BigInt(bp) * 2n + 10000n) / 20000n); // floor(base*bp/10000 + 1/2)
      assert.equal(taxCents(base, bp), exact, `${base} @ ${bp} bp`);
    }
  }
  // a large product that would exceed 2^53 as a float uses exact integer maths
  assert.equal(taxCents(100_000_000_000, 99_999), Number((100_000_000_000n * 99_999n + 5000n) / 10000n));
  assert.throws(() => taxCents(100, -1), RangeError);
  assert.throws(() => taxCents(100, 1.5), RangeError);
  assert.throws(() => taxCents(100.5, 100), RangeError);
});

test('money: tax is rounded once per supplier order, on subtotal plus prep fee', () => {
  assert.deepEqual(supplierOrderTotals({ subtotalCents: 3000, prepFeeCents: 1000, taxBp: 0 }),
    { subtotalCents: 3000, prepFeeCents: 1000, taxCents: 0, totalCents: 4000 });
  assert.deepEqual(supplierOrderTotals({ subtotalCents: 3000, prepFeeCents: 1000, taxBp: 825 }),
    { subtotalCents: 3000, prepFeeCents: 1000, taxCents: 330, totalCents: 4330 });
  // rounding per order differs from rounding the sum: two orders of 0.5 cents each round up twice
  const one = supplierOrderTotals({ subtotalCents: 30, prepFeeCents: 20, taxBp: 100 });
  assert.equal(one.taxCents, 1);
  assert.equal(one.taxCents + one.taxCents, 2);
  assert.equal(taxCents(100, 100), 1, 'whereas the combined 100 cents would give exactly 1');
});

test('money: formatUsd groups thousands and always shows two decimals', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(5), '$0.05');
  assert.equal(formatUsd(8400), '$84.00');
  assert.equal(formatUsd(9500), '$95.00');
  assert.equal(formatUsd(123456), '$1,234.56');
  assert.equal(formatUsd(100_000_000_000), '$1,000,000,000.00');
  assert.throws(() => formatUsd(-1), RangeError);
});

test('money: toPayPalValue is `${trunc(c/100)}.${pad(c%100)}` with no floating point; fromPayPalValue is its exact inverse', () => {
  const cases = new Map([[0, '0.00'], [1, '0.01'], [9, '0.09'], [10, '0.10'], [99, '0.99'], [100, '1.00'], [8400, '84.00'], [9500, '95.00'],
    [12345, '123.45'], [100_000_000_000, '1000000000.00']]);
  for (const [cents, text] of cases) {
    assert.equal(toPayPalValue(cents), text);
    assert.equal(fromPayPalValue(text), cents);
  }
  // classic float traps: 0.07 * 100 = 7.000000000000001, 1.15 * 100 = 114.99999999999999
  assert.equal(toPayPalValue(7), '0.07');
  assert.equal(toPayPalValue(115), '1.15');
  assert.equal(toPayPalValue(1005), '10.05');
  for (let c = 0; c <= 20000; c += 1) assert.equal(fromPayPalValue(toPayPalValue(c)), c);
  assert.throws(() => toPayPalValue(1.5), RangeError);
  assert.throws(() => toPayPalValue(-100), RangeError);
  for (const bad of ['84', '84.0', '84.000', '-1.00', '1e3', ' 1.00', '1,00', 84, null]) assert.throws(() => fromPayPalValue(bad), RangeError, String(bad));
});
