'use strict';
// acme-kit/money: exact money arithmetic in integer minor units (cents).
// Floating-point arithmetic on money is not allowed in Acme services (README
// "Money"). DECIMAL strings from acme-kit/db go through fromDecimal() at the
// repository boundary; responses use toDecimal() or format().

function fromDecimal(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`acme-kit/money: not a finite amount: ${value}`);
    value = value.toFixed(2);
  }
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!m) throw new Error(`acme-kit/money: invalid decimal amount ${JSON.stringify(value)}`);
  const cents = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

function toDecimal(cents) {
  if (!Number.isInteger(cents)) throw new Error(`acme-kit/money: cents must be an integer (got ${cents})`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function format(cents, currency = 'USD') {
  const symbol = { USD: '$', EUR: '€', GBP: '£' }[currency] || `${currency} `;
  const d = toDecimal(cents);
  return d.startsWith('-') ? `-${symbol}${d.slice(1)}` : `${symbol}${d}`;
}

function sum(list) {
  return list.reduce((a, b) => {
    if (!Number.isInteger(b)) throw new Error(`acme-kit/money: sum() takes integer cents (got ${b})`);
    return a + b;
  }, 0);
}

/** Percentage of an amount in cents, rounded half away from zero. basisPoints: 825 = 8.25%. */
function percent(cents, basisPoints) {
  const raw = (cents * basisPoints) / 10000;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}

module.exports = { fromDecimal, toDecimal, format, sum, percent };
