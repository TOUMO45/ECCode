// Money: integer USD cents only. No floating point is used to compute or format an amount.
// Tax is expressed in basis points (1 bp = 0.01 %) and rounded half up PER SUPPLIER ORDER.

export const CURRENCY = 'USD';
export const MAX_CENTS = 100_000_000_000; // 1 billion dollars; far above any real order, keeps products safe

export function isCents(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS;
}

export function assertCents(value, name = 'cents') {
  if (!isCents(value)) throw new RangeError(`${name} must be an integer number of cents between 0 and ${MAX_CENTS}`);
  return value;
}

export function assertBasisPoints(value, name = 'taxBp') {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) {
    throw new RangeError(`${name} must be an integer number of basis points between 0 and 100000`);
  }
  return value;
}

// Tax on one supplier order: floor(base * bp / 10000 + 1/2), i.e. round half up, in pure integer arithmetic.
export function taxCents(baseCents, taxBp) {
  assertCents(baseCents, 'baseCents');
  assertBasisPoints(taxBp);
  if (taxBp === 0 || baseCents === 0) return 0;
  const product = baseCents * taxBp;
  if (Number.isSafeInteger(product)) return Math.floor((product + 5000) / 10000);
  return Number((BigInt(baseCents) * BigInt(taxBp) + 5000n) / 10000n);
}

// Totals of one supplier order: tax is computed on (subtotal + prep fee) and rounded once for the order.
export function supplierOrderTotals({ subtotalCents, prepFeeCents, taxBp }) {
  assertCents(subtotalCents, 'subtotalCents');
  assertCents(prepFeeCents, 'prepFeeCents');
  const tax = taxCents(subtotalCents + prepFeeCents, taxBp);
  return {
    subtotalCents,
    prepFeeCents,
    taxCents: tax,
    totalCents: subtotalCents + prepFeeCents + tax,
  };
}

export function sumCents(values) {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return assertCents(total, 'sum');
}

// "$84.00", "$1,234.50". Integer arithmetic on the cent count; the thousands grouping is done on the digit string.
export function formatUsd(cents) {
  assertCents(cents);
  const dollars = String(Math.trunc(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
}

// PayPal amount.value: "84.00". Exactly `${Math.trunc(c/100)}.${String(c%100).padStart(2,"0")}`, no floating point.
export function toPayPalValue(cents) {
  assertCents(cents);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// Inverse of toPayPalValue for provider answers: "84.00" -> 8400. Rejects anything but digits '.' two digits.
export function fromPayPalValue(text) {
  if (typeof text !== 'string' || !/^\d{1,12}\.\d{2}$/.test(text)) {
    throw new RangeError('PayPal value must look like "84.00"');
  }
  const [whole, frac] = text.split('.');
  return assertCents(Number(whole) * 100 + Number(frac));
}
