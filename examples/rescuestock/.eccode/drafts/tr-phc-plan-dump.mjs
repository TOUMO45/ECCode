// technical-reviewer helper (phase C): prints each task of the given phase from plan.json
// (owner, dependencies, ownership, acceptance criteria, verification). Usage: node tr-phc-plan-dump.mjs <phaseId> [field]
import { readFileSync } from 'node:fs';
const plan = JSON.parse(readFileSync('.eccode/artifacts/plan/plan.json', 'utf8'));
const phaseId = process.argv[2] || 'c-core-flow';
const tasks = (plan.tasks || []).filter((t) => t.phase === phaseId);
if (!tasks.length) console.log('top-level keys:', Object.keys(plan).join(', '));
for (const t of tasks) {
  console.log('==== ' + t.id);
  console.log(JSON.stringify(t, null, 1));
}
const ph = (plan.phases || []).find((p) => p.id === phaseId);
if (ph) { console.log('==== phase'); console.log(JSON.stringify(ph, null, 1)); }
