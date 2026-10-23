'use strict';
// Text helpers shared by the search indexer and the reading-time widget.

/** Lowercased words of text, punctuation stripped ("It's a dog-eat-dog day!" -> ["it's", "a", "dog", "eat", "dog", "day"]). */
function words(text) {
  return String(text).toLowerCase().match(/[a-z0-9']+/g) || [];
}

/** Estimated reading time in whole minutes at 200 words per minute (at least 1). */
function readingMinutes(text) {
  return Math.max(1, Math.round(words(text).length / 200));
}

module.exports = { words, readingMinutes };
