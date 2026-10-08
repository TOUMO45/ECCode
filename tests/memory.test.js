'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const evidence = require('../lib/evidence');
const { Memory, current } = require('../lib/memory/records');
const { satisfies, matchEnv } = require('../lib/memory/env');
const { tmpProject, write, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');

function withSharedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-shared-'));
  process.env.ECCODE_SHARED_MEMORY = dir;
  return dir;
}

/** Create the reproduction (fails) then the fix (passes) for the same check. */
function reproAndFix(ctx) {
  write(ctx.dir, 'check.js', 'process.exit(require("fs").existsSync("fixed") ? 0 : 1)\n');
  const repro = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'repro', command: 'node check.js', purpose: 'reproduction' });
  write(ctx.dir, 'fixed', 'yes');
  const fix = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'fix verified', command: 'node check.js' });
  return { repro, fix };
}

function lesson(ev, overrides = {}) {
  return {
    title: 'JSON body parse fails on missing content-type',
    problem: 'POST /api/triage returned 500 when clients omitted the Content-Type header.',
    symptoms: ['HTTP 500 on POST without content-type', 'SyntaxError: Unexpected token in JSON'],
    component: 'api/server',
    environment: { node: '>=18' },
    fingerprint: 'api-json-parse-500',
    reproduction: { steps: ['POST without header'], evidence: ev ? [`ev:${ev.repro.id}`] : [] },
    rootCause: { explanation: 'The handler parsed the body unconditionally and let SyntaxError escape as 500.', evidence: ev ? [`ev:${ev.repro.id}`] : [] },
    failedAttempts: [{ approach: 'Wrap only JSON.parse in try/catch', whyFailed: 'Empty bodies still crashed the validator downstream' }],
    solution: { description: 'Validate content-type and parse defensively; return 400 with a typed error.', tradeoffs: 'Rejects lenient clients that send JSON without the header.' },
    verification: { evidence: ev ? [`ev:${ev.fix.id}`] : [], regressionTest: 'node check.js' },
    sources: [{ title: 'Node.js JSON.parse docs', url: 'https://nodejs.org/api/', checkedAt: '2026-10-07' }],
    appliesWhen: ['Node HTTP handlers parsing JSON request bodies'],
    notApplicableWhen: ['Frameworks that already enforce content-type (e.g. express.json with type option)'],
    confidence: 'high',
    tags: ['json', 'http', '500'],
    ...overrides,
  };
}

test('semver ranges used for applicability checks', () => {
  assert.ok(satisfies('20.11.1', '>=18 <22'));
  assert.ok(!satisfies('22.1.0', '>=18 <22'));
  assert.ok(satisfies('4.18.2', '^4'));
  assert.ok(!satisfies('5.0.0', '^4.17'));
  assert.ok(satisfies('16.20.0', '<18 || >=22'));
  assert.ok(satisfies('1.2.9', '~1.2.3'));
  assert.ok(satisfies('3.4.5', '3.x'));
  assert.deepStrictEqual(matchEnv({ os: 'linux' }, { os: 'linux' }).ok, true);
  assert.match(matchEnv({ express: '^4' }, { node: '20.0.0' }).unknown[0], /express/);
});

test('lessons start provisional; verification needs a non-author reviewer and a check that flips from failing to passing', () => {
  withSharedDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);

  // A lesson with only a passing test is not proof.
  const pass = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'only passing', command: 'node -e "0"' });
  const weak = mem.add('learning-debugger', { layer: 'debugging', content: lesson({ repro: pass, fix: pass }) });
  assert.strictEqual(weak.status, 'provisional');
  let err = expectCode(() => mem.review(weak.id, 'technical-reviewer', { decision: 'verify', notes: 'Checked the evidence trail end to end.' }), 'LESSON_NOT_VERIFIABLE');
  assert.match(err.message, /no reproduction check that failed before the fix/);

  // Different commands for repro and fix: still not proof.
  write(ctx.dir, 'other.js', 'process.exit(0)\n');
  const r1 = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'repro', command: 'node -e "process.exit(1)"', purpose: 'reproduction' });
  const f1 = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'unrelated pass', command: 'node other.js' });
  const mismatched = mem.add('learning-debugger', { layer: 'debugging', content: lesson({ repro: r1, fix: f1 }) });
  err = expectCode(() => mem.review(mismatched.id, 'technical-reviewer', { decision: 'verify', notes: 'Checked the evidence trail end to end.' }), 'LESSON_NOT_VERIFIABLE');
  assert.match(err.message, /passing test alone does not prove/);

  // Reproduction unavailable keeps it provisional.
  const noRepro = mem.add('learning-debugger', { layer: 'debugging', content: lesson(null, { reproduction: { unavailable: 'only occurs on customer hardware' } }) });
  err = expectCode(() => mem.review(noRepro.id, 'technical-reviewer', { decision: 'verify', notes: 'Checked the evidence trail end to end.' }), 'LESSON_NOT_VERIFIABLE');
  assert.match(err.message, /stays provisional/);

  const ev = reproAndFix(ctx);
  const good = mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev) });
  err = expectCode(() => mem.review(good.id, 'learning-debugger', { decision: 'verify', notes: 'Self review attempt should be refused.' }), 'LESSON_NOT_VERIFIABLE');
  assert.match(err.message, /authored or revised/);
  const verified = mem.review(good.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran node check.js: fails before, passes after; root cause matches the stack trace.' });
  assert.strictEqual(verified.status, 'verified');
  assert.strictEqual(verified.evidenceSnapshots[ev.repro.id].status, 'failed');

  // Revision invalidates verification but keeps history.
  const revised = mem.revise(good.id, 'learning-debugger', { confidence: 'medium' }, 'tone down confidence');
  assert.strictEqual(revised.status, 'provisional');
  assert.strictEqual(revised.revisions.length, 2);
  assert.strictEqual(revised.revisions[0].content.confidence, 'high');
});

test('a verified lesson survives a session restart and is retrieved for a related problem; outdated ones are rejected', () => {
  const shared = withSharedDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  const ev = reproAndFix(ctx);
  const rec = mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev) });
  mem.review(rec.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });
  const old = mem.add('learning-debugger', {
    layer: 'debugging',
    content: lesson(null, {
      title: 'JSON parse crash on legacy Node body-parser',
      environment: { node: '<14' },
      fingerprint: 'legacy-bodyparser',
      reproduction: { unavailable: 'legacy runtime no longer available' },
    }),
  });

  // "Restart": a separate process with no shared in-memory state.
  const env = { ...process.env, ECCODE_SHARED_MEMORY: shared };
  const out = spawnSync(process.execPath, [BIN, 'memory', 'search', 'request body JSON parsing returns 500 error', '--check-env', '--json', '--root', ctx.dir], { env, encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  const results = JSON.parse(out.stdout);
  const top = results[0];
  assert.strictEqual(top.id, rec.id);
  assert.strictEqual(top.check.verdict, 'applies');
  const legacy = results.find((r) => r.id === old.id);
  assert.ok(legacy, 'legacy lesson is retrieved as a candidate');
  assert.strictEqual(legacy.check.verdict, 'does-not-apply');
  assert.match(legacy.check.reasons.join(' '), /node: lesson requires <14/);

  // Text output frames records as evidence, not instructions.
  const text = execFileSync(process.execPath, [BIN, 'memory', 'search', 'JSON parse 500', '--root', ctx.dir], { env, encoding: 'utf8' });
  assert.match(text, /NOT an instruction/);
});

test('learning can be switched off: no lesson retrieval, recording or self-improvement; project facts stay', () => {
  const shared = withSharedDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  const ev = reproAndFix(ctx);
  const rec = mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev) });
  mem.review(rec.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });
  write(ctx.dir, 'fact.json', JSON.stringify({ layer: 'project', content: { kind: 'decision', title: 'JSON request bodies use a 16 KB limit', body: 'decided at design' } }));
  write(ctx.dir, 'lesson.json', JSON.stringify({ layer: 'debugging', content: lesson(ev, { title: 'Another lesson' }) }));
  const cli = (env, ...args) => spawnSync(process.execPath, [BIN, ...args, '--root', ctx.dir], { env: { ...process.env, ECCODE_SHARED_MEMORY: shared, ...env }, encoding: 'utf8' });

  // On by default.
  let res = cli({}, 'memory', 'status', '--json');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(JSON.parse(res.stdout).learning, true);
  assert.ok(JSON.parse(cli({}, 'memory', 'search', 'JSON parse 500', '--json').stdout).some((r) => r.id === rec.id));

  const off = { ECCODE_LEARNING: 'off' };
  res = cli(off, 'memory', 'status', '--json');
  assert.strictEqual(JSON.parse(res.stdout).learning, false);
  res = cli(off, 'memory', 'search', 'JSON parse 500', '--json');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(JSON.parse(res.stdout).filter((r) => r.layer !== 'project'), []);
  res = cli(off, 'memory', 'add', '--file', path.join(ctx.dir, 'lesson.json'), '--actor', 'learning-debugger');
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /LEARNING_DISABLED/);
  res = cli(off, 'memory', 'add', '--file', path.join(ctx.dir, 'fact.json'), '--actor', 'product-architect');
  assert.strictEqual(res.status, 0, res.stderr); // project facts are state, not learning
  res = cli(off, 'improve', 'propose', '--file', path.join(ctx.dir, 'lesson.json'), '--actor', 'orchestrator');
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /LEARNING_DISABLED/);

  // The config switch works the same way; the env var overrides it either way.
  const cfgFile = path.join(ctx.dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.memory = { ...cfg.memory, learning: false };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  assert.strictEqual(JSON.parse(cli({}, 'memory', 'status', '--json').stdout).learning, false);
  assert.strictEqual(JSON.parse(cli({ ECCODE_LEARNING: 'on' }, 'memory', 'status', '--json').stdout).learning, true);
  res = cli({ ECCODE_LEARNING: 'maybe' }, 'memory', 'status', '--json');
  assert.strictEqual(res.status, 2); // ambiguous values are refused, not guessed
});

test('relevance assessments: a lesson is rejected for a problem with a different cause, with evidence', () => {
  const shared = withSharedDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  const ev = reproAndFix(ctx);
  const rec = mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev) });
  mem.review(rec.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });
  // Same symptom, different cause: the experiment shows the lesson's root cause is absent.
  write(ctx.dir, 'probe.js', 'process.exit(0)\n');
  const probe = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'content-type present on failing requests', command: 'node probe.js' });
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args, '--root', ctx.dir], { env: { ...process.env, ECCODE_SHARED_MEMORY: shared }, encoding: 'utf8' });

  let res = cli('memory', 'assess', rec.id, '--actor', 'backend-engineer', '--verdict', 'does-not-apply', '--reason', 'Requests carry Content-Type; the 500 comes from a schema mismatch.', '--evidence', `ev:${probe.id}`);
  assert.strictEqual(res.status, 0, res.stderr);
  const after = mem.get(rec.id);
  assert.strictEqual(after.assessments.length, 1);
  assert.strictEqual(after.assessments[0].verdict, 'does-not-apply');
  assert.deepStrictEqual(after.assessments[0].evidence, [`ev:${probe.id}`]);
  assert.strictEqual(after.status, 'verified', 'rejecting a lesson for one problem does not invalidate it');

  // Verdicts need evidence that exists, and a known verdict.
  res = cli('memory', 'assess', rec.id, '--actor', 'backend-engineer', '--verdict', 'does-not-apply', '--reason', 'no proof');
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /needs at least one --evidence/);
  res = cli('memory', 'assess', rec.id, '--actor', 'backend-engineer', '--verdict', 'does-not-apply', '--reason', 'bogus', '--evidence', 'ev:ev-nope');
  assert.strictEqual(res.status, 2);
  res = cli('memory', 'assess', rec.id, '--actor', 'backend-engineer', '--verdict', 'maybe', '--reason', 'x', '--evidence', `ev:${probe.id}`);
  assert.strictEqual(res.status, 2);

  // Metrics count relevance decisions separately from environment checks.
  res = cli('metrics', '--json');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(JSON.parse(res.stdout).summary.lessonRelevanceDecisions, { 'does-not-apply': 1 });
});

test('stale and superseded lessons are flagged rather than trusted', () => {
  withSharedDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  const ev = reproAndFix(ctx);
  const a = mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev) });
  mem.review(a.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });
  process.env.ECCODE_NOW = new Date(Date.now() + 400 * 86400000).toISOString();
  try {
    assert.strictEqual(mem.check(a.id).verdict, 'stale');
  } finally {
    delete process.env.ECCODE_NOW;
  }
  const b = mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev, { title: 'JSON body parse fails: refined lesson v2' }) });
  const dup = mem.duplicates(0.8).find((p) => [p.a, p.b].includes(a.id) && [p.a, p.b].includes(b.id));
  assert.ok(dup, 'near-duplicate lessons are detected for consolidation');
  expectCode(() => mem.supersede(a.id, b.id, 'learning-debugger', 'refined'), 'INVALID_TRANSITION'); // b not verified yet
  mem.review(b.id, 'security-reviewer', { decision: 'verify', notes: 'Same evidence chain, clearer root cause wording.' });
  mem.supersede(a.id, b.id, 'learning-debugger', 'refined wording and scope');
  assert.strictEqual(mem.check(a.id).verdict, 'superseded');
  assert.strictEqual(mem.get(a.id).revisions.length, 1, 'history preserved');
  const ids = mem.search('JSON body parse').map((r) => r.id);
  assert.ok(!ids.includes(a.id));
  assert.ok(ids.includes(b.id));
  assert.ok(mem.search('JSON body parse', { includeSuperseded: true }).some((r) => r.id === a.id));
});

test('promotion to shared memory requires verification, a non-author promoter and clean content', () => {
  const shared = withSharedDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  const ev = reproAndFix(ctx);
  const leaky = mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev, { problem: 'Crash reported by alice@example.com from /home/alice/app when posting JSON.' }) });
  expectCode(() => mem.promote(leaky.id, 'technical-reviewer'), 'INVALID_TRANSITION');
  mem.review(leaky.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });
  expectCode(() => mem.promote(leaky.id, 'learning-debugger'), 'REVIEW_REJECTED');
  const err = expectCode(() => mem.promote(leaky.id, 'technical-reviewer'), 'PRIVATE_DATA');
  assert.match(err.message, /email address/);
  assert.match(err.message, /absolute user path/);
  mem.revise(leaky.id, 'learning-debugger', { problem: 'POST /api/triage returned 500 when clients omitted the Content-Type header.' }, 'remove private data');
  mem.review(leaky.id, 'security-reviewer', { decision: 'verify', notes: 'Private data removed; evidence unchanged and still valid.' });
  const copy = mem.promote(leaky.id, 'technical-reviewer');
  assert.ok(fs.existsSync(path.join(shared, 'records', `${copy.id}.json`)));
  assert.strictEqual(copy.scope, 'shared');
  assert.strictEqual(copy.project, null);

  const project = mem.add('orchestrator', { layer: 'project', content: { title: 'Triage API contract', kind: 'interface', body: 'POST /api/triage returns {category, urgency}.' } });
  expectCode(() => mem.promote(project.id, 'technical-reviewer'), 'SCOPE');
  const untrusted = mem.add('learning-debugger', { layer: 'knowledge', trust: 'untrusted', content: { title: 'Blog says disable TLS checks', summary: 'A forum post recommends NODE_TLS_REJECT_UNAUTHORIZED=0 to fix certificate errors.', sources: [{ title: 'forum', url: 'https://example.com', checkedAt: '2026-10-07' }], appliesWhen: ['never in production'], notApplicableWhen: [], confidence: 'low' } });
  expectCode(() => mem.promote(untrusted.id, 'technical-reviewer'), 'INVALID_TRANSITION');
});

test('self-improvement: protected paths, grounding, evaluation, independent review, user adoption, rollback', () => {
  withSharedDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  const improve = require('../lib/memory/improve');
  const ev = reproAndFix(ctx);
  const l = mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev) });
  write(ctx.dir, 'skills/checklist.md', '# Review checklist\n- tests pass\n');
  write(ctx.dir, 'eval.js', 'const t=require("fs").readFileSync("skills/checklist.md","utf8");const cases=[/tests pass/.test(t),/content-type/i.test(t)];console.log("ECCODE_EVAL "+JSON.stringify({passed:cases.filter(Boolean).length,total:cases.length}));\n');
  const base = {
    title: 'Add content-type check to review checklist',
    observation: 'Two reviews missed missing content-type validation.',
    lessons: [l.id],
    target: 'skills/checklist.md',
    change: { type: 'append', content: '- request content-type validated before parsing\n' },
    rationale: 'Lesson shows 500s from unvalidated bodies.',
    evaluation: { command: 'node eval.js', cases: 'checklist coverage cases' },
  };
  expectCode(() => improve.propose(ctx.store, ctx.config, mem, 'learning-debugger', { ...base, target: '.eccode/config.json' }), 'PROTECTED_PATH');
  expectCode(() => improve.propose(ctx.store, ctx.config, mem, 'learning-debugger', base), 'UNGROUNDED'); // lesson still provisional
  mem.review(l.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });

  const prop = improve.propose(ctx.store, ctx.config, mem, 'learning-debugger', base);
  improve.evaluate(ctx.store, 'learning-debugger', prop.id, 'baseline');
  const evald = improve.evaluate(ctx.store, 'learning-debugger', prop.id, 'candidate');
  assert.strictEqual(evald.evaluation.baseline.passed, 1);
  assert.strictEqual(evald.evaluation.candidate.passed, 2);
  assert.strictEqual(fs.readFileSync(path.join(ctx.dir, 'skills/checklist.md'), 'utf8'), '# Review checklist\n- tests pass\n', 'candidate evaluation restores the file');
  expectCode(() => improve.review(ctx.store, 'learning-debugger', prop.id, 'approve', 'Looks good to me, I wrote it.'), 'REVIEW_REJECTED');
  improve.review(ctx.store, 'technical-reviewer', prop.id, 'approve', 'Candidate passes 2/2 vs 1/2 baseline; change is additive.');
  expectCode(() => improve.adopt(ctx.store, ctx.config, 'orchestrator', prop.id), 'USER_AUTH_REQUIRED');
  const adopted = improve.adopt(ctx.store, ctx.config, 'user', prop.id);
  assert.strictEqual(adopted.version, 1);
  assert.match(fs.readFileSync(path.join(ctx.dir, 'skills/checklist.md'), 'utf8'), /content-type/);
  improve.rollback(ctx.store, 'orchestrator', prop.id, 'regression found in later eval', { regression: true });
  assert.strictEqual(fs.readFileSync(path.join(ctx.dir, 'skills/checklist.md'), 'utf8'), '# Review checklist\n- tests pass\n');

  // A regressing candidate cannot be approved.
  const bad = improve.propose(ctx.store, ctx.config, mem, 'learning-debugger', { ...base, change: { type: 'replace', content: '# Review checklist\n' } });
  improve.evaluate(ctx.store, 'learning-debugger', bad.id, 'baseline');
  improve.evaluate(ctx.store, 'learning-debugger', bad.id, 'candidate');
  expectCode(() => improve.review(ctx.store, 'technical-reviewer', bad.id, 'approve', 'Trying to approve a regression.'), 'EVALUATION_FAILED');

  const m = require('../lib/memory/metrics').compute(ctx.store, ctx.config);
  assert.strictEqual(m.summary.workflowChangeRegressions, 1);
  assert.strictEqual(m.summary.workflowChangesAdopted, 1);
  assert.notStrictEqual(m.summary.medianTimeToVerifiedFixMinutes, undefined);
});

test('metrics count rejections, repeated bugs and recurrence after a fix', () => {
  withSharedDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  const ev = reproAndFix(ctx);
  const first = mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev, { occurredAt: '2026-01-01T00:00:00Z' }) });
  mem.review(first.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });
  mem.add('learning-debugger', { layer: 'debugging', content: lesson(ev, { title: 'JSON parse 500 came back after refactor', occurredAt: new Date(Date.now() + 60000).toISOString() }) });
  const m = require('../lib/memory/metrics').compute(ctx.store, ctx.config).summary;
  assert.strictEqual(m.repeatedBugFingerprints, '1/1 fingerprints seen more than once');
  assert.strictEqual(m.recurrenceAfterFix, 1);
  assert.ok(current(first).title);
});

test('promotion never leaks private data from evidence snapshots, review notes or old revisions', () => {
  const shared = withSharedDir();
  const ctx = tmpProject();
  const mem = new Memory(ctx.store, ctx.config);
  write(ctx.dir, 'check.js', 'process.exit(require("fs").existsSync("fixed") ? 0 : 1)\n');
  const abs = path.join(ctx.dir, 'check.js');
  const repro = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'repro', command: `node ${abs} # by alice@example.com`, purpose: 'reproduction' });
  write(ctx.dir, 'fixed', 'yes');
  const fix = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'fix', command: `node ${abs} # by alice@example.com` });
  const rec = mem.add('learning-debugger', { layer: 'debugging', content: lesson({ repro, fix }, { problem: 'Seen on /home/alice/app by the team: POST returned 500 on bad JSON.' }) });
  mem.revise(rec.id, 'learning-debugger', { problem: 'POST /api/triage returned 500 when clients omitted the Content-Type header.' }, 'remove path');
  mem.review(rec.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran in /home/bob/checkout; passes after the fix.' });
  const copy = mem.promote(rec.id, 'security-reviewer');
  const text = fs.readFileSync(path.join(shared, 'records', `${copy.id}.json`), 'utf8');
  for (const leak of [ctx.dir, '/home/alice', '/home/bob', 'alice@example.com', os.tmpdir()]) {
    assert.ok(!text.includes(leak), `shared copy leaks ${leak}`);
  }
  assert.strictEqual(copy.revisions.length, 1, 'only the reviewed revision is shared');
  assert.ok(Object.keys(copy.evidenceSnapshots).length >= 2, 'evidence travels, sanitized');
});
