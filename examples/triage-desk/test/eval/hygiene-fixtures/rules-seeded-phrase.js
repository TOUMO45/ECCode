'use strict';
// Synthetic self-check fixture: seeded with a 5-word sequence of synthetic held-out row q-901
// (test/eval/hygiene-fixtures/holdout.json), written as a regex the way a rules author would.
const TEXT_RULES = Object.freeze([
  { id: 'SYN_SEEDED', re: /\bthe\s+quantum\s+toaster\s+refuses\s+every\b/gi },
]);
module.exports = { TEXT_RULES };
