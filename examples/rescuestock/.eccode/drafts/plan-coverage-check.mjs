// Checks that every brief criterion (RS-01..RS-39, NFR1..NFR6) is claimed by exactly one plan phase.
// A phase "claims" an id when one of its acceptance criteria starts with that id (optionally followed by
// "(a)", a bracketed suite tag, ":" or "/"), or lists it at the start of a semicolon-separated clause.
// Usage: node plan-coverage-check.mjs <plan.json> <brief.md>
import fs from 'node:fs';

const [planPath, briefPath] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const brief = fs.readFileSync(briefPath, 'utf8');

const section = brief.split('## Acceptance Criteria')[1].split('\n## ')[0];
const briefIds = [...section.matchAll(/^- (RS-\d\d|NFR\d)\b/gm)].map((m) => m[1]);

const claimRe = /(?:^|;\s+)(RS-\d\d|NFR\d)(?:\([ab]\))?(?:\s*\[[^\]]*\])?\s*:/g;
const claims = new Map();
for (const phase of plan.phases) {
  for (const c of phase.acceptanceCriteria) {
    for (const m of c.matchAll(claimRe)) {
      const list = claims.get(m[1]) || new Set();
      list.add(phase.id);
      claims.set(m[1], list);
    }
  }
}

let problems = 0;
const byPhase = {};
for (const id of briefIds) {
  const phases = [...(claims.get(id) || [])];
  if (phases.length !== 1) {
    problems++;
    console.log(`PROBLEM ${id}: claimed by ${phases.length ? phases.join(', ') : 'no phase'}`);
  } else {
    (byPhase[phases[0]] = byPhase[phases[0]] || []).push(id);
  }
}
for (const id of claims.keys()) {
  if (!briefIds.includes(id)) { problems++; console.log(`PROBLEM ${id}: claimed but not in the brief`); }
}
for (const p of plan.phases) console.log(`${p.id}: ${(byPhase[p.id] || []).join(', ')} (${(byPhase[p.id] || []).length})`);
console.log(`brief ids: ${briefIds.length}; problems: ${problems}`);
process.exit(problems ? 1 : 0);
