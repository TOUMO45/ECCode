'use strict';
// Synthetic, rules-like fixture for test/eval/heldout-hygiene.test.js. It contains NO held-out text.
// The self-check copies this file to a temporary directory, replaces the seed placeholder below with a
// held-out 5-word sequence (as a regex, words joined by \s+), and proves the hygiene check then fails
// with an id-only message. The placeholder is never replaced in the repository.
// The phrase "please reset my account password" also occurs in the synthetic dataset.json, so it must
// NOT count as an overlap (dataset phrasing is allowed).
const TEXT_RULES = Object.freeze([
  { id: 'SYN_OVERRIDE', re: /\b(?:ignore|disregard)\s+(?:all\s+)?previous\s+instructions?\b/gi },
  { id: 'SYN_ACCOUNT', re: /\bplease\s+reset\s+my\s+account\s+password\b/gi },
  { id: 'SYN_SEED', re: /__HYGIENE_SEED__/gi },
]);
module.exports = { TEXT_RULES };
