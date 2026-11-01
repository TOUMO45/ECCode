'use strict';
// Test fixtures: throwaway git projects and shortcuts for driving gates.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { init } = require('../lib/project');
const { loadConfig } = require('../lib/config');
const gates = require('../lib/gates');
const evidence = require('../lib/evidence');
const { writeJson } = require('../lib/util');

const ARCH_MD = `# Brief
## Users
Support agents.
## Problem
Ticket triage is slow.
## Requirements
- R1 classify tickets
## Acceptance Criteria
- AC1 category returned
## Architecture
Single Node service.
## Assumptions
- A1
## Open Questions
- Q1
## Risks
- RISK1
`;

const DESIGN_MD = `# Spec
## Components
x
## Interface Contracts
x
## Data Design
x
## Security
x
## Testing Strategy
x
## Deployment
x
`;

function tmpProject({ configOverrides, beforeInit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  if (beforeInit) beforeInit(dir);
  const store = init(dir, { name: 'Test', idea: 'Test idea for the pipeline' });
  // Lean checks are off unless a test asks for them: gate and task fixtures
  // change code without tests on purpose. tests/lean.test.js covers lean levels.
  const overrides = { lean: { level: 'off' }, ...configOverrides };
  const file = path.join(dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(overrides)) cfg[k] = { ...cfg[k], ...v };
  writeJson(file, cfg);
  return { dir, store, config: loadConfig(dir) };
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
}

function approval(criteria, extra = {}) {
  return {
    decision: 'approve',
    summary: 'All criteria verified against the submitted artifacts.',
    criteria: criteria.map((evidenceRefs, i) => ({ id: `C${i + 1}`, description: `criterion ${i + 1}`, met: true, evidence: evidenceRefs })),
    findings: [],
    ...extra,
  };
}

function rejection(findingId = 'F1', extra = {}) {
  return {
    decision: 'changes_requested',
    summary: 'Blocking gap found in the submitted artifacts.',
    criteria: [{ id: 'C1', description: 'criterion one', met: false, evidence: [] }],
    findings: [{ id: findingId, severity: 'blocking', title: 'Missing requirement', detail: 'The brief omits rate limiting.', recommendation: 'Add a rate-limit requirement.' }],
    ...extra,
  };
}

/** Drive architecture → design → plan to approved with valid reviews. */
function approveThroughPlan(ctx, plan) {
  const { dir, store, config } = ctx;
  gates.startGate(store, config, 'architecture', 'orchestrator');
  write(dir, '.eccode/artifacts/brief.md', ARCH_MD);
  gates.submit(store, config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  gates.recordReview(store, config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md#Requirements']]));
  gates.startGate(store, config, 'design', 'orchestrator');
  write(dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(store, config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  gates.recordReview(store, config, 'design', 'technical-reviewer', approval([['artifact:.eccode/artifacts/spec.md']]));
  // Phase 3: no task is owned on a design track without a decision over two alternatives and its ADR.
  designDecision(ctx);
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(plan || samplePlan(), null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/plan.json']]));
}

/** Two alternatives, a decision and its ADR for the current work item; returns the ADR ref the verification reviewer cites. */
function designDecision(ctx, { interfaces = [] } = {}) {
  const design = require('../lib/design');
  const t = (k) => `${k} is acceptable for this test`;
  const tradeoffs = { complexity: t('complexity'), risk: t('risk'), performance: t('performance'), security: t('security'), reversibility: t('reversibility') };
  const alt = design.alternatives(ctx.store, ctx.config, 'technical-designer', [{ id: 'A', title: 'Option A', tradeoffs }, { id: 'B', title: 'Option B', tradeoffs }]);
  design.decide(ctx.store, ctx.config, 'technical-designer', { alternatives: alt.id, chosen: 'A', rationale: 'Option A is the simplest design that meets the requirements', rejected: [{ option: 'B', why: 'more moving parts for no gain' }], interfaces });
  const adr = design.adr(ctx.store, ctx.config, 'technical-designer', {});
  return `artifact:${adr.artifact}`;
}

/** The ADR ref of the current work item (the verification review on a design track must cite it). */
function adrRef(ctx) {
  const adrs = ctx.store.state().design.adrs;
  return adrs.length ? [`artifact:${adrs[adrs.length - 1].artifact}`] : [];
}

/** The H-B freeze commit (bench/protocols/2026-10-28-phase2.md, 0.C). The measurement runs from a worktree of it; HEAD moves on. */
const HB_FREEZE_COMMIT = '4fbb80ed23ed58c059ba6bc99fb6318c61562257';

/**
 * The frozen H-B tree rebuilt from git into a temporary directory (every file the
 * freeze lists, plus the runner's directory), or null with the reason when the
 * commit is not in this clone (a shallow checkout).
 */
function frozenTreeFromGit() {
  const root = path.join(__dirname, '..');
  const has = spawnSync('git', ['cat-file', '-e', `${HB_FREEZE_COMMIT}^{commit}`], { cwd: root });
  if (has.status !== 0) return { dir: null, reason: `freeze commit ${HB_FREEZE_COMMIT.slice(0, 12)} is not in this clone` };
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', HB_FREEZE_COMMIT, 'bench/pilot/phase2-freeze.json', 'bench/pilot/phase2-seeds.js', 'bench/pilot/phase2-hb', 'bench/pilot/phase2-seed-validate.js', 'bench/pilot/phase2-reseal.js', 'bench/suites/phase2-seeds', 'lib', 'bin', 'scripts/behavior', 'package.json'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-hb-frozen-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), execFileSync('git', ['show', `${HB_FREEZE_COMMIT}:${f}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }));
  }
  return { dir, reason: null };
}

function samplePlan() {
  return {
    phases: [{ id: 'core', name: 'Core', goal: 'Build the core service', acceptanceCriteria: ['server responds'] }],
    tasks: [
      task('api', 'backend-engineer', ['src/server/**']),
      task('ui', 'frontend-engineer', ['src/web/**']),
      task('tests', 'test-engineer', ['tests/**'], ['api']),
    ],
  };
}

function task(id, owner, files, dependencies = [], phase = 'core') {
  return {
    id,
    phase,
    title: `Task ${id} work`,
    owner,
    dependencies,
    inputs: ['.eccode/artifacts/spec.md'],
    outputs: [`${id} output`],
    files,
    acceptanceCriteria: [`${id} works`],
    verification: { method: 'run checks', command: 'node -e "process.exit(0)"' }, // what passCheck runs
  };
}

function passCheck(store, actor, label = 'check') {
  return evidence.runCommand(store, actor, { label, command: 'node -e "process.exit(0)"' });
}

function handoffFor(taskId, from, evIds, filesChanged) {
  return {
    from,
    to: 'delivery-lead',
    task: taskId,
    objective: `Complete task ${taskId}`,
    context: 'Implemented per the approved spec.',
    inputs: ['.eccode/artifacts/spec.md'],
    expectedOutput: 'Working code',
    acceptanceCriteria: [`${taskId} works`],
    completedWork: 'Implemented the feature and its checks.',
    filesChanged,
    evidence: evIds.map((id) => `ev:${id}`),
    remainingIssues: [],
    nextAction: 'Phase review',
  };
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (err) {
    if (err.code === code) return err;
    throw new Error(`expected ${code}, got ${err.code}: ${err.message}`);
  }
  throw new Error(`expected ${code}, but call succeeded`);
}

/** A filled debugging lesson on the project's memory: a fix or debug work item records one before its last gate. */
function recordLesson(store, actor = 'backend-engineer', title = 'Boundary check off by one at the limit') {
  const { Memory } = require('../lib/memory/records');
  return new Memory(store).add(actor, {
    layer: 'debugging',
    content: {
      title,
      problem: 'A value exactly at the limit took the wrong branch.',
      symptoms: ['the limit value is treated as below it'],
      component: 'src',
      environment: {},
      reproduction: { steps: [], evidence: [] },
      rootCause: { explanation: 'The comparison used > where the rule says from the limit.', evidence: [] },
      failedAttempts: [],
      solution: { description: 'Compare with >= at the limit.', tradeoffs: 'none' },
      verification: { evidence: [] },
      sources: [],
      appliesWhen: ['a rule starts at a boundary value'],
      notApplicableWhen: ['no boundary is involved'],
      confidence: 'medium',
    },
  });
}

/**
 * The Debugging Lab's path to a confirmed root cause (debug and fix tracks
 * refuse a fix without one): pin a failing reproduction, open a hypothesis,
 * test it with an executed command marked supports, close it confirmed,
 * declare the root cause at a file that exists. Returns the lab state.
 */
function labRootCause(store, actor = 'backend-engineer', { command = 'node -e "process.exit(1)"', at, task } = {}) {
  const lab = require('../lib/lab');
  const { loadConfig } = require('../lib/config');
  const config = loadConfig(store.root);
  if (!store.state().lab.repro) lab.recordRepro(store, config, actor, { command, task });
  const h = lab.openHypothesis(store, config, actor, { statement: 'The boundary comparison excludes the limit value', ifTrue: 'the limit value takes the lower branch', ifFalse: 'the limit value takes the upper branch' });
  lab.testHypothesis(store, config, actor, { hypothesis: h.id, command: 'node -e "process.exit(0)"', verdict: 'supports', task });
  lab.closeHypothesis(store, config, actor, { hypothesis: h.id, status: 'confirmed' });
  let where = at;
  if (!where) {
    const fs2 = require('fs');
    const first = fs2.readdirSync(store.root).find((f) => f !== '.eccode' && f !== '.git' && fs2.statSync(path.join(store.root, f)).isFile());
    where = `${first}:1`;
  }
  lab.declareRootCause(store, config, actor, { hypothesis: h.id, locations: [where], explanation: 'The comparison used > where the rule starts at the limit, so the limit value is priced without the discount.', whyReproFails: 'the reproduction prices the limit value and gets the undiscounted total' });
  return store.state().lab;
}

module.exports = { HB_FREEZE_COMMIT, frozenTreeFromGit, designDecision, adrRef, labRootCause, tmpProject, write, approval, rejection, approveThroughPlan, samplePlan, task, passCheck, handoffFor, expectCode, recordLesson, ARCH_MD, DESIGN_MD };
