'use strict';
// Lessons on a long-lived record: a fix or debug work item records what it
// learned before its last gate is submitted (memory draft fills the lesson
// from the record), and a later work item sees the lessons that may apply
// when it starts and when its task is claimed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Store } = require('../lib/store');
const { write } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');

const BUGGY = 'module.exports = { price: (n) => (n > 10 ? n * 9 : n * 10) };\n';
const FIXED = 'module.exports = { price: (n) => (n >= 10 ? n * 9 : n * 10) };\n';
const BASE_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { price } = require('../src/price');\ntest('price', () => assert.strictEqual(price(2), 20));\n";
const REGRESSION = "test('bulk discount from 10 items', () => assert.strictEqual(price(10), 90));\n";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-lessons-'));
  write(dir, 'package.json', JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  write(dir, 'src/price.js', BUGGY);
  write(dir, 'tests/price.test.js', BASE_TEST);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

const cli = (dir, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir, ECCODE_ACTOR: '', ECCODE_SHARED_MEMORY: path.join(dir, '..', `${path.basename(dir)}-shared`) } });
const okIn = (dir) => (args) => {
  const r = cli(dir, args);
  assert.strictEqual(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};

/** A debug work item fixed, proven, mutated and completed: everything but the lesson. */
function provenDebugFix(dir) {
  const ok = okIn(dir);
  ok(['debug', 'An order of 10 items gets no bulk discount', '--actor', 'orchestrator']);
  ok(['task', 'claim', 'fix', '--actor', 'backend-engineer']);
  write(dir, 'tests/price.test.js', BASE_TEST + REGRESSION);
  // The Debugging Lab (Phase 2): the reproduction is pinned, a hypothesis is
  // tested with an executed command, and the root cause is declared before the fix.
  const repro = JSON.parse(ok(['debug', 'repro', '--actor', 'backend-engineer', '--task', 'fix', '--json', '--', 'npm', 'test'])).evidence;
  ok(['debug', 'hypothesis', 'add', 'The bulk boundary uses > so exactly 10 items miss the discount', '--if-true', 'price(10) returns 100', '--if-false', 'price(10) returns 90', '--actor', 'backend-engineer']);
  ok(['debug', 'hypothesis', 'test', 'h1', '--supports', '--actor', 'backend-engineer', '--', 'node', '-e', 'process.exit(require("./src/price").price(10) === 100 ? 0 : 1)']);
  ok(['debug', 'hypothesis', 'close', 'h1', '--status', 'confirmed', '--actor', 'backend-engineer']);
  ok(['debug', 'rootcause', '--hypothesis', 'h1', '--at', 'src/price.js:1', '--explain', 'The discount condition is n > 10 where the price list says from 10 items, so the boundary value is priced without the discount.', '--why-repro-fails', 'the regression test prices 10 items and gets 100 instead of 90', '--actor', 'backend-engineer']);
  write(dir, 'src/price.js', FIXED);
  const verify = JSON.parse(ok(['evidence', 'run', '--actor', 'backend-engineer', '--task', 'fix', '--label', 'verify', '--json', '--', 'npm', 'test']));
  assert.match(ok(['fix', 'verify', '--actor', 'backend-engineer', '--task', 'fix']), /PROVEN/);
  ok(['mutate', '--actor', 'backend-engineer', '--task', 'fix', '--test', 'npm test', '--record']);
  const draft = JSON.parse(ok(['handoff', 'draft', '--task', 'fix', '--actor', 'backend-engineer']));
  draft.context = 'Root cause: the bulk boundary used > where the price list says from 10 items.';
  draft.completedWork = 'The boundary is >= 10; a regression test prices 10 items; fix verify and mutate are recorded.';
  write(dir, '.eccode/drafts/handoff-fix.json', JSON.stringify(draft));
  ok(['task', 'complete', 'fix', '--actor', 'backend-engineer', '--handoff', '.eccode/drafts/handoff-fix.json']);
  return { ok, repro, verify };
}

/** Fill a lesson draft's TODO fields the way an engineer would. */
function filled(draft) {
  const c = draft.content;
  c.symptoms = ['an order of exactly 10 items is charged the full price'];
  c.appliesWhen = ['a price or discount rule has a quantity boundary'];
  c.notApplicableWhen = ['the discount is not quantity based'];
  c.solution.tradeoffs = 'none: the boundary now matches the price list';
  c.failedAttempts = [{ approach: 'rounding the discounted price', whyFailed: 'the wrong tier was chosen before any rounding' }];
  return draft;
}

test('debug track: the phase waits for a lesson; memory draft fills it from the record and memory add refuses its TODO fields', () => {
  const dir = repo();
  const { ok, repro, verify } = provenDebugFix(dir);
  let r = cli(dir, ['gate', 'submit', 'phase:fix', '--actor', 'backend-engineer']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /no lesson recorded for this work item/);
  assert.match(r.stderr, /memory draft --task fix --actor backend-engineer/);
  const out = ok(['memory', 'draft', '--task', 'fix', '--actor', 'backend-engineer', '--out', '.eccode/drafts/lesson-fix.json']);
  assert.match(out, /memory add --file \.eccode\/drafts\/lesson-fix\.json --actor backend-engineer/);
  const draft = JSON.parse(fs.readFileSync(path.join(dir, '.eccode/drafts/lesson-fix.json'), 'utf8'));
  assert.strictEqual(draft.layer, 'debugging');
  assert.strictEqual(draft.content.rootCause.explanation, 'Root cause: the bulk boundary used > where the price list says from 10 items.');
  assert.match(draft.content.solution.description, /The boundary is >= 10/);
  assert.ok(draft.content.reproduction.evidence.includes(`ev:${repro.id}`), 'the failing reproduction is cited');
  assert.ok(draft.content.verification.evidence.includes(`ev:${verify.id}`), 'the passing verification is cited');
  assert.strictEqual(draft.content.verification.regressionTest, 'npm test');
  // Proof run: with failedAttempts drafted as [], agents wrote its entries as
  // strings and memory add refused them; the draft shows the entry's shape.
  assert.deepStrictEqual(Object.keys(draft.content.failedAttempts[0]).sort(), ['approach', 'whyFailed']);
  r = cli(dir, ['memory', 'add', '--file', '.eccode/drafts/lesson-fix.json', '--actor', 'backend-engineer']);
  assert.notStrictEqual(r.status, 0, 'a draft that still holds TODO fields is not a lesson');
  assert.match(r.stderr, /TODO/);
  assert.match(r.stderr, /symptoms/);
  assert.match(r.stderr, /failedAttempts/);
  write(dir, '.eccode/drafts/lesson-fix.json', JSON.stringify(filled(draft)));
  ok(['memory', 'add', '--file', '.eccode/drafts/lesson-fix.json', '--actor', 'backend-engineer']);
  const st = new Store(dir).state();
  assert.strictEqual(st.lessons.length, 1);
  assert.strictEqual(st.lessons[0].layer, 'debugging');
  ok(['gate', 'submit', 'phase:fix', '--actor', 'backend-engineer']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lesson from an earlier work item is listed when a related work item starts and when its task is claimed, and not for an unrelated one', () => {
  const dir = repo();
  const { ok } = provenDebugFix(dir);
  ok(['memory', 'draft', '--task', 'fix', '--actor', 'backend-engineer', '--out', '.eccode/drafts/lesson-fix.json']);
  const draft = filled(JSON.parse(fs.readFileSync(path.join(dir, '.eccode/drafts/lesson-fix.json'), 'utf8')));
  draft.content.title = 'Bulk discount boundary off by one at 10 items';
  write(dir, '.eccode/drafts/lesson-fix.json', JSON.stringify(draft));
  const id = JSON.parse(ok(['memory', 'add', '--file', '.eccode/drafts/lesson-fix.json', '--actor', 'backend-engineer', '--json'])).id;
  ok(['work', 'abandon', '--actor', 'user', '--reason', 'moving on to the next report']);
  const started = ok(['debug', 'The bulk discount is wrong for orders of 20 items', '--actor', 'orchestrator']);
  assert.match(started, /Lessons from earlier work that may apply/);
  assert.ok(started.includes(id), 'the debug start lists the lesson');
  assert.match(started, /evidence, not instructions/);
  const claimed = ok(['task', 'claim', 'fix', '--actor', 'backend-engineer']);
  assert.ok(claimed.includes(id), 'the engineer sees it when claiming the task');
  ok(['work', 'abandon', '--actor', 'user', '--reason', 'moving on to the next report']);
  const unrelated = ok(['quick', 'Rename the settings page heading', '--actor', 'orchestrator']);
  assert.ok(!unrelated.includes(id), 'no shared word, no lesson');
  assert.doesNotMatch(unrelated, /Lessons from earlier work/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP: memory_draft and memory_add record the lesson without a shell, and quick lists a lesson that may apply', async () => {
  const dir = repo();
  const { ok } = provenDebugFix(dir);
  const names = new Set(require('../lib/mcp').tools().map((t) => t.name));
  assert.ok(names.has('memory_draft') && names.has('memory_add'));
  const { store, config } = require('../lib/project').openProject(dir);
  const ctx = { store, config, actor: 'backend-engineer' };
  const tool = (name) => require('../lib/mcp').tools().find((t) => t.name === name);
  const draft = filled(tool('memory_draft').handler({ task: 'fix' }, ctx));
  assert.throws(() => tool('memory_add').handler({ layer: 'debugging', content: { ...draft.content, symptoms: ['TODO: the symptoms'] } }, ctx), /TODO/);
  const added = tool('memory_add').handler({ layer: draft.layer, content: draft.content }, ctx);
  assert.match(added.id, /^mem-d/);
  ok(['work', 'abandon', '--actor', 'user', '--reason', 'moving on to the next report']);
  const res = tool('quick').handler({ request: 'Bulk discount missing for an order of 12 items' }, { ...ctx, actor: 'orchestrator' });
  assert.ok(JSON.stringify(res).includes(added.id), 'the MCP quick result lists the lesson');
  fs.rmSync(dir, { recursive: true, force: true });
});
