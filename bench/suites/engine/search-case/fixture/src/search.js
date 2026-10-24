'use strict';
const { tokens } = require('./text');

/** word -> ids of the documents containing it. docs: [{ id, text }] */
function buildIndex(docs) {
  const index = new Map();
  for (const doc of docs) {
    for (const word of tokens(doc.text)) {
      if (!index.has(word)) index.set(word, new Set());
      index.get(word).add(doc.id);
    }
  }
  return index;
}

/** Ids of the documents containing every word of the query, in index order. */
function search(index, query) {
  const words = tokens(query);
  if (!words.length) return [];
  let hits = null;
  for (const word of words) {
    const ids = index.get(word) || new Set();
    hits = hits === null ? [...ids] : hits.filter((id) => ids.has(id));
  }
  return hits;
}

module.exports = { buildIndex, search };
