'use strict';
// The Round 1-lite registration hashes: built from the real harness and items, verified, and every kind of
// drift is reported. The freeze file itself is not written here (that happens once, at registration).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const freeze = require('../bench/suites/senior/_tools/r1lite-freeze');

const ROOT = path.join(__dirname, '..');

function copyOf(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-r1lite-'));
  for (const f of [...files, freeze.SCREENING]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  return dir;
}

test('the registration covers the harness, lib/bench.js, all 16 ambiguous items (request and question) and the screening records', () => {
  const f = freeze.build(ROOT);
  assert.strictEqual(f.items, 16);
  const names = Object.keys(f.files);
  assert.ok(names.includes('lib/bench.js'));
  assert.ok(names.some((n) => n.startsWith('bench/suites/senior/_tools/') && n.endsWith('label.js')));
  assert.strictEqual(names.filter((n) => /ambiguous-.*\/task\.json$/.test(n)).length, 16);
  assert.strictEqual(names.filter((n) => /ambiguous-.*\/question\.json$/.test(n)).length, 16);
  assert.ok(!names.some((n) => n.endsWith('r1lite-freeze.json')), 'the freeze file does not hash itself');
  assert.strictEqual(f.screening.runs, 48);
  assert.match(f.screening.sha256, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(freeze.verify(ROOT, f), []);
});

test('verify reports a changed, a missing and an unlisted file, and a changed screening record', () => {
  const f = freeze.build(ROOT);
  const dir = copyOf(Object.keys(f.files));
  assert.deepStrictEqual(freeze.verify(dir, f), []);
  const item = Object.keys(f.files).find((n) => /ambiguous-.*\/question\.json$/.test(n));
  fs.appendFileSync(path.join(dir, item), ' ');
  fs.rmSync(path.join(dir, 'lib/bench.js'));
  fs.writeFileSync(path.join(dir, 'bench/suites/senior/_tools/extra.js'), '// new\n');
  fs.appendFileSync(path.join(dir, freeze.SCREENING), '\n{}');
  const problems = freeze.verify(dir, f).join('\n');
  assert.match(problems, new RegExp(`${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: changed`));
  assert.match(problems, /lib\/bench\.js: missing/);
  assert.match(problems, /_tools\/extra\.js: not in the freeze/);
  assert.match(problems, /senior-screening\.ambiguous\.jsonl: changed/);
  fs.rmSync(dir, { recursive: true, force: true });
});
