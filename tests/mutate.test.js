'use strict';
// eccode mutate: mutation testing on the lines a change added. A survivor is
// behavior no test checks; the source must always come back unchanged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const mutate = require('../lib/mutate');
const { tmpProject, write } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');
// Boundaries that change behavior (unlike clamp, where x < lo and x <= lo
// both return lo at x == lo: an equivalent mutant no test can kill).
const CODE = 'function price(qty) {\n  if (qty > 10) return qty * 9;\n  return qty * 10;\n}\nfunction shipping(total, member) {\n  if (total >= 50 || member) return 0;\n  return 5;\n}\nmodule.exports = { price, shipping };\n';
const WEAK = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { price, shipping } = require('../src/price');\ntest('typical', () => {\n  assert.strictEqual(price(5), 50);\n  assert.strictEqual(price(20), 180);\n  assert.strictEqual(shipping(100, false), 0);\n  assert.strictEqual(shipping(10, false), 5);\n});\n";
const STRONG = WEAK + "test('edges', () => {\n  assert.strictEqual(price(10), 100);\n  assert.strictEqual(price(11), 99);\n  assert.strictEqual(shipping(50, false), 0);\n  assert.strictEqual(shipping(10, true), 0);\n});\n";

/** A git repo whose base commit has a stub; the working tree adds the implementation. */
function repo(testText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-mutate-'));
  write(dir, 'package.json', '{"name":"m","version":"1.0.0","scripts":{"test":"node --test"}}');
  write(dir, 'src/price.js', 'module.exports = {};\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  write(dir, 'src/price.js', CODE);
  write(dir, 'tests/price.test.js', testText);
  return dir;
}

test('mutants come only from changed code lines, never from strings or comments', () => {
  const ms = mutate.mutantsFor('src/a.js', 'const s = "a < b && c"; // x > y\nif (a < b && c) go();\n', new Set([1, 2]));
  assert.ok(ms.length > 0);
  assert.ok(ms.every((m) => m.line === 2), JSON.stringify(ms));
  assert.deepStrictEqual(ms.map((m) => `${m.from}->${m.to}`).sort(), ['&&->||', '<-><='].sort());
  const py = mutate.mutantsFor('app/a.py', 'msg = "x and y"\nif x > 1 and not done:\n    return True\n', null);
  assert.deepStrictEqual(py.map((m) => `${m.line}:${m.from.trim()}->${m.to.trim()}`).sort(), ['2:>->>=', '2:and->or', '2:not->', '3:True->False'].sort());
  assert.deepStrictEqual(mutate.mutantsFor('tests/a.test.js', 'if (a < b) x();\n', null), [], 'test files are not mutated');
});

test('a weak test leaves survivors on the boundaries; a strong test kills them; the source comes back byte for byte', () => {
  const weak = repo(WEAK);
  const before = fs.readFileSync(path.join(weak, 'src/price.js'));
  const r = mutate.run(weak, { test: 'node --test', timeoutMs: 30000 });
  assert.ok(r.survived >= 2, `boundary mutants should survive a mid-range test: ${JSON.stringify(r.survivors)}`);
  assert.ok(r.survivors.some((s) => s.line === 2 && s.from === '>'), JSON.stringify(r.survivors));
  assert.ok(r.survivors.some((s) => s.line === 6 && s.from === '>='), JSON.stringify(r.survivors));
  assert.ok(fs.readFileSync(path.join(weak, 'src/price.js')).equals(before), 'source restored');
  assert.ok(!fs.existsSync(path.join(weak, '.eccode', 'cache', 'mutate-restore.json')));
  const strong = repo(STRONG);
  const r2 = mutate.run(strong, { test: 'node --test', timeoutMs: 30000 });
  assert.strictEqual(r2.survived, 0, JSON.stringify(r2.survivors));
  assert.ok(r2.killed >= 3);
  assert.ok(r2.score > r.score);
  for (const d of [weak, strong]) fs.rmSync(d, { recursive: true, force: true });
});

test('a red baseline stops mutation testing, and a mutant that does not parse is invalid, not killed', () => {
  const dir = repo(WEAK);
  assert.throws(() => mutate.run(dir, { test: 'node -e "process.exit(1)"' }), /baseline/);
  assert.strictEqual(mutate.parses('src/a.js', 'if (a <= ) {}\n'), false);
  assert.strictEqual(mutate.parses('src/a.js', 'if (a <= b) {}\n'), true);
  assert.strictEqual(mutate.parses('app/a.py', 'if x >= :\n    pass\n'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a killed run leaves a recovery file that the next run replays first', () => {
  const dir = repo(WEAK);
  const original = fs.readFileSync(path.join(dir, 'src/price.js'), 'utf8');
  fs.writeFileSync(path.join(dir, 'src/price.js'), original.replace('qty > 10', 'qty >= 10')); // as if killed mid-mutant
  fs.mkdirSync(path.join(dir, '.eccode', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.eccode', 'cache', 'mutate-restore.json'), JSON.stringify({ file: 'src/price.js', content: Buffer.from(original).toString('base64') }));
  const r = mutate.run(dir, { test: 'node --test', max: 1 });
  assert.match(r.recovered || '', /src\/price\.js/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'src/price.js'), 'utf8'), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: report, --min-score exit code, and --record stores mutation evidence', () => {
  const ctx = tmpProject();
  write(ctx.dir, 'package.json', '{"name":"m","version":"1.0.0","scripts":{"test":"node --test"}}');
  write(ctx.dir, 'src/price.js', 'module.exports = {};\n');
  execFileSync('git', ['add', '-A'], { cwd: ctx.dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'stub'], { cwd: ctx.dir });
  write(ctx.dir, 'src/price.js', CODE);
  write(ctx.dir, 'tests/price.test.js', WEAK);
  const run = (args) => spawnSync(process.execPath, [CLI, 'mutate', ...args], { cwd: ctx.dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: ctx.dir } });
  let r = run(['--test', 'node --test', '--min-score', '100']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /SURVIVED src\/price\.js:2/);
  assert.match(r.stdout, /Score: \d+\/\d+ killed/);
  r = run(['--test', 'node --test', '--record', '--actor', 'test-engineer']);
  assert.strictEqual(r.status, 0, r.stderr);
  const ev = Object.values(ctx.store.state().evidence).find((e) => e.kind === 'mutation');
  assert.ok(ev, 'mutation evidence recorded');
  assert.strictEqual(ev.command, 'node --test');
  assert.ok(ev.mutation.survived >= 2 && typeof ev.mutation.score === 'number');
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});
