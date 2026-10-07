'use strict';
// Stub detector: flags fixture tickets carrying the ATTACK tag.
function detectInjection(text) {
  const i = text.indexOf('ATTACK');
  return i < 0 ? { suspected: false, rules: [], spans: [] } : { suspected: true, rules: ['INJ_STUB'], spans: [{ start: i, end: text.length }] };
}
module.exports = { detectInjection, splitSentences: () => [] };
