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
  assert.deepStrictEqual(py.map((m) => `${m.line}:${m.from.trim()}->${m.to.trim()}`).sort(), ['2:>->>=', '2:and->or', '2:not->', '2:1->2', '3:True->False', '3:True->None'].sort());
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

test('TypeScript mutants run only when the project can syntax-check them; otherwise they are skipped and reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-mutate-ts-'));
  write(dir, 'package.json', '{"name":"m","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}');
  write(dir, 'src/a.ts', 'export {};\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  write(dir, 'src/a.ts', 'export function big(n: number): boolean {\n  return n > 10 && n < 100;\n}\n');
  const r = mutate.run(dir, { test: 'node -e "process.exit(0)"' });
  assert.strictEqual(r.total, 0, 'no TypeScript compiler in this project: nothing is mutated');
  assert.ok(r.skippedUnchecked >= 3);
  assert.match(mutate.format(r), /TypeScript\/JSX mutant\(s\) skipped/);
  fs.rmSync(dir, { recursive: true, force: true });
});

const GLOBAL_TS = path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim(), 'typescript');
test('with the project\'s TypeScript compiler, TS mutants run and broken TypeScript is rejected', { skip: !fs.existsSync(GLOBAL_TS) && !process.env.ECCODE_REQUIRE_TRACERS && 'no typescript to link' }, () => {
  assert.ok(fs.existsSync(GLOBAL_TS), 'ECCODE_REQUIRE_TRACERS=1: a TypeScript compiler must be installed so this check runs, not skips');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-mutate-ts2-'));
  write(dir, 'package.json', '{"name":"m","version":"1.0.0"}');
  write(dir, 'src/a.ts', 'export {};\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  write(dir, '.gitignore', 'node_modules/\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim(), 'typescript'), path.join(dir, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir');
  write(dir, 'src/a.ts', 'export function big(n: number): boolean {\n  return n > 10 && n < 100;\n}\n');
  const r = mutate.run(dir, { test: 'node -e "process.exit(0)"' });
  assert.strictEqual(r.skippedUnchecked, 0);
  assert.ok(r.total >= 3, JSON.stringify(r));
  assert.strictEqual(r.invalid, 0, 'these mutants all parse');
  write(dir, 'src/broken.ts', 'export const x = (n: number) => n >= ;\n');
  assert.strictEqual(mutate.tsChecker(dir)(path.join(dir, 'src/broken.ts')), false);
  assert.strictEqual(mutate.tsChecker(dir)(path.join(dir, 'src/a.ts')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('python mutants reach the lines real fixes change: identity, membership, constants and returned values', () => {
  const text = [
    'def f(a, items):',
    '    if a is None:',
    '        return 409',
    '    if a not in items:',
    '        return [i for i in items]',
    '    for k in items:',
    '        pass',
    '    return a',
    '',
  ].join('\n');
  const got = mutate.mutantsFor('app/x.py', text, null).map((m) => `${m.line}:${m.op}:${m.from}->${m.to}`);
  for (const want of ['2:identity:is->is not', '3:constant:409->410', '3:return-value:409->None', '4:membership:not in->in', '5:return-value:[i for i in items]->None', '8:return-value:a->None']) {
    assert.ok(got.includes(want), `${want} in ${JSON.stringify(got)}`);
  }
  assert.ok(!got.some((g) => /^[56]:membership/.test(g)), `no membership mutant on a for clause: ${JSON.stringify(got)}`);
  assert.ok(!got.some((g) => g.startsWith('4:negation')), 'not in is the membership operator, not a negation');
  assert.ok(!got.some((g) => /return-value:None->/.test(g)));
});

test('a mutant whose tests time out is stopped with everything they started', { skip: process.platform === 'win32' && 'process groups are POSIX' }, () => {
  const dir = repo(STRONG);
  const late = path.join(dir, 'late.txt');
  // The unmutated source passes at once; a mutant starts a writer and hangs past its time.
  write(dir, 'check.js', [
    "const fs = require('fs');",
    `if (fs.readFileSync('src/price.js', 'utf8') === ${JSON.stringify(CODE)}) process.exit(0);`,
    `require('child_process').spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 1500)", ${JSON.stringify(late)}], { stdio: 'ignore' });`,
    'setTimeout(() => {}, 10000);',
    '',
  ].join('\n'));
  const r = mutate.run(dir, { test: 'node check.js', files: ['src/price.js'], max: 1, timeoutMs: 700 });
  assert.strictEqual(r.timeouts, 1, JSON.stringify(r.mutants));
  const until = Date.now() + 2500;
  while (Date.now() < until) { /* wait past the writer's time */ }
  assert.strictEqual(fs.existsSync(late), false, 'the process the timed-out tests started was stopped with them');
  fs.rmSync(dir, { recursive: true, force: true });
});
