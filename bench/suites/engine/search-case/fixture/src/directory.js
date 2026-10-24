'use strict';
const { normalize } = require('./text');

function create() {
  return new Map();
}

/** Register a person under a handle; a taken handle is refused. */
function register(dir, handle, name) {
  const key = normalize(handle);
  if (!key) throw new Error('empty handle');
  if (dir.has(key)) throw new Error(`handle taken: ${key}`);
  dir.set(key, { handle: key, name });
  return dir.get(key);
}

function lookup(dir, handle) {
  return dir.get(normalize(handle)) || null;
}

function all(dir) {
  return [...dir.values()];
}

module.exports = { create, register, lookup, all };
