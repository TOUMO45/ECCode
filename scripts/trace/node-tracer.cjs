'use strict';
// Runtime module-load tracer (CommonJS). Loaded via NODE_OPTIONS=--require by
// `eccode impact --trace`: every in-project require() — including dynamic ones
// built from variables, which no static index can resolve — is appended as a
// from→to edge to ECCODE_TRACE_FILE. ESM `import`/import() edges are covered
// by esm-loader.mjs (module.register); the impact output says when a trace saw
// nothing.
const Module = require('module');
const fs = require('fs');
const path = require('path');

const out = process.env.ECCODE_TRACE_FILE;
const root = process.env.ECCODE_TRACE_ROOT;
const win = process.platform === 'win32';
const roots = [root, process.env.ECCODE_TRACE_ROOT_ALT].filter(Boolean);
// Project-relative path for either spelling of the root (8.3 short or long on
// Windows, compared case-insensitively there); null outside the project.
function rel(file) {
  for (const r of roots) {
    if ((win ? file.toLowerCase() : file).startsWith(win ? r.toLowerCase() : r)) return file.slice(r.length).split(path.sep).join('/');
  }
  return null;
}
if (out && root) {
  const orig = Module._load;
  Module._load = function (request, parent) {
    const result = orig.apply(this, arguments);
    try {
      if (parent && parent.filename) {
        const resolved = Module._resolveFilename(request, parent);
        if (typeof resolved === 'string' && path.isAbsolute(resolved) && !resolved.includes(`${path.sep}node_modules${path.sep}`)) {
          const to = rel(resolved);
          const from = rel(parent.filename);
          if (to && from) fs.appendFileSync(out, JSON.stringify({ from, to }) + '\n');
        }
      }
    } catch { /* tracing must never break the traced program */ }
    return result;
  };
}
