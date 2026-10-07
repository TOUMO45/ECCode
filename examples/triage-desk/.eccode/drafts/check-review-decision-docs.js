#!/usr/bin/env node
// Check: do the docs that gate reviewers read state the exact accepted `decision` literal?
// Usage: node check-review-decision-docs.js [toolkitRoot] [projectRoot]
// Exits 1 while a reviewer-facing gap exists (repro), 0 once docs state the literal and show an approving example.
'use strict';
const fs = require('fs');
const path = require('path');

const toolkit = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', '..'));
const project = path.resolve(process.argv[3] || path.join(__dirname, '..', '..'));
const read = (p) => fs.readFileSync(path.join(toolkit, p), 'utf8');
const gaps = [];

// 1. The accepted values, from the schema the engine enforces.
const schema = JSON.parse(read('schemas/review.schema.json'));
const allowed = schema.properties.decision.enum;
console.log(`schema decision enum: ${JSON.stringify(allowed)}`);
console.log(`"approved" accepted by schema: ${allowed.includes('approved')}`);

// 2. The template placeholder (informational: an invalid placeholder forces a choice, which is fine).
const tpl = JSON.parse(read('templates/review.json'));
console.log(`template decision placeholder: ${JSON.stringify(tpl.decision)} -> valid as-is: ${allowed.includes(tpl.decision)}`);

// 3. Worked JSON examples in the review-gate skill: is there an approving one?
const skill = read('skills/review-gate/SKILL.md');
const examples = [...skill.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
const exampleDecisions = examples.map((e) => e.decision).filter((d) => d !== undefined);
console.log(`review-gate SKILL.md JSON example decisions: ${JSON.stringify(exampleDecisions)}`);
const literalInSkill = /[`"]approve[`"]/.test(skill);
console.log(`review-gate SKILL.md states literal \`approve\` / "approve": ${literalInSkill}`);
if (!exampleDecisions.includes('approve')) gaps.push('skills/review-gate/SKILL.md has no example with "decision": "approve"');
if (!literalInSkill) gaps.push('skills/review-gate/SKILL.md never states the literal approve value');

// 4. Each gate-reviewer agent doc: does it state the literal `approve` as the decision value?
const config = JSON.parse(fs.readFileSync(path.join(project, '.eccode/config.json'), 'utf8'));
const reviewers = [...new Set(Object.values(config.roles).flatMap((r) => r.reviewers))].sort();
for (const role of reviewers) {
  const doc = read(`agents/${role}.md`);
  const ok = /[`"]approve[`"]/.test(doc);
  console.log(`agents/${role}.md states literal \`approve\`: ${ok}`);
  if (!ok) gaps.push(`agents/${role}.md never states the literal decision value "approve"`);
}

// 5. Cross-reference: schema rejections for decision "approved" per reviewer, in this project's event log.
const events = fs.readFileSync(path.join(project, '.eccode/events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const bad = events.filter((e) => e.type === 'review.rejected' && (e.data.reasons || []).some((r) => r.startsWith('$.decision')));
for (const e of bad) {
  const next = events.find((x) => x.seq > e.seq && x.type === 'review.recorded' && x.actor === e.actor && x.data.gate === e.data.gate);
  console.log(`event:${e.seq} ${e.actor} gate=${e.data.gate} got=${JSON.stringify(e.data.decision)} -> next accepted: event:${next ? next.seq : '-'} decision=${next ? JSON.stringify(next.data.review.decision) : '-'}`);
}
const firstApproves = events.filter((e) => e.type === 'review.recorded' && e.data.review && e.data.review.decision === 'approve');
for (const role of reviewers) {
  const first = firstApproves.find((e) => e.actor === role);
  const rejectsBefore = bad.filter((e) => e.actor === role && (!first || e.seq < first.seq)).length;
  if (first || rejectsBefore) console.log(`${role}: decision-enum rejections before its first accepted approve on each gate: ${bad.filter((e) => e.actor === role).length} (first approve event:${first ? first.seq : '-'})`);
}

console.log(gaps.length ? `GAPS (${gaps.length}):\n- ${gaps.join('\n- ')}` : 'OK: reviewer-facing docs state the decision literal and show an approving example');
process.exit(gaps.length ? 1 : 0);
