'use strict';
// Test fixtures: throwaway git projects and shortcuts for driving gates.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
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
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(plan || samplePlan(), null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/plan.json']]));
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

module.exports = { labRootCause, tmpProject, write, approval, rejection, approveThroughPlan, samplePlan, task, passCheck, handoffFor, expectCode, recordLesson, ARCH_MD, DESIGN_MD };
