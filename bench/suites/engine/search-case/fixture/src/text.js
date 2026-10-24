'use strict';
// Text helpers shared by the directory (handles) and the search index (names).

/** Trim and collapse runs of whitespace. Case is kept: handles are case-sensitive. */
function normalize(s) {
  return String(s).trim().replace(/\s+/g, ' ');
}

/** The words of a string, normalized. */
function tokens(s) {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

module.exports = { normalize, tokens };
