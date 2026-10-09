'use strict';
// F6 (shared lessons keep their verification binding), variations not in tests/review-F6.test.js:
//   fields OUTSIDE the attested hash (attestation.reviewer, reviews[].notes, evidenceSnapshots, attestation.engine);
//   the FIRST index line deleted; index lines reordered; a record file replaced by another valid record under the
//   same id; the index rewritten and re-hashed to match a tampered record (residual 3); the guard fed an inline
//   ECCODE_SHARED_MEMORY redirect.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, attempt, report, cleanup } = require('./_lib');
const evidence = require(REPO + '/lib/evidence');
const { Memory, attestationSha256 } = require(REPO + '/lib/memory/records');
const { sha256 } = require(REPO + '/lib/util');
const { tmpProject, write } = require(REPO + '/tests/helpers');

const BIN = path.join(REPO, 'bin/eccode.js');
const SNAPSHOT = process.env.ECCODE_HEAD_SNAPSHOT || '/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/head-5da8913';
const GUARD = fs.existsSync(path.join(SNAPSHOT, 'scripts/hooks/guard.js')) ? path.join(SNAPSHOT, 'scripts/hooks/guard.js') : path.join(REPO, 'scripts/hooks/guard.js');
const QUERY = 'JSON body parse fails on missing content-type header 500';

const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-f6-shared-'));
process.env.ECCODE_SHARED_MEMORY = shared;
const INDEX = path.join(shared, 'attestations.jsonl');
const cli = (dir, args) => {
  const r = spawnSync(process.execPath, [BIN, '--root', dir, ...args], { encoding: 'utf8', env: { ...process.env } });
  return { ok: r.status === 0, exit: r.status, stdout: r.stdout.trim().slice(0, 400), stderr: r.stderr.trim().slice(0, 200) };
};

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

/** The engine's view of a shared record from project B: check verdict, quarantine flag, search weighting. */
function view(memB, id) {
  const res = memB.check(id);
  const hit = memB.search(QUERY, { scope: 'shared' }).find((r) => r.id === id);
  return { verdict: res.verdict, quarantined: res.quarantined, reasons: res.reasons.map((r) => r.slice(0, 120)), unverifiedReason: (memB.unverifiedReason(memB.get(id)) || '').slice(0, 120) || null, search: hit ? { quarantined: hit.quarantined, weightedDown: hit.score < hit.relevance } : null };
}
/** Expectation helper: ok = quarantined (the tamper was caught). */
const caught = (v) => ({ ok: v.quarantined === true && v.verdict !== 'applies', value: v });

const { step, finish, out } = report('F6-attestation-variations');
out.sharedDir = shared;
const dirs = [shared];
try {
  const a = tmpProject();
  dirs.push(a.dir);
  const memA = new Memory(a.store, a.config);
  const one = memA.promote(verifiedLesson(a, memA, 1).id, 'security-reviewer');
  const two = memA.promote(verifiedLesson(a, memA, 2, { title: 'Second lesson about JSON body parsing' }).id, 'security-reviewer');
  const file = (id) => path.join(shared, 'records', `${id}.json`);
  const original = fs.readFileSync(file(one.id), 'utf8');
  const originalIndex = fs.readFileSync(INDEX, 'utf8');
  const restore = () => { fs.writeFileSync(file(one.id), original); fs.writeFileSync(INDEX, originalIndex); };
  const b = tmpProject();
  dirs.push(b.dir);
  const memB = new Memory(b.store, b.config);

  step('F6.untouched', 'project B: the untouched promoted record applies', 'documented', { ok: view(memB, one.id).verdict === 'applies', value: view(memB, one.id) });

  const edit = (mutate) => { const rec = JSON.parse(fs.readFileSync(file(one.id), 'utf8')); mutate(rec); fs.writeFileSync(file(one.id), JSON.stringify(rec, null, 2) + '\n'); };
  edit((r) => { r.revisions[0].content.solution.description = 'Validate content-type first and return 401.'; }); // one byte: 400 -> 401
  step('F6.oneByte', 'one byte of the promoted solution changed (400 -> 401)', 'ok', caught(view(memB, one.id)));
  step('F6.oneByte.cli', 'memory check exit code (3 = provisional) and memory audit --scope shared exit code (2)', 'documented', { ok: true, value: { check: cli(b.dir, ['memory', 'check', one.id]).exit, audit: cli(b.dir, ['memory', 'audit', '--scope', 'shared']).exit } });
  restore();

  // Fields outside the attested hash.
  for (const [id, label, mutate] of [
    ['reviewer', 'attestation.reviewer changed to the lesson author (self-verification)', (r) => { r.attestation.reviewer = 'learning-debugger'; }],
    ['reviewNotes', 'reviews[0].notes rewritten', (r) => { r.reviews[0].notes = 'Did not run anything; looks fine.'; }],
    ['reviewDecision', 'reviews[0].decision changed from verify to reject', (r) => { r.reviews[0].decision = 'reject'; }],
    ['evidenceSnapshot', 'evidenceSnapshots: the verification check flipped to failed/exit 1', (r) => { for (const e of Object.values(r.evidenceSnapshots || {})) { e.status = 'failed'; e.exitCode = 1; } }],
    ['engine', 'attestation.engine set to 0.2.0', (r) => { r.attestation.engine = '0.2.0'; }],
    ['provenance', 'provenance.promotedBy changed', (r) => { r.provenance.promotedBy = 'learning-debugger'; }],
    ['lastVerifiedAt', 'lastVerifiedAt moved ten years ahead', (r) => { r.lastVerifiedAt = '2036-01-01T00:00:00.000Z'; }],
  ]) {
    edit(mutate);
    const v = view(memB, one.id);
    step(`F6.meta.${id}`, label, 'documented', { ok: v.quarantined, value: v }, v.quarantined ? 'caught' : 'NEW (non-blocking): outside the attested hash (layer, status, trust, content); the record still applies as verified');
    restore();
  }

  // Index: first line deleted; lines reordered; a line's attestedSha256 edited and the chain left alone.
  const lines = originalIndex.split('\n').filter(Boolean);
  fs.writeFileSync(INDEX, lines.slice(1).join('\n') + '\n');
  step('F6.index.firstLineDeleted', 'first line of attestations.jsonl deleted (two records promoted)', 'ok', caught(view(memB, one.id)));
  step('F6.index.firstLineDeleted.other', 'the second record under the same broken chain', 'ok', caught(view(memB, two.id)));
  restore();
  fs.writeFileSync(INDEX, [lines[1], lines[0]].join('\n') + '\n');
  step('F6.index.reordered', 'the two index lines swapped', 'ok', caught(view(memB, one.id)));
  restore();
  const extra = JSON.parse(lines[1]);
  extra.seq = 3; // a forged third line that does not link to line 2's hash
  fs.writeFileSync(INDEX, originalIndex + JSON.stringify(extra) + '\n');
  const appended = view(memB, two.id);
  step('F6.index.forgedAppend', 'a third line appended with a stale prevHash (the chain breaks AFTER the two good lines)', 'documented', { ok: true, value: { ...appended, auditExit: cli(b.dir, ['memory', 'audit', '--scope', 'shared']).exit } }, appended.quarantined ? 'quarantined' : 'by design: lines before the first broken link stay trusted (readAttestationIndex), so the two attested records still apply; memory audit reports the corrupt index (exit code recorded)');
  restore();

  // The record file for id one replaced by record two's content (a valid attested record) under id one.
  const twoRec = JSON.parse(fs.readFileSync(file(two.id), 'utf8'));
  twoRec.id = one.id;
  fs.writeFileSync(file(one.id), JSON.stringify(twoRec, null, 2) + '\n');
  step('F6.replacedFile', 'record one\'s file replaced by record two\'s valid content under id one (its own attestation recomputes)', 'ok', caught(view(memB, one.id)));
  restore();

  // Residual 3: rewrite the index with a fresh chain that attests the tampered content.
  edit((r) => { r.revisions[0].content.solution.description = 'Disable the validator entirely.'; r.attestation.attestedSha256 = attestationSha256(r); });
  const tampered = JSON.parse(fs.readFileSync(file(one.id), 'utf8'));
  const GENESIS = '0'.repeat(64);
  let prev = GENESIS;
  const forged = [];
  for (const [i, l] of lines.entries()) {
    const { hash, ...body } = JSON.parse(l);
    if (body.id === one.id) body.attestedSha256 = tampered.attestation.attestedSha256;
    body.prevHash = prev;
    const h = sha256(prev + JSON.stringify(body));
    forged.push(JSON.stringify({ ...body, hash: h }));
    prev = h;
    void i;
  }
  fs.writeFileSync(INDEX, forged.join('\n') + '\n');
  const laundered = view(memB, one.id);
  step('F6.rewriteAndRehash', 'solution replaced, record re-attested, attestations.jsonl rebuilt with a consistent chain', 'documented', { ok: laundered.verdict === 'applies' && !laundered.quarantined, value: { ...laundered, audit: cli(b.dir, ['memory', 'audit', '--scope', 'shared']).exit } }, 'RESIDUAL 3 (documented): the index lives on the same writable disk; a full rewrite is undetectable without an external checkpoint');
  restore();
  step('F6.restored', 'after restoring the files the record applies again', 'documented', { ok: view(memB, one.id).verdict === 'applies', value: view(memB, one.id).verdict });

  // Immutability sanity and the sanctioned path.
  step('F6.immutable.revise', 'revise a shared record directly', 'refused:SCOPE', attempt(() => memB.revise(one.id, 'learning-debugger', { confidence: 'medium' }, 'tweak')));
  step('F6.immutable.review', 'review a shared record directly', 'refused:SCOPE', attempt(() => memB.review(one.id, 'technical-reviewer', { decision: 'reject', notes: 'retiring it by hand, which should not work' })));

  // The guard and an inline shared-memory redirect from a subagent.
  const payload = { cwd: b.dir, tool_name: 'Bash', agent_type: 'eccode:learning-debugger', tool_input: { command: `ECCODE_SHARED_MEMORY=/tmp/forged-shared eccode memory search "content-type" --actor learning-debugger` } };
  const g = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_HOOKS: '', ECCODE_TEST: '' } });
  const go = g.stdout ? JSON.parse(g.stdout).hookSpecificOutput : null;
  step('F6.guard.sharedRedirect', 'guard: learning-debugger sets ECCODE_SHARED_MEMORY inline on an eccode memory command', 'documented', { decision: go ? go.permissionDecision : 'allow', reason: go ? go.permissionDecisionReason.slice(0, 160) : null }, go && go.permissionDecision === 'deny' ? 'denied' : 'NEW (non-blocking, residual-3 variant): a subagent can point the engine at a shared store it forged entirely; IDENTITY_ENV covers ECCODE_ACTOR/TEST/NOW only');
} finally {
  cleanup(...dirs);
}
finish();
