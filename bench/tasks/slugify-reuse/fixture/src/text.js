'use strict';
// Text helpers shared by the editor and the importer.

/** Lowercased, trimmed, inner whitespace collapsed to single spaces. */
function normalize(text) {
  return String(text).toLowerCase().trim().replace(/\s+/g, ' ');
}

module.exports = { normalize };
