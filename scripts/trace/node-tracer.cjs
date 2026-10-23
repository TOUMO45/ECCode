'use strict';
// Runtime module-load tracer (CommonJS). Loaded via NODE_OPTIONS=--require by
// `eccode impact --trace`: every in-project require() — including dynamic ones
// built from variables, which no static index can resolve — is appended as a
// from→to edge to ECCODE_TRACE_FILE. ESM `import` statements inside ESM files
// bypass Module._load; the impact output says when a trace saw nothing.
const Module = require('module');
const fs = require('fs');
const path = require('path');

const out = process.env.ECCODE_TRACE_FILE;
const root = process.env.ECCODE_TRACE_ROOT;
if (out && root) {
  const orig = Module._load;
  Module._load = function (request, parent) {
    const result = orig.apply(this, arguments);
    try {
      if (parent && parent.filename) {
        const resolved = Module._resolveFilename(request, parent);
        if (
          typeof resolved === 'string' && path.isAbsolute(resolved) &&
          resolved.startsWith(root) && parent.filename.startsWith(root) &&
          !resolved.includes(`${path.sep}node_modules${path.sep}`)
        ) {
          fs.appendFileSync(out, JSON.stringify({
            from: path.relative(root, parent.filename).split(path.sep).join('/'),
            to: path.relative(root, resolved).split(path.sep).join('/'),
          }) + '\n');
        }
      }
    } catch { /* tracing must never break the traced program */ }
    return result;
  };
}
