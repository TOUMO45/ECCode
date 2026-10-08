'use strict';
// Valid JSON skeletons for the documents agents have to write by hand. Each
// one validates against its schema as printed (placeholders are real strings),
// so an agent can start from `eccode template <name>` instead of guessing the
// shape and learning it from validation errors.

const { EccodeError } = require('./util');

const TEMPLATES = {
  // A gate review. `changes_requested` needs a blocking or major finding; for an approval, drop `findings`
  // entries, mark every criterion met with evidence, and (on re-review) list every earlier finding in resolvedFindings.
  review: () => ({
    decision: 'changes_requested',
    summary: 'One or two sentences: what you checked and your decision.',
    criteria: [
      { id: 'C1', description: 'An acceptance criterion from the brief or plan', met: false, evidence: ['ev:<id of a check you ran>', 'artifact:<path of the submitted file>'] },
    ],
    findings: [
      { id: 'F1', severity: 'blocking', title: 'Short title of the problem', detail: 'What is wrong, where, and how you know (cite evidence).', evidence: ['ev:<id>'], recommendation: 'What the author should change.' },
    ],
    resolvedFindings: [],
  }),
  // A plan: one phase, one task. Tasks of the same phase may run in parallel only if their `files` globs do not overlap.
  plan: () => ({
    // One entry per verified lesson the engine says the plan matches: { id, decision: "incorporated" | "not-applicable", note }.
    lessonDecisions: [],
    phases: [{ id: 'core', name: 'Core change', goal: 'Implement the requested change and its tests.', acceptanceCriteria: ['Each requirement of the request holds', 'Existing tests still pass'] }],
    tasks: [
      {
        id: 'api',
        phase: 'core',
        title: 'Name what is built, e.g. POST /refunds endpoint with tests',
        owner: 'backend-engineer',
        dependencies: [],
        inputs: ['TASK.md'],
        outputs: ['changed source files', 'new or updated tests'],
        files: ['src/**', 'test/**'],
        acceptanceCriteria: ['<criterion taken from the request>'],
        verification: { method: 'run the project test suite', command: 'npm test' },
      },
    ],
  }),
  handoff: () => ({
    from: '<your role>',
    to: 'delivery-lead',
    task: '<task id>',
    objective: 'What the task was supposed to achieve.',
    context: 'Inputs and decisions you relied on.',
    inputs: ['<files or records you used>'],
    expectedOutput: 'What was to be produced.',
    acceptanceCriteria: ['<criterion from the task>'],
    completedWork: 'What you actually did, and what you decided and why.',
    filesChanged: ['<path>'],
    evidence: ['ev:<id of a passing check run after you claimed the task>'],
    remainingIssues: [],
    nextAction: 'Who does what next.',
  }),
  lesson: () => ({
    layer: 'debugging',
    trust: 'internal',
    content: {
      title: 'General rule or pattern and its consequence (not today\'s service name)',
      problem: 'What went wrong and its impact.',
      symptoms: ['Exact error text or failing behaviour, in the words a later task would use'],
      component: 'module or kind of change',
      environment: {},
      fingerprint: 'stable-signature',
      reproduction: { steps: ['The smallest failing check'], evidence: ['ev:<failing check, purpose=reproduction>'] },
      rootCause: { explanation: 'The mechanism or the quoted rule, with its source.', evidence: ['ev:<id>'] },
      failedAttempts: [{ approach: 'What you tried first', whyFailed: 'Why it did not work' }],
      solution: { description: 'The fix, described so another engineer can apply it.', tradeoffs: 'Costs or limits of the fix.' },
      verification: { evidence: ['ev:<the same check, now passing>'], regressionTest: 'npm test' },
      sources: [],
      appliesWhen: ['The kinds of change this lesson covers'],
      notApplicableWhen: ['Contrasting cases where it does not apply'],
      confidence: 'medium',
      tags: [],
    },
  }),
};

function template(name) {
  if (!TEMPLATES[name]) throw new EccodeError('USAGE', `Unknown template "${name}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
  return TEMPLATES[name]();
}

module.exports = { template, names: () => Object.keys(TEMPLATES) };
