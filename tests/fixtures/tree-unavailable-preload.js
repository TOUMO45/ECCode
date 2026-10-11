'use strict';
// Preloaded with `node -r` into a CLI child by tests/review-F2-F5b.test.js (TK-6 R2-4): the source tree
// digest cannot be computed, as when git fails inside a work tree. Not a test file (no .test.js suffix).
const project = require('../../lib/project');

project.treePin = () => ({ treeUnavailable: true });
