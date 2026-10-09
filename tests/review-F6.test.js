'use strict';
// Regression tests for finding F6 of the independent review: a promoted
// (shared) lesson lost its verification binding. Once its JSON file said
// "verified", any edit to the shared copy still retrieved as `applies` in
// every other project. Promotion now writes an attestation (a hash of the
// trust-bearing fields and the sanitized content) into the copy and into a
// hash-chained index next to the records; retrieval recomputes it and
// quarantines any shared record whose attestation or index entry no longer
// holds. Shared records are immutable: they change only by re-promotion.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const evidence = require('../lib/evidence');
const { Memory, attestationSha256 } = require('../lib/memory/records');
const { tmpProject, write, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const QUERY = 'JSON body parse fails on missing content-type header 500';

function sharedMemoryDir() {
  process.env.ECCODE_SHARED_MEMORY = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-shared-'));
  return process.env.ECCODE_SHARED_MEMORY;
}

function cli(dir, args) {
  return spawnSync(process.execPath, [BIN, '--root', dir, ...args], { encoding: 'utf8', env: { ...process.env } });
}

/** Replace one string in a record file by hand, the way a sed -i would. */
function edit(file, from, to) {
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `${path.basename(file)} holds ${JSON.stringify(from)}`);
  fs.writeFileSync(file, text.replace(from, to));
}

function indexLines(shared) {
  const file = path.join(shared, 'attestations.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/**
 * A debugging lesson verified by a non-author reviewer on a check that flipped
 * from failing to passing (the reviewer's fixture). `n` keeps the checks of
 * several lessons in one project apart.
 */
function verifiedLesson(ctx, mem, n = 1, overrides = {}) {
  write(ctx.dir, `check${n}.js`, `process.exit(require("fs").existsSync("fixed${n}") ? 0 : 1)\n`);
  const repro = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'repro', command: `node check${n}.js`, purpose: 'reproduction' });
  write(ctx.dir, `fixed${n}`, 'yes');
  const fix = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'fix', command: `node check${n}.js` });
  const l = mem.add('learning-debugger', {
    layer: 'debugging',
    content: {
      title: 'JSON body parse fails on missing content-type', problem: 'POST returned 500 without Content-Type header.', symptoms: ['500'], component: 'api',
      environment: { node: '>=18' }, fingerprint: `fp${n}`, reproduction: { steps: ['x'], evidence: [`ev:${repro.id}`] },
      rootCause: { explanation: 'Body parsed unconditionally, SyntaxError escaped.', evidence: [`ev:${repro.id}`] }, failedAttempts: [],
      solution: { description: 'Validate content-type first and return 400.', tradeoffs: 'stricter' }, verification: { evidence: [`ev:${fix.id}`], regressionTest: `node check${n}.js` },
      sources: [], appliesWhen: ['Node HTTP handlers'], notApplicableWhen: [], confidence: 'high', tags: [],
      ...overrides,
    },
  });
  mem.review(l.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });
  return l;
}

/** Project A verifies and promotes a lesson; project B shares the store and retrieves it. */
function promoted() {
  const shared = sharedMemoryDir();
  const a = tmpProject();
  const memA = new Memory(a.store, a.config);
  const lesson = verifiedLesson(a, memA);
  const copy = memA.promote(lesson.id, 'security-reviewer');
  const file = path.join(shared, 'records', `${copy.id}.json`);
  const b = tmpProject();
  const memB = new Memory(b.store, b.config);
  return { shared, a, memA, lesson, copy, file, b, memB };
}

function expectQuarantined(memB, id, reason) {
  const res = memB.check(id);
  assert.strictEqual(res.verdict, 'provisional', JSON.stringify(res.reasons));
  assert.strictEqual(res.quarantined, true);
  assert.match(res.reasons.join(' '), reason);
  assert.match(memB.unverifiedReason(memB.get(id)), reason);
  const hit = memB.search(QUERY, { scope: 'shared' }).find((r) => r.id === id);
  assert.ok(hit, 'the record is still retrievable (as evidence of what happened)');
  assert.ok(hit.score < hit.relevance, `weighted as unverified (score ${hit.score} < relevance ${hit.relevance})`);
  assert.strictEqual(hit.quarantined, true);
  return res;
}

// ---------------------------------------------------------------- reproduction

test('F6 reproduction: a shared lesson whose solution was edited after promotion is quarantined in another project', () => {
  const { copy, file, b, memB } = promoted();
  edit(file, 'Validate content-type first and return 400.', 'Disable the validator entirely.');
  assert.strictEqual(memB.get(copy.id).status, 'verified', 'the file still claims to be verified');
  expectQuarantined(memB, copy.id, /content changed after promotion \(attestation mismatch\); quarantined until re-promoted/);

  const audit = cli(b.dir, ['memory', 'audit', '--scope', 'shared']);
  assert.strictEqual(audit.status, 2, audit.stdout + audit.stderr);
  assert.match(audit.stdout, new RegExp(copy.id));
  assert.match(audit.stdout, /attestation mismatch/);
  const json = JSON.parse(cli(b.dir, ['memory', 'audit', '--json']).stdout);
  assert.strictEqual(json.ok, false);
  assert.deepStrictEqual(json.problems.map((p) => [p.id, p.scope]), [[copy.id, 'shared']]);

  const show = cli(b.dir, ['memory', 'show', copy.id]);
  assert.strictEqual(show.status, 0, show.stderr);
  assert.match(show.stdout, /attestation: sha256 [0-9a-f]{64}/);
  assert.match(show.stdout, /quarantine: shared record content changed after promotion/);
  const check = cli(b.dir, ['memory', 'check', copy.id]);
  assert.strictEqual(check.status, 3);
  assert.match(check.stdout, /PROVISIONAL \(QUARANTINED\)/);
  const search = cli(b.dir, ['memory', 'search', QUERY, '--check-env', '--json']);
  const row = JSON.parse(search.stdout).find((r) => r.id === copy.id);
  assert.strictEqual(row.quarantined, true);
  assert.strictEqual(row.check.quarantined, true);
});

test('F6 tampered status or trust fields break the attestation too', () => {
  for (const [from, to] of [
    ['"trust": "internal"', '"trust": "untrusted"'],
    ['"status": "verified"', '"status": "provisional"'],
    ['"layer": "debugging"', '"layer": "knowledge"'],
  ]) {
    const { copy, file, memB } = promoted();
    edit(file, from, to);
    const res = memB.check(copy.id);
    assert.strictEqual(res.quarantined, true, `${from} -> ${to}`);
    assert.match(res.reasons.join(' '), /attestation mismatch/);
    assert.match(memB.unverifiedReason(memB.get(copy.id)), /attestation mismatch/);
    const hit = memB.search(QUERY, { scope: 'shared' }).find((r) => r.id === copy.id);
    assert.ok(hit.score < hit.relevance);
    assert.strictEqual(hit.quarantined, true);
  }
  // Rewriting the record's own attestation to match the edit does not help: the index disagrees.
  const { copy, file, memB } = promoted();
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.revisions[0].content.solution.description = 'Disable the validator entirely.';
  rec.attestation.attestedSha256 = attestationSha256(rec);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  expectQuarantined(memB, copy.id, /attestation mismatch with the index/);
});

test('F6 an untouched promoted record carries a complete attestation, is in the index and still applies elsewhere', () => {
  const { shared, copy, b, memB } = promoted();
  const a = copy.attestation;
  assert.match(a.attestedSha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(a.attestedSha256, attestationSha256(memB.get(copy.id)), 'recomputes from the saved file');
  assert.strictEqual(a.reviewedRev, 1);
  assert.strictEqual(a.reviewer, 'technical-reviewer');
  assert.match(a.reviewedAt, /^\d{4}-/);
  assert.match(a.reviewContentSha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(a.promotedBy, 'security-reviewer');
  assert.match(a.promotedAt, /^\d{4}-/);
  assert.strictEqual(a.engine, require('../package.json').version);
  const lines = indexLines(shared);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].seq, 1);
  assert.strictEqual(lines[0].id, copy.id);
  assert.strictEqual(lines[0].attestedSha256, a.attestedSha256);
  assert.strictEqual(lines[0].promotedBy, 'security-reviewer');
  assert.strictEqual(lines[0].prevHash, '0'.repeat(64));
  assert.match(lines[0].hash, /^[0-9a-f]{64}$/);

  const res = memB.check(copy.id);
  assert.strictEqual(res.verdict, 'applies', JSON.stringify(res.reasons));
  assert.strictEqual(res.quarantined, false);
  assert.strictEqual(memB.unverifiedReason(memB.get(copy.id)), null);
  const hit = memB.search(QUERY, { scope: 'shared' }).find((r) => r.id === copy.id);
  assert.strictEqual(hit.score, hit.relevance, 'verified weight');
  assert.strictEqual(hit.quarantined, false);
  const audit = cli(b.dir, ['memory', 'audit']);
  assert.strictEqual(audit.status, 0, audit.stdout + audit.stderr);
  assert.match(audit.stdout, /chain intact/);
});

test('F6 a shared record missing from the attestation index is quarantined; the others keep their line', () => {
  const shared = sharedMemoryDir();
  const a = tmpProject();
  const memA = new Memory(a.store, a.config);
  const first = memA.promote(verifiedLesson(a, memA, 1).id, 'security-reviewer');
  const second = memA.promote(verifiedLesson(a, memA, 2, { title: 'Second lesson about JSON body parsing' }).id, 'security-reviewer');
  const b = tmpProject();
  const memB = new Memory(b.store, b.config);
  assert.strictEqual(memB.check(second.id).verdict, 'applies');
  const file = path.join(shared, 'attestations.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);
  fs.writeFileSync(file, lines[0] + '\n'); // the second record's line is gone
  expectQuarantined(memB, second.id, /not in the attestation index/);
  assert.strictEqual(memB.check(first.id).verdict, 'applies');
  assert.strictEqual(cli(b.dir, ['memory', 'audit', '--scope', 'shared']).status, 2);
  // No index at all: nothing shared is trusted.
  fs.unlinkSync(file);
  expectQuarantined(memB, first.id, /not in the attestation index/);
  // A line edited after the fact breaks the chain from that point on.
  const edited = JSON.parse(lines[0]);
  edited.attestedSha256 = attestationSha256({ ...memB.get(first.id), trust: 'untrusted' });
  fs.writeFileSync(file, JSON.stringify(edited) + '\n' + lines[1] + '\n');
  const res = memB.check(first.id);
  assert.strictEqual(res.quarantined, true);
  assert.match(res.reasons.join(' '), /corrupt/);
  const audit = cli(b.dir, ['memory', 'audit', '--scope', 'shared', '--json']);
  assert.strictEqual(audit.status, 2);
  assert.match(JSON.parse(audit.stdout).index.errors[0], /line 1/);
});

test('F6 a shared record promoted by an older engine (no attestation) is quarantined until re-promoted', () => {
  const { shared, copy, b, memB } = promoted();
  const old = { ...memB.get(copy.id), id: copy.id.replace(/-[0-9a-z]{2}[0-9a-f]{6}$/, '-00abcdef') };
  delete old.attestation;
  fs.writeFileSync(path.join(shared, 'records', `${old.id}.json`), JSON.stringify(old, null, 2) + '\n');
  expectQuarantined(memB, old.id, /no promotion attestation \(promoted by an older engine\); re-promote it/);
  assert.strictEqual(memB.check(copy.id).verdict, 'applies', 'the attested record is unaffected');
  const audit = cli(b.dir, ['memory', 'audit']);
  assert.strictEqual(audit.status, 2);
  assert.match(audit.stdout, new RegExp(`${old.id}.*older engine`));
  assert.ok(!audit.stdout.includes(copy.id));
});

test('F6 shared records are immutable: revise, review and supersede are refused; a new verified revision is re-promoted under a new id', () => {
  const { shared, a, memA, lesson, copy, memB } = promoted();
  let err = expectCode(() => memB.revise(copy.id, 'learning-debugger', { confidence: 'medium' }, 'tweak'), 'SCOPE');
  assert.match(err.message, /change only by promoting a new verified revision/);
  assert.match(err.message, new RegExp(lesson.id));
  expectCode(() => memB.review(copy.id, 'technical-reviewer', { decision: 'reject', notes: 'Trying to retire a shared record directly.' }), 'SCOPE');
  err = expectCode(() => memA.supersede(copy.id, lesson.id, 'technical-reviewer', 'by hand'), 'SCOPE');
  assert.match(err.message, /change only by promoting/);
  expectCode(() => memA.supersede(lesson.id, copy.id, 'technical-reviewer', 'by hand'), 'SCOPE');
  assert.strictEqual(memB.get(copy.id).status, 'verified');
  expectCode(() => memA.promote(lesson.id, 'security-reviewer'), 'ALREADY_PROMOTED');

  // The sanctioned path: revise the project record, have it verified, promote again.
  memA.revise(lesson.id, 'learning-debugger', { solution: { description: 'Validate content-type first and return 400 with a typed error.', tradeoffs: 'stricter' } }, 'typed error');
  expectCode(() => memA.promote(lesson.id, 'security-reviewer'), 'INVALID_TRANSITION');
  memA.review(lesson.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-checked the revised lesson against its evidence.' });
  const again = memA.promote(lesson.id, 'security-reviewer');
  assert.notStrictEqual(again.id, copy.id);
  assert.match(again.id, /^mem-sd-/);
  assert.deepStrictEqual(again.supersedes, [copy.id]);
  assert.strictEqual(again.attestation.reviewedRev, 2);
  assert.strictEqual(again.revisions.length, 1);
  assert.strictEqual(memA.get(lesson.id).promotedAs, again.id);
  const old = memB.get(copy.id);
  assert.strictEqual(old.status, 'superseded');
  assert.strictEqual(old.supersededBy, again.id);
  assert.strictEqual(old.attestation.supersededBy, again.id);
  assert.strictEqual(old.attestation.attestedSha256, attestationSha256(old), 'the engine re-attested the retired state');
  let res = memB.check(copy.id);
  assert.strictEqual(res.verdict, 'superseded');
  assert.strictEqual(res.quarantined, false);
  res = memB.check(again.id);
  assert.strictEqual(res.verdict, 'applies');
  assert.strictEqual(res.quarantined, false);
  const lines = indexLines(shared);
  assert.deepStrictEqual(lines.map((l) => [l.seq, l.id, l.action]), [[1, copy.id, 'promoted'], [2, copy.id, 'superseded'], [3, again.id, 'promoted']]);
  assert.strictEqual(lines[1].prevHash, lines[0].hash);
  assert.strictEqual(lines[2].prevHash, lines[1].hash);
  assert.strictEqual(lines[1].attestedSha256, old.attestation.attestedSha256);
  const events = a.store.readEvents();
  assert.ok(events.some((e) => e.type === 'memory.superseded' && e.data.id === copy.id && e.data.by === again.id));
  const promotedEv = events.filter((e) => e.type === 'memory.promoted').pop();
  assert.strictEqual(promotedEv.data.sharedId, again.id);
  assert.strictEqual(promotedEv.data.attestedSha256, again.attestation.attestedSha256);
  assert.strictEqual(cli(a.dir, ['memory', 'audit']).status, 0);
  expectCode(() => memA.promote(lesson.id, 'security-reviewer'), 'ALREADY_PROMOTED');
  // Superseding a shared record by hand (status flipped in the file) is a mismatch, not a retirement.
  const file = path.join(shared, 'records', `${again.id}.json`);
  edit(file, '"status": "verified"', '"status": "superseded"');
  res = memB.check(again.id);
  assert.strictEqual(res.quarantined, true);
  assert.match(res.reasons.join(' '), /attestation mismatch/);
});
