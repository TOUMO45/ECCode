'use strict';
// TK-8 (RescueStock pilot): `eccode audit` reported "src/services/requests.js modified after approval
// (phase:rework-1)" although the file's bytes were exactly what phase:d-extraction approved later.
// `unreviewedChanges` built the latest approved version of each file by walking gateOrder, where rework
// gates sit after every plan phase, so an older rework approval overwrote a newer phase approval of the
// same file; `deletedInReviewedWork` looked for a deletion in gates *after* the pinning one in gate order
// too. Both now follow approval order (the event sequence of the approving reviews; lib/delivery.js
// approvalOrder, introduced for the release-tree baseline in TK-6 R2-3).
//
// Synthetic gate states over a real git history: C0 holds src/a.js v1 and src/gone.js; C1 changes
// src/a.js to v2 and deletes src/gone.js. The approving reviews' sequence numbers are in the log.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { initRepo, write } = require('./helpers');
const delivery = require('../lib/delivery');

const V1 = 'module.exports = "v1";\n';
const V2 = 'module.exports = "v2";\n';
const GONE = 'module.exports = "deleted later";\n';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const RELEASE = { release: { ignore: [] } };

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
}

function history() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tk8-'));
  initRepo(dir);
  write(dir, 'src/a.js', V1);
  write(dir, 'src/gone.js', GONE);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c0');
  const C0 = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/a.js', V2);
  fs.unlinkSync(path.join(dir, 'src', 'gone.js'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c1');
  const C1 = git(dir, 'rev-parse', 'HEAD');
  return { dir, C0, C1 };
}

/**
 * gates: [id, commit, artifacts {path: content}, seq]; tasks: {phase: filesChanged}. gateOrder puts the
 * rework gates after the phases, as the reducer does; the log holds each approving review's sequence.
 */
function record(dir, gates, tasks = {}) {
  const ordered = [...gates.filter(([id]) => !id.includes('rework')), ...gates.filter(([id]) => id.includes('rework'))];
  const gate = ([id, commit, artifacts]) => ({
    id,
    status: 'approved',
    approvedAt: '2026-10-11T10:00:00.000Z', // the same millisecond: the order must come from the log
    authors: [],
    approvedBy: 'technical-reviewer',
    iterations: 0,
    reviews: [],
    openFindings: [],
    submissions: [{ id: `sub-${id}`, commit, artifacts: Object.entries(artifacts).map(([p, c]) => ({ path: p, sha256: sha(c) })) }],
    approvedSubmission: `sub-${id}`,
  });
  const approval = ([id, , , seq]) => JSON.stringify({ seq, type: 'review.recorded', actor: 'technical-reviewer', data: { gate: id, reviewId: `rev-${id}`, submissionId: `sub-${id}`, review: { decision: 'approve' } } });
  write(dir, '.eccode/events.jsonl', gates.map(approval).join('\n') + '\n');
  const taskList = Object.entries(tasks).map(([phase, filesChanged]) => ({ id: `t-${phase}`, phase, files: ['src/**'], filesChanged, status: 'done' }));
  return {
    gateOrder: ordered.map(([id]) => id),
    gates: Object.fromEntries(ordered.map((g) => [g[0], gate(g)])),
    tasks: Object.fromEntries(taskList.map((t) => [t.id, t])),
    evidence: {},
  };
}

const show = (changes) => changes.map((c) => `${c.path} ${c.problem} (${c.gate})`).sort();

test('TK-8 a file approved by a rework first and by a later phase with new content: the phase version is current', () => {
  const { dir, C0, C1 } = history();
  // rework-1 approved first (seq 5, on C0, a.js v1 and gone.js); phase:d approved later (seq 9, on C1, a.js v2).
  const state = record(dir, [['phase:rework-1', C0, { 'src/a.js': V1, 'src/gone.js': GONE }, 5], ['phase:d', C1, { 'src/a.js': V2 }, 9]], { d: ['src/a.js', 'src/gone.js'] });
  assert.deepStrictEqual(state.gateOrder, ['phase:d', 'phase:rework-1'], 'the reducer\'s order: reworks after the phases');
  assert.deepStrictEqual(show(delivery.unreviewedChanges(state, dir, RELEASE)), [], 'a.js holds what phase:d approved; gone.js was deleted by phase:d, approved after the rework');

  // Reverted to the rework's older version: that is a change against the latest approval, phase:d's.
  write(dir, 'src/a.js', V1);
  assert.deepStrictEqual(show(delivery.unreviewedChanges(state, dir, RELEASE)), ['src/a.js modified after approval (phase:d)']);
});

test('TK-8 the reverse order: a phase approved first and a rework later; the rework version is current', () => {
  const { dir, C0, C1 } = history();
  const state = record(dir, [['phase:d', C0, { 'src/a.js': V1 }, 5], ['phase:rework-1', C1, { 'src/a.js': V2 }, 9]], { 'rework-1': ['src/a.js', 'src/gone.js'] });
  assert.deepStrictEqual(show(delivery.unreviewedChanges(state, dir, RELEASE)), []);
  write(dir, 'src/a.js', V1);
  assert.deepStrictEqual(show(delivery.unreviewedChanges(state, dir, RELEASE)), ['src/a.js modified after approval (phase:rework-1)']);
});

test('TK-8 a deletion counts as reviewed only when its phase was approved after the approval that pinned the file', () => {
  const { dir, C0, C1 } = history();
  // A phase approved after the rework recorded the deletion: reviewed.
  const later = record(dir, [['phase:rework-1', C0, { 'src/gone.js': GONE }, 5], ['phase:e', C1, { 'src/a.js': V2 }, 9]], { e: ['src/a.js', 'src/gone.js'] });
  assert.deepStrictEqual(show(delivery.unreviewedChanges(later, dir, RELEASE)), []);
  // A phase approved before the rework recorded it, and the rework then pinned the file again: deleted after approval.
  const earlier = record(dir, [['phase:e', C0, {}, 5], ['phase:rework-1', C1, { 'src/a.js': V2, 'src/gone.js': GONE }, 9]], { e: ['src/gone.js'] });
  assert.deepStrictEqual(show(delivery.unreviewedChanges(earlier, dir, RELEASE)), ['src/gone.js deleted after approval (phase:rework-1)']);
});
