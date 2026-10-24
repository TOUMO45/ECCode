'use strict';
// Puts the fixed commit's test files (hidden/files/) into the sandbox, over
// whatever the agent left at those paths, before a hidden check runs them.
// The same files the real fix shipped with; the agent never saw them.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'files');
const root = path.join(__dirname, '..');
(function copy(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const s = path.join(dir, e.name);
    const r = path.join(rel, e.name);
    if (e.isDirectory()) copy(s, r);
    else {
      fs.mkdirSync(path.dirname(path.join(root, r)), { recursive: true });
      fs.copyFileSync(s, path.join(root, r));
    }
  }
})(src, '');
