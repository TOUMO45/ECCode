'use strict';
// One breakage per row: `apply(art)` mutates a deep copy of the sample bundle so that the named rule is
// violated; `gate` is where the layer must refuse it (earlier gates must still accept the mutated bundle).
// Used three ways: stage validators refuse the row (gf-stages), the wrapped gate operations refuse it with the
// rule id (gf-flow), and the frozen API accepts it while `gf audit` reports the rule id (gf-audit bypass).
const task = (art, id) => art.breakdown.tasks.find((t) => t.id === id);
const group = (art, name) => art.breakdown.groups.find((g) => g.name === name);
const crit = (art, id) => art.prd.criteria.find((c) => c.id === id);

const A = 'architecture';
const D = 'design';
const P = 'plan';

const MUTATIONS = [
  // --- PRD ---
  { rule: 'GF-PRD-1', gate: A, name: 'a problem statement shorter than 80 characters', apply: (a) => { a.prd.problem = 'too short'; } },
  { rule: 'GF-PRD-1', gate: A, name: 'an empty scope', apply: (a) => { a.prd.scope = []; } },
  { rule: 'GF-PRD-1', gate: A, name: 'a duplicate criterion id', apply: (a) => { a.prd.criteria[1].id = a.prd.criteria[0].id; } },
  { rule: 'GF-PRD-1', gate: A, name: 'a criterion covering an unknown scope id', apply: (a) => { a.prd.criteria[0].covers = ['S-NOPE']; } },
  { rule: 'GF-PRD-1', gate: A, name: 'a scope item no criterion covers', apply: (a) => { a.prd.scope.push({ id: 'S-ORPHAN', statement: 'an orphan scope item' }); } },
  { rule: 'GF-PRD-2', gate: A, name: 'a criterion verified manually', apply: (a) => { crit(a, 'AC-1').verify = { kind: 'manual' }; } },
  { rule: 'GF-PRD-2', gate: A, name: 'an http criterion without an operationId', apply: (a) => { crit(a, 'AC-3').verify = { kind: 'http', as: 'member', expect: { status: 201 } }; } },
  { rule: 'GF-PRD-2', gate: A, name: 'a flow criterion with no steps', apply: (a) => { crit(a, 'AC-1').verify = { kind: 'flow', steps: [] }; } },
  { rule: 'GF-PRD-2', gate: A, name: 'a criterion with no verify at all', apply: (a) => { delete crit(a, 'AC-4').verify; } },
  { rule: 'GF-PRD-3', gate: A, name: 'no ambiguity claimed while a blocking question is open', apply: (a) => { a.prd.ambiguityScan = { none: true, justification: 'nothing in this idea is ambiguous at all' }; a.extraQuestions = [{ id: 'Q-9', text: 'Which payment provider?', blocking: true }]; } },
  { rule: 'GF-PRD-3', gate: A, name: 'an assumed entry citing an assumption nobody recorded', apply: (a) => { a.prd.ambiguityScan[0].assumptionId = 'Q-404'; } },
  { rule: 'GF-PRD-3', gate: A, name: 'a recorded question missing from the scan', apply: (a) => { a.extraQuestions = [{ id: 'Q-8', text: 'Should there be rate limits?', blocking: false, assume: true }]; } },
  { rule: 'GF-PRD-3', gate: A, name: 'a clarified entry without a user clarification', apply: (a) => { a.prd.ambiguityScan[1].resolution = 'clarified'; delete a.prd.ambiguityScan[1].assumptionId; } },
  // --- architecture ---
  { rule: 'GF-ARC-1', gate: A, name: 'a technology choice with one alternative', apply: (a) => { a.architecture.techChoices[0].alternatives = a.architecture.techChoices[0].alternatives.slice(0, 1); } },
  { rule: 'GF-ARC-1', gate: A, name: 'one decision reused for two choices', apply: (a) => { a.architecture.techChoices[1].decision = a.architecture.techChoices[0].decision; } },
  { rule: 'GF-ARC-1', gate: A, name: 'a decision that was never recorded', apply: (a) => { a.architecture.techChoices[2].decision = 'dd-404'; } },
  { rule: 'GF-ARC-1', gate: A, name: 'a chosen option that differs from the decision', apply: (a) => { a.architecture.techChoices[0].chosen = 'flask'; } },
  { rule: 'GF-ARC-1', gate: A, name: 'a decision with no ADR', apply: (a) => { a.skipAdr = ['TC-3']; } },
  // --- contracts ---
  { rule: 'GF-CON-1', gate: D, name: 'a duplicate operationId in the OpenAPI', apply: (a) => { a.openapi.paths['/tasks'].post.operationId = 'listTasks'; } },
  { rule: 'GF-CON-2', gate: D, name: 'a table without a primary key', apply: (a) => { for (const c of a.dbSchema.tables[0].columns) delete c.primaryKey; } },
  { rule: 'GF-CON-2', gate: D, name: 'a migration step without a down', apply: (a) => { a.migrationsPlan.steps[0].down = 'x'; } },
  { rule: 'GF-CON-2', gate: D, name: 'a table no migration creates', apply: (a) => { a.migrationsPlan.steps[2].creates = []; } },
  { rule: 'GF-CON-2', gate: D, name: 'a reference to an unknown table', apply: (a) => { a.dbSchema.tables[2].columns.find((c) => c.name === 'owner_id').references = { table: 'ghosts', column: 'id' }; } },
  { rule: 'GF-CON-3', gate: D, name: 'a missing access matrix cell', apply: (a) => { a.accessMatrix.cells.pop(); } },
  { rule: 'GF-CON-3', gate: D, name: 'a cell for an unknown operation', apply: (a) => { a.accessMatrix.cells.push({ role: 'member', operationId: 'ghostOp', ownership: 'none', expected: 'deny' }); } },
  { rule: 'GF-CON-3', gate: D, name: 'no anonymous role', apply: (a) => { a.accessMatrix.roles = a.accessMatrix.roles.filter((r) => r.name !== 'anonymous'); a.accessMatrix.cells = a.accessMatrix.cells.filter((c) => c.role !== 'anonymous'); } },
  { rule: 'GF-CON-3', gate: D, name: 'an expected value outside allow and deny', apply: (a) => { a.accessMatrix.cells[0].expected = 'maybe'; } },
  { rule: 'GF-CON-3', gate: D, name: 'a duplicated cell', apply: (a) => { a.accessMatrix.cells.push({ ...a.accessMatrix.cells[0] }); } },
  { rule: 'GF-CON-4', gate: D, name: 'fixtures naming a role the matrix lacks', apply: (a) => { a.fixtures.roles.superuser = { headers: {} }; } },
  { rule: 'GF-CON-4', gate: D, name: 'credentials for the anonymous role', apply: (a) => { a.fixtures.roles.anonymous = { headers: { Authorization: 'Bearer x' } }; } },
  { rule: 'GF-CON-4', gate: D, name: 'a fixtures login naming an unknown operation', apply: (a) => { a.fixtures.roles.member.login.operationId = 'ghostLogin'; } },
  { rule: 'GF-CON-4', gate: D, name: 'an events contract with an event nobody consumes', apply: (a) => { a.events = { events: [{ name: 'task.created', producer: 'api', consumers: [], schema: {} }] }; } },
  { rule: 'GF-CON-5', gate: D, name: 'a criterion calling an operation the OpenAPI lacks', apply: (a) => { crit(a, 'AC-4').verify.operationId = 'ghostOp'; } },
  { rule: 'GF-CON-5', gate: D, name: 'an operation no criterion covers', apply: (a) => { a.prd.criteria = a.prd.criteria.filter((c) => c.id !== 'AC-10'); } },
  { rule: 'GF-CON-5', gate: D, name: 'a criterion acting as a role the matrix lacks', apply: (a) => { crit(a, 'AC-3').verify.as = 'superuser'; } },
  // --- threat model ---
  { rule: 'GF-THR-1', gate: D, name: 'an operation behind no trust boundary', apply: (a) => { for (const b of a.threat.trustBoundaries) b.crosses = b.crosses.filter((x) => x !== 'health'); a.threat.trustBoundaries[1].crosses = a.threat.trustBoundaries[1].crosses.filter((x) => x !== 'health'); } },
  { rule: 'GF-THR-1', gate: D, name: 'a request field with no inputValidation entry', apply: (a) => { a.threat.inputValidation.pop(); } },
  { rule: 'GF-THR-1', gate: D, name: 'a stale access matrix hash', apply: (a) => { a.threat.accessMatrixSha256 = 'f'.repeat(64); a.__noRehash = true; } },
  { rule: 'GF-THR-1', gate: D, name: 'a threat on an unknown boundary', apply: (a) => { a.threat.threats[0].boundary = 'B-404'; } },
  { rule: 'GF-THR-1', gate: D, name: 'a mitigation pointing at nothing', apply: (a) => { a.threat.threats[1].mitigation = { ref: 'criterion', id: 'AC-404' }; } },
  { rule: 'GF-THR-1', gate: D, name: 'an inputValidation entry for a field that does not exist', apply: (a) => { a.threat.inputValidation.push({ operationId: 'listTasks', field: 'query:bogus', rules: 'typed and bounded' }); } },
  // --- work breakdown ---
  { rule: 'GF-WBS-1', gate: P, name: 'a skeleton task whose owner differs from plan.json', apply: (a) => { a.plan.tasks.find((t) => t.id === 's0-web').owner = 'backend-engineer'; } },
  { rule: 'GF-WBS-1', gate: P, name: 'a task file outside its group globs', apply: (a) => { task(a, 's1-web-auth').files = ['app/auth/**']; } },
  { rule: 'GF-WBS-1', gate: P, name: 'a task over the line budget', apply: (a) => { task(a, 's2-tasks-routes').estLines = 5000; } },
  { rule: 'GF-WBS-1', gate: P, name: 'a dependency on a later slice', apply: (a) => { task(a, 's0-app').dependencies.push('s2-admin-routes'); } },
  { rule: 'GF-WBS-1', gate: P, name: 'an owner outside the group', apply: (a) => { task(a, 's1-auth-core').owner = 'frontend-engineer'; } },
  { rule: 'GF-WBS-1', gate: P, name: 'a skeleton task missing from plan.json', apply: (a) => { a.plan.tasks.pop(); } },
  { rule: 'GF-WBS-2', gate: P, name: 'overlapping group globs without a deny', apply: (a) => { group(a, 'backend').denyGlobs = []; } },
  { rule: 'GF-WBS-2', gate: P, name: 'the frontend owning the contracts', apply: (a) => { group(a, 'frontend').globs.push('contracts/**'); } },
  { rule: 'GF-WBS-2', gate: P, name: 'no group owning tests/acceptance', apply: (a) => { group(a, 'test').globs = ['tests/unit/**']; } },
  { rule: 'GF-WBS-3', gate: P, name: 'a criterion in no slice', apply: (a) => { const s = a.breakdown.slices.find((x) => x.id === 'S2'); s.criteria = s.criteria.filter((c) => c !== 'AC-10'); } },
  { rule: 'GF-WBS-3', gate: P, name: 'a criterion with no test task', apply: (a) => { task(a, 's2-accept').criteria = task(a, 's2-accept').criteria.filter((c) => c !== 'AC-10'); } },
  { rule: 'GF-WBS-3', gate: P, name: 'an operation provided by two tasks', apply: (a) => { task(a, 's2-admin-routes').provides.push('listTasks'); } },
  { rule: 'GF-WBS-3', gate: P, name: 'an operation provided by no task', apply: (a) => { task(a, 's2-admin-routes').provides = []; } },
  // --- estimates ---
  { rule: 'GF-EST-1', gate: P, name: 'the wrong label', apply: (a) => { a.estimates.label = 'calibrated'; } },
  { rule: 'GF-EST-1', gate: P, name: 'low above high', apply: (a) => { a.estimates.groups.backend.minutes = { low: 100, high: 10 }; } },
  { rule: 'GF-EST-1', gate: P, name: 'a task count that differs from the breakdown', apply: (a) => { a.estimates.groups.backend.tasks += 1; } },
  { rule: 'GF-EST-1', gate: P, name: 'a group with tasks and no estimate', apply: (a) => { delete a.estimates.groups.test; } },
  // --- artifacts on disk ---
  { rule: 'GF-ART-2', gate: A, name: 'a duplicated basename in one submission', apply: (a) => { a.__extraFiles = [{ gate: 'architecture', path: '.eccode/artifacts/dup/prd.json', content: `${JSON.stringify(a.prd, null, 2)}\n` }]; } },
  { rule: 'GF-ART-2', gate: A, name: 'a symlinked stage artifact', apply: (a) => { a.__symlink = '.eccode/artifacts/prd.json'; } },
];

module.exports = { MUTATIONS };
