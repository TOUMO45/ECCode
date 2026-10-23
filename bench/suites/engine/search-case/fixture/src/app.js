'use strict';
const directory = require('./directory');
const { buildIndex, search } = require('./search');

/** Handles of the people whose name matches every word of the query. */
function findPeople(dir, query) {
  const index = buildIndex(directory.all(dir).map((p) => ({ id: p.handle, text: p.name })));
  return search(index, query);
}

module.exports = { findPeople };
