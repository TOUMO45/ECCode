'use strict';
// t01 extra check: .env.example equals the spec §Deployment block line for line,
// and the pinned scaffold-check.js sha256 is unchanged.
const fs = require('fs');
const crypto = require('crypto');
const spec = fs.readFileSync('.eccode/artifacts/design/spec.md', 'utf8');
const m = spec.match(/\*\*Environment\.\*\*[^\n]*\n```\n([\s\S]*?)```/);
if (!m) { console.log('FAIL spec block not found'); process.exit(1); }
const env = fs.readFileSync('.env.example', 'utf8');
if (env !== m[1]) { console.log('FAIL .env.example differs from spec block'); process.exit(1); }
console.log('PASS .env.example equals spec §Deployment block (' + (m[1].split('\n').length - 1) + ' lines)');
const h = crypto.createHash('sha256').update(fs.readFileSync('.eccode/artifacts/plan/checks/scaffold-check.js')).digest('hex');
if (h !== 'e1fde7f948af3fc7f50bd2b6ce033d6ab84455bbdb833e8c5c381d9ed0b6b647') { console.log('FAIL scaffold-check.js hash ' + h); process.exit(1); }
console.log('PASS scaffold-check.js sha256 matches plan');
