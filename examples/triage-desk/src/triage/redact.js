'use strict';
// Redactor (R11) for text sent to the live model: emails, Luhn-valid payment cards, then phone numbers, in that
// order (spec D3). Pure: no I/O, no clock, no randomness; content is never logged here or by callers (only counts).
// Reference implementation and binding vectors: .eccode/artifacts/design/design-vectors.js (redact).
//
// Cost (DES-4): NOT linear-time. The email and phone regexes rescan from every start position on near-miss input,
// O(n^2) in the worst case, bounded by the 8,000-character ticket cap. Budget: median of 3 runs < 200 ms per
// adversarial input (test/unit/redact.test.js). The patterns are deliberately kept as specified (see spec D3).

const EMAIL_PLACEHOLDER = '[REDACTED_EMAIL]';
const CARD_PLACEHOLDER = '[REDACTED_CARD]';
const PHONE_PLACEHOLDER = '[REDACTED_PHONE]';

// D3 step 1.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// D3 step 2: a digit run is digit groups joined by exactly one separator: space, NBSP (U+00A0), TAB or hyphen (DES-7).
const SEP = '[ \\u00a0\\t-]';
const DIGIT_RUN = new RegExp('\\d+(?:' + SEP + '\\d+)*', 'g');
const SEP_SPLIT = new RegExp('(' + SEP + ')'); // capturing: even index = digit group, odd index = separator
const CARD_MIN_DIGITS = 13;
const CARD_MAX_DIGITS = 19;

// D3 step 3: bounded unit count ({6,14}) so an over-long greedy match backtracks instead of hiding a phone.
const PHONE = /(?<![\w+])\+?(?:\(\d{1,4}\)|\d)(?:[ . \t-]?(?:\(\d{1,4}\)|\d)){6,14}(?!\w)/g;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Luhn checksum over a string of ASCII digits. */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * Marks every group that belongs to at least one group-aligned window of 13-19 digits passing Luhn (ARCH-10).
 * Every start i is tried and the window is extended while it holds <= 19 digits, so a shorter Luhn-valid window
 * inside a longer failing one (card + expiry, card + CVV, phone + card) is still found. O(groups x 19).
 */
function cardMarks(groups) {
  const mark = new Array(groups.length).fill(false);
  for (let i = 0; i < groups.length; i++) {
    let digits = '';
    for (let j = i; j < groups.length; j++) {
      digits += groups[j];
      if (digits.length > CARD_MAX_DIGITS) break; // a single group > 19 digits is atomic: never a card
      if (digits.length >= CARD_MIN_DIGITS && luhn(digits)) {
        for (let k = i; k <= j; k++) mark[k] = true;
      }
    }
  }
  return mark;
}

/** Replaces each maximal stretch of marked groups (with its inner separators) by one placeholder. */
function redactCards(text) {
  let count = 0;
  const out = text.replace(DIGIT_RUN, (run) => {
    const parts = run.split(SEP_SPLIT);
    const groups = parts.filter((_, i) => i % 2 === 0);
    const mark = cardMarks(groups);
    if (!mark.includes(true)) return run;
    let res = '';
    for (let g = 0; g < groups.length; g++) {
      if (!mark[g]) res += groups[g];
      else if (g === 0 || !mark[g - 1]) {
        res += CARD_PLACEHOLDER;
        count++;
      }
      // keep a separator unless it lies inside a marked stretch
      if (g < groups.length - 1 && !(mark[g] && mark[g + 1])) res += parts[2 * g + 1];
    }
    return res;
  });
  return { text: out, count };
}

/**
 * Redacts emails, Luhn-valid card numbers and phone numbers, in that order (spec D3, R11).
 * @param {string} text
 * @returns {{text:string, counts:{email:number, card:number, phone:number}}}
 */
function redact(text) {
  if (typeof text !== 'string') throw new TypeError('redact: text must be a string');
  const counts = { email: 0, card: 0, phone: 0 };

  let out = text.replace(EMAIL, () => {
    counts.email++;
    return EMAIL_PLACEHOLDER;
  });

  const cards = redactCards(out);
  out = cards.text;
  counts.card = cards.count;

  out = out.replace(PHONE, (m) => {
    const n = m.replace(/\D/g, '').length;
    if (n >= PHONE_MIN_DIGITS && n <= PHONE_MAX_DIGITS && !ISO_DATE.test(m)) {
      counts.phone++;
      return PHONE_PLACEHOLDER;
    }
    return m;
  });

  return { text: out, counts };
}

module.exports = { redact };
