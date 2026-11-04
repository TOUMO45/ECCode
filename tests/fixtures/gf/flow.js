'use strict';
// Drives the sample bundle through architecture -> design -> plan on a real temporary project, either through the
// wrapped (Greenfield-Senior) operations or through the frozen engine API directly. The second is the bypass
// path: what a caller of the plain `eccode` CLI could do. `ctx.at` names the gate being attempted, so a test can
// say where a refusal happened.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gates = require('../../../lib/gates');
const design = require('../../../lib/design');
const { loadConfig } = require('../../../lib/config');
const { writeJson } = require('../../../lib/util');
const { initProject } = require('../../../lib/greenfield/init');
const wrap = require('../../../lib/greenfield/wrap');
const sample = require('./sample');
const { approval } = require('../../helpers');

const FROZEN = { start: gates.startGate, submit: gates.submit, review: gates.recordReview };
const WRAPPED = { start: wrap.gateStart, submit: wrap.gateSubmit, review: wrap.gateReview };

/** A Greenfield-Senior project in a throwaway git repository (lean checks off, as the engine's own fixtures do). */
function gfProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gf-flow-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  const store = initProject(dir, { name: 'Tasks API', idea: 'A small team task tracker with registration, ownership and an admin view' });
  const file = path.join(dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.lean = { ...cfg.lean, level: 'off' };
  writeJson(file, cfg);
  return { dir, store, config: loadConfig(dir), at: null };
}

const TRADEOFF = 'acceptable for this project and stated for the record';
const tradeoffs = { complexity: TRADEOFF, risk: TRADEOFF, performance: TRADEOFF, security: TRADEOFF, reversibility: TRADEOFF };

/**
 * Record what the design module must hold before the architecture is submitted: the request's questions and
 * assumptions, and one decision (with its ADR) per technology choice. Decisions are recorded from the PRISTINE
 * sample so a mutated architecture keeps its mutation; placeholders dd-1..3 are mapped to the real ids.
 */
function recordRequest(ctx, art) {
  const { store, config } = ctx;
  const questions = [
    { id: 'Q-1', text: 'What password policy applies?', blocking: false },
    { id: 'Q-2', text: 'Is deleting a task permanent or reversible?', blocking: false },
    { id: 'Q-3', text: 'How is the first admin created?', blocking: false },
    ...(art.extraQuestions || []).map((q) => ({ id: q.id, text: q.text, blocking: Boolean(q.blocking) })),
  ];
  design.ambiguity(store, config, 'orchestrator', questions);
  for (const q of questions) {
    const assume = !(art.extraQuestions || []).some((e) => e.id === q.id) || (art.extraQuestions || []).find((e) => e.id === q.id).assume;
    if (assume && !q.blocking) design.assume(store, config, 'orchestrator', { question: q.id, reading: 'a reasonable reading, recorded so work continues', rationale: 'nobody is available to answer; the report surfaces this' });
  }
  const real = {};
  sample.build().architecture.techChoices.forEach((choice, i) => {
    const options = [choice.chosen, ...choice.alternatives.map((a) => a.id)].map((id) => ({ id, title: `Option ${id}`, tradeoffs }));
    const alt = design.alternatives(store, config, 'product-architect', options);
    const dec = design.decide(store, config, 'product-architect', { alternatives: alt.id, chosen: choice.chosen, rationale: `${choice.chosen} is the simplest option that meets the requirements`, rejected: choice.alternatives.map((a) => ({ option: a.id, why: a.whyNot })), interfaces: [] });
    if (!(art.skipAdr || []).includes(choice.id)) design.adr(store, config, 'product-architect', { decision: dec.id });
    real[`dd-${i + 1}`] = dec.id;
  });
  for (const c of art.architecture.techChoices) if (real[c.decision]) c.decision = real[c.decision];
  return art;
}

const ev = (p) => approval([[`artifact:${p}`]]);

/** Run the three document gates with `api` (WRAPPED or FROZEN) up to and including `upTo`. Throws where a gate refuses; `ctx.at` says which. */
function run(ctx, art, api, { upTo = 'plan', from = 'architecture', written: resumed } = {}) {
  const { store, config } = ctx;
  let written = resumed;
  if (from === 'architecture') {
    recordRequest(ctx, art);
    written = sample.write(ctx.dir, art);
    ctx.at = 'architecture';
    api.start(store, config, 'architecture', 'orchestrator');
    api.submit(store, config, 'architecture', 'product-architect', { artifacts: written.architecture });
    api.review(store, config, 'architecture', 'architecture-reviewer', ev('.eccode/artifacts/prd.json'));
    if (upTo === 'architecture') return written;
  }
  if (from !== 'plan') {
    ctx.at = 'design';
    api.start(store, config, 'design', 'orchestrator', { reviewers: ['technical-reviewer', 'security-reviewer'] });
    api.submit(store, config, 'design', 'technical-designer', { artifacts: written.design });
    api.review(store, config, 'design', 'technical-reviewer', ev('contracts/openapi.json'));
    api.review(store, config, 'design', 'security-reviewer', ev('.eccode/artifacts/threat-model.json'));
    if (upTo === 'design') return written;
  }
  ctx.at = 'plan';
  api.start(store, config, 'plan', 'orchestrator');
  api.submit(store, config, 'plan', 'delivery-lead', { artifacts: written.plan });
  api.review(store, config, 'plan', 'technical-reviewer', ev('.eccode/artifacts/plan.json'));
  return written;
}

module.exports = { gfProject, recordRequest, run, WRAPPED, FROZEN, ev };
