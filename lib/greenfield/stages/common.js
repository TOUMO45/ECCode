'use strict';
// Shared by the stage validators: schema loading and the problem shape { rule, path, message }.
const fs = require('fs');
const path = require('path');
const { validate } = require('../jsonschema');

const SCHEMA_DIR = path.join(__dirname, '..', '..', '..', 'schemas');
const cache = new Map();

function schema(name) {
  if (!cache.has(name)) cache.set(name, JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `gf-${name}.schema.json`), 'utf8')));
  return cache.get(name);
}

const problem = (rule, p, message) => ({ rule, path: p, message });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const dupes = (list) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];

/** Shape problems of `doc` against schemas/gf-<name>.schema.json, labelled with the file name. */
function shape(rule, name, doc, label) {
  return validate(schema(name), doc).map((e) => problem(rule, `${label}${e.path}`, `${label}: ${e.path || '/'} ${e.message}`));
}

module.exports = { schema, problem, shape, isObj, arr, dupes };
