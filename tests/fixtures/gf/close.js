'use strict';
// Fixtures for the slice-closure rule (GF-CLOSE-*): a sealed Greenfield-Senior project in a real git repository
// with its design documents committed, a stubbed mutation run (the frozen mutate tool is called through its exports
// object), and the steps of a valid closure so a test can change exactly one thing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sample = require('./sample');
const { gfProject, run, WRAPPED } = require('./flow');
const closure = require('../../../lib/greenfield/closure');
const mutate = require('../../../lib/mutate');

const LONG = 'Read from the documents alone: the project builds a small task tracker; the contracts are sealed; ownership is by group; I could reconstruct every stage and found the points listed.';
const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);

function git(dir, ...args) { return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim(); }
function commitAll(ctx, msg) { git(ctx.dir, 'add', '-A'); git(ctx.dir, 'commit', '-q', '--allow-empty', '-m', msg); }
const tree = (ctx) => git(ctx.dir, 'rev-parse', 'HEAD^{tree}');
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };

/** A sealed project with two documents committed; the tree is clean. */
function closeProject() {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  put(ctx, 'docs/design.md', '# Design\nThe task tracker.\n');
  put(ctx, 'docs/plan.md', '# Plan\nSlices S0 to S2.\n');
  put(ctx, '.gitignore', '.eccode/\n');
  commitAll(ctx, 'sealed');
  return ctx;
}

/** Make the frozen mutation tool return a fixed result for the length of `fn`. */
function withMutation(over, fn) {
  const original = mutate.run;
  mutate.run = (root, { test, base }) => ({ command: test, base, files: 1, lines: 3, available: 5, total: 5, killed: 5, survived: 0, invalid: 0, timeouts: 0, score: 1, mutants: [], survivors: [], ...over });
  try { return fn(); } finally { mutate.run = original; }
}

const ORCH = 'orchestrator';
const battery = (ctx, scope = 'S2', over = {}, input = {}) => withMutation(over, () => closure.runBattery(ctx.store, ctx.config, ORCH, { scope, test: 'node -e 0', base: 'HEAD', ...input }).event.data);
const dispatch = (ctx, step, role = 'technical-reviewer', scope = 'S2', inputs = ['docs/design.md', 'docs/plan.md']) => closure.recordDispatch(ctx.store, ctx.config, ORCH, { scope, role, step, inputs }).event.data;
const review = (ctx, actor, input) => closure.recordReview(ctx.store, ctx.config, actor, input).event.data;
const resolve = (ctx, actor, input) => closure.resolveFinding(ctx.store, ctx.config, actor, input).event.data;
const closeIt = (ctx, input = {}) => closure.close(ctx.store, ctx.config, ORCH, { scope: 'S2', accounting: { unit: 'all-processed-tokens', start: 1000, end: 2500 }, accepted: [], ...input });

/** The three steps, each its own dispatch, all clean, on the current tree. Returns their review ids. */
function threeSteps(ctx, { scope = 'S2', evidence, roles = ['technical-reviewer', 'security-reviewer', 'architecture-reviewer'], critique = {}, readiness = {} } = {}) {
  const c = dispatch(ctx, 'comprehension', roles[0], scope);
  const k = dispatch(ctx, 'critique', roles[1], scope);
  const r = dispatch(ctx, 'readiness', roles[2], scope);
  const ids = {};
  ids.comprehension = review(ctx, roles[0], { scope, step: 'comprehension', dispatch: c.id, summary: LONG, findings: [] }).id;
  ids.critique = review(ctx, roles[1], { scope, step: 'critique', dispatch: k.id, summary: LONG, findings: [], ...critique }).id;
  ids.readiness = review(ctx, roles[2], { scope, step: 'readiness', dispatch: r.id, summary: LONG, verdict: 'go', evidence: evidence || ['docs/design.md:1'], ...readiness }).id;
  return ids;
}

/** A complete valid closure on a clean tree: battery, three steps, second battery. Returns the pieces. */
function validClosure(ctx, scope = 'S2') {
  const b1 = battery(ctx, scope);
  const steps = threeSteps(ctx, { scope, evidence: [b1.evidence, 'docs/design.md:1'] });
  const b2 = battery(ctx, scope);
  return { b1, b2, steps };
}

/** A fix-verify pair as the frozen tool records it (pre-fix failed as a reproduction, post-fix passed and cites it). */
function forgeProof(ctx, n, over = {}) {
  // The pre-fix run is at the commit under review (HEAD when the proof is made), as the frozen fix verification does.
  const base = over.base || git(ctx.dir, 'rev-parse', 'HEAD');
  const pre = { id: `ev-pre-${n}`, kind: 'command', label: 'fix-verify: pre-fix', command: 'node --test t.js', status: 'failed', purpose: 'reproduction', exitCode: 1, fixVerify: { phase: 'pre-fix', base, tests: ['t.js'] }, ...(over.pre || {}) };
  const post = { id: `ev-post-${n}`, kind: 'command', label: 'fix-verify: post-fix', command: 'node --test t.js', status: 'passed', purpose: 'check', exitCode: 0, fixVerify: { phase: 'post-fix', base, preFix: `ev-pre-${n}` }, ...(over.post || {}) };
  if (over.noPre !== true) F(ctx, 'evidence.recorded', ORCH, pre);
  F(ctx, 'evidence.recorded', ORCH, post);
  return `ev:${post.id}`;
}

module.exports = { closeProject, withMutation, battery, dispatch, review, resolve, closeIt, threeSteps, validClosure, forgeProof, git, commitAll, tree, put, F, LONG, ORCH };
