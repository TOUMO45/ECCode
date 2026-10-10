// Display helpers of the SPA (public/js/format.js): integer cents -> display, Asia/Amman times, status text.
// Plain `node --test`; no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  centsToDollarInput, fieldValueText, formatLocalDateTime, formatLocalDateTimeValue, formatLocalTime, formatUsd, formatUsdOrDash,
  formatBytes, hasUnsafeUrlChars, isNavigableUrl, joinCodes, localToTs, parseTs, parseUsdToCents, paymentStatusText, presentationText, provenanceText,
  rescueStatusText, utcToLocal,
} from '../../../public/js/format.js';

test('RS-35: formatUsd shows integer cents exactly, with no floating point drift', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(5), '$0.05');
  assert.equal(formatUsd(8400), '$84.00');
  assert.equal(formatUsd(9500), '$95.00');
  assert.equal(formatUsd(123456), '$1,234.56');
  assert.equal(formatUsd(100000000), '$1,000,000.00');
  assert.equal(formatUsd(1999), '$19.99'); // 19.99 would be 19.989999… as a float times 100
});

test('RS-35: formatUsd refuses anything that is not a whole number of cents', () => {
  for (const bad of [-1, 1.5, '84', null, undefined, NaN, Infinity, 2 ** 60]) {
    assert.throws(() => formatUsd(bad), RangeError, String(bad));
  }
});

test('RS-35: formatUsdOrDash reads a missing amount as a dash and still formats a real one', () => {
  assert.equal(formatUsdOrDash(null), '—');
  assert.equal(formatUsdOrDash(undefined), '—');
  assert.equal(formatUsdOrDash(4400), '$44.00');
});

test('RS-04: dollar text parses to cents with string arithmetic and rejects malformed amounts', () => {
  assert.equal(parseUsdToCents('95'), 9500);
  assert.equal(parseUsdToCents('95.5'), 9550);
  assert.equal(parseUsdToCents('$95.00'), 9500);
  assert.equal(parseUsdToCents('1,200.25'), 120025);
  assert.equal(parseUsdToCents(' 0.07 '), 7);
  assert.equal(parseUsdToCents('0.1'), 10); // 10 cents, not 0.1 * 100 floating point
  assert.equal(parseUsdToCents('19.99'), 1999);
  for (const bad of ['', 'abc', '-5', '1.234', '1e3', '12,34,5x', '.5', null, 7]) {
    assert.equal(parseUsdToCents(bad), null, String(bad));
  }
  assert.equal(centsToDollarInput(9500), '95.00');
  assert.equal(centsToDollarInput(7), '0.07');
  assert.equal(parseUsdToCents(centsToDollarInput(123456)), 123456);
});

test('RS-35: times are shown in Asia/Amman (UTC+3), not in the viewer’s zone', () => {
  assert.equal(formatLocalTime('2026-10-20T07:30:00.000Z'), '10:30');
  assert.equal(formatLocalTime('2026-10-20T08:20:00.000Z'), '11:20');
  assert.equal(formatLocalDateTime('2026-10-20T07:00:00.000Z'), '2026-10-20 10:00');
  assert.equal(utcToLocal('2026-10-20T08:00:00.000Z'), '2026-10-20T11:00');
  // a time that crosses midnight in Amman but not in UTC
  assert.equal(utcToLocal('2026-10-20T21:30:00.000Z'), '2026-10-21T00:30');
  // an offset form is read as the same instant
  assert.equal(formatLocalTime('2026-10-20T10:30:00+03:00'), '10:30');
  assert.equal(formatLocalTime('not a time'), '—');
  assert.equal(formatLocalDateTime(null), '—');
});

test('RS-35: Asia/Amman wall time converts back to the instant the server stores', () => {
  assert.equal(localToTs('2026-10-20T11:00'), '2026-10-20T08:00:00.000Z');
  assert.equal(localToTs('2026-10-20T10:30'), '2026-10-20T07:30:00.000Z');
  assert.equal(utcToLocal(localToTs('2026-12-31T23:59')), '2026-12-31T23:59');
  for (const bad of ['', '2026-10-20 11:00', '2026-13-01T10:00', '2026-02-30T10:00', '2026-10-20T25:00', 'x', null]) {
    assert.equal(localToTs(bad), null, String(bad));
  }
  assert.equal(parseTs('2026-10-20T07:00:00.000Z'), Date.UTC(2026, 9, 20, 7, 0, 0));
  assert.equal(parseTs('2026-10-20T07:00:00'), null); // a zone is required
  assert.equal(formatLocalDateTimeValue('2026-10-20T11:00'), '2026-10-20 11:00');
  assert.equal(formatLocalDateTimeValue('nope'), '—');
});

test('RS-35: provenance badges read "From your text", "From the photo", "Entered by you" or "Not found"', () => {
  const known = (provenance) => ({ value: 1, status: 'known', provenance, originalWording: null });
  assert.equal(provenanceText(known('user_text')), 'From your text');
  assert.equal(provenanceText(known('image')), 'From the photo');
  assert.equal(provenanceText(known('manual')), 'Entered by you');
  assert.equal(provenanceText({ value: null, status: 'unknown', provenance: 'none', originalWording: null }), 'Not found');
  assert.equal(provenanceText(known('none')), 'Not found');
  assert.equal(provenanceText(undefined), 'Not found');
});

test('RS-35: field values are shown as text; money from cents; the deadline in Amman time', () => {
  const fv = (value) => ({ value, status: 'known', provenance: 'user_text', originalWording: null });
  assert.equal(fieldValueText('budgetCents', fv(12000)), '$120.00');
  assert.equal(fieldValueText('deadline', fv('2026-10-20T11:00')), '2026-10-20 11:00 (Amman)');
  assert.equal(fieldValueText('productType', fv('cups_and_lids')), 'Cups and lids');
  assert.equal(fieldValueText('material', fv('paper')), 'Paper');
  assert.equal(fieldValueText('cupQuantity', fv(200)), '200');
  assert.equal(fieldValueText('material', { value: null, status: 'unknown', provenance: 'none', originalWording: null }), 'Not found');
});

test('NFR2: status words are text, and an unknown code is shown as the code itself', () => {
  assert.equal(rescueStatusText('plan_found'), 'Plan found');
  assert.equal(rescueStatusText('no_feasible_plan'), 'No feasible plan');
  assert.equal(rescueStatusText('something_new'), 'something_new');
  assert.equal(paymentStatusText('authorized'), 'Authorized — no money taken yet');
  assert.equal(paymentStatusText('voided'), 'Authorization voided — no money taken');
  assert.equal(presentationText('cancelled_payment_incomplete'), 'Cancelled — payment did not complete');
  assert.equal(presentationText('refunded'), 'Refunded');
});

test('RS-35: supplier combinations are written the way the planner writes them', () => {
  assert.equal(joinCodes(['A', 'E']), 'A+E');
  assert.equal(joinCodes([]), '');
  assert.equal(joinCodes(undefined), '');
});

test('T11: only http(s) links are followed to a payment provider', () => {
  assert.equal(isNavigableUrl('https://www.sandbox.paypal.com/checkoutnow?token=ABC'), true);
  assert.equal(isNavigableUrl('http://127.0.0.1:41233/fake-paypal/checkout/FAKE-0123456789abcdef0123456789abcdef'), true);
  for (const bad of ['', 'ja' + 'vascript:alert(1)', 'data:text/html,hi', '/relative', '//host/x', null, undefined, 42, `https://x/${'a'.repeat(3000)}`]) {
    assert.equal(isNavigableUrl(bad), false, String(bad).slice(0, 40));
  }
});

test('SEC-C-4: a link with a backslash, a space or a control character is not navigable, even when it looks like https', () => {
  const bs = String.fromCharCode(92);
  for (const bad of [`https:${bs}${bs}evil.example/x`, `https://good.example${bs}@evil.example`, 'https://good.example/a b', ' https://good.example/', `https://good.example/${String.fromCharCode(9)}`, `https://good.example/${String.fromCharCode(0)}`]) {
    assert.equal(isNavigableUrl(bad), false, JSON.stringify(bad));
  }
  assert.equal(hasUnsafeUrlChars('https://good.example/path?x=1&y=%5C'), false, 'a percent-encoded backslash is data, not a separator');
  assert.equal(hasUnsafeUrlChars(`a${bs}b`), true);
});

test('RS-02: formatBytes shows photo sizes for people', () => {
  assert.equal(formatBytes(0), '0 bytes');
  assert.equal(formatBytes(1023), '1023 bytes');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(48213), '47.1 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(1.5), '—');
  assert.equal(formatBytes('12'), '—');
});
