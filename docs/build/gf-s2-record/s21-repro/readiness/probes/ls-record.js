'use strict';
const C = '/tmp/claude-0/-home-user-ECCode/0d6fc9dd-3a2d-58c2-bf17-c539c4d6f2ed/scratchpad/review-h3/copy';
const X = require(C + '/tests/fixtures/gf/close');
const fs = require('fs'); const path = require('path');
const ctx = X.closeProject();
const walk = (d, p = '') => fs.readdirSync(d).flatMap((n) => { const a = path.join(d, n); return fs.lstatSync(a).isDirectory() ? walk(a, p + n + '/') : [p + n]; });
console.log(ctx.dir); console.log(walk(path.join(ctx.dir, '.eccode')).join('\n'));
console.log(JSON.stringify(ctx.config.roles || {}, null, 0).slice(0, 400));
