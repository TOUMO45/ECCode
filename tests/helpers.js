'use strict';
// Test fixtures: throwaway git projects and shortcuts for driving gates.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Shared memory is isolated per test process (TK-2): the engine's default shared store is ~/.eccode/memory, so a
// lesson promoted on the developer's machine was retrieved by fixture claims and their handoffs, which answer no
// lesson, were refused. Set before the engine is loaded; the CLI and hook children the tests spawn inherit
// process.env. Tests that exercise the shared store point the variable at their own directory afterwards
// (memory.test.js, lesson-fixture.js, promotion-scrub.test.js).
const SHARED_MEMORY = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-shared-'));
process.env.ECCODE_SHARED_MEMORY = SHARED_MEMORY;

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

/**
 * A throwaway repo whose checkouts never rewrite line endings: byte hashes of
 * approved files are part of the record, and a machine with a global
 * core.autocrlf=true would otherwise restore `// ui\n` as `// ui\r\n`. The
 * setting is written with `git config` (repo-local, persisted), not `git -c`
 * on `init`, which is not.
 */
function initRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
}

function tmpProject({ configOverrides } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-test-'));
  initRepo(dir);
  const store = init(dir, { name: 'Test', idea: 'Test idea for the pipeline' });
  if (configOverrides) {
    const file = path.join(dir, '.eccode', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(configOverrides)) cfg[k] = { ...cfg[k], ...v };
    writeJson(file, cfg);
  }
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

/** An approval that also carries the 'lessons' criterion reviewers owe when lesson decisions were recorded. */
function approvalWithLessons(criteria, lessonsEvidence) {
  const a = approval(criteria);
  a.criteria.push({ id: 'lessons', description: 'every recorded lesson decision was judged', met: true, evidence: lessonsEvidence || criteria[0] });
  return a;
}

/**
 * An approving review that covers every criterion the gate requires (`eccode gate show <gate>`): one
 * criterion per required id, met, citing `evidenceRefs`. A single C1 when the gate requires nothing.
 */
function coverage(ctx, gateId, evidenceRefs, extra = {}) {
  const required = gates.requiredCriteria(ctx.store.state(), ctx.config, ctx.dir, gateId);
  const criteria = (required.length ? required : [{ id: 'C1', description: 'criterion 1' }]).map((c) => ({ id: c.id, description: `${c.id}: ${c.description || 'verified'}`, met: true, evidence: evidenceRefs }));
  return { decision: 'approve', summary: 'All criteria verified against the submitted artifacts.', criteria, findings: [], ...extra };
}

/** coverage() plus the 'lessons' criterion. */
function coverageWithLessons(ctx, gateId, evidenceRefs, lessonsEvidence) {
  const a = coverage(ctx, gateId, evidenceRefs);
  a.criteria.push({ id: 'lessons', description: 'every recorded lesson decision was judged', met: true, evidence: lessonsEvidence || evidenceRefs });
  return a;
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
  gates.recordReview(store, config, 'architecture', 'architecture-reviewer', coverage(ctx, 'architecture', ['artifact:.eccode/artifacts/brief.md#Acceptance Criteria']));
  gates.startGate(store, config, 'design', 'orchestrator');
  write(dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(store, config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  gates.recordReview(store, config, 'design', 'technical-reviewer', coverage(ctx, 'design', ['artifact:.eccode/artifacts/spec.md#Testing Strategy']));
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(plan || samplePlan(), null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', coverage(ctx, 'plan', ['artifact:.eccode/artifacts/plan.json#phases']));
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
    // The same command passCheck() runs, so a completion cites a run of the declared check.
    verification: { method: 'run checks', command: 'node -e "process.exit(0)"' },
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

module.exports = { tmpProject, write, approval, approvalWithLessons, coverage, coverageWithLessons, rejection, approveThroughPlan, samplePlan, task, passCheck, handoffFor, expectCode, ARCH_MD, DESIGN_MD, initRepo, SHARED_MEMORY };
