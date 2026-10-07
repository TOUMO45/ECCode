#!/usr/bin/env node
'use strict';
// Evaluation for the review-gate skill improvement grounded in lesson
// mem-sw-muyoa34v-0117203a (reviews refused for decision "approved").
// Run from the ECCode root: node .eccode/drafts/eval-review-gate-skill.js
// Representative cases (a, b, b2) check the docs gap is closed.
// Regression cases (c-f) must keep passing; the exit code depends only on them.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// REVIEW_GATE_SKILL_PATH lets an author dry-run a draft without touching the target.
const SKILL = process.env.REVIEW_GATE_SKILL_PATH || path.join(ROOT, 'skills', 'review-gate', 'SKILL.md');
const { validateNamed, loadSchema } = require(path.join(ROOT, 'lib', 'schema'));

const text = fs.readFileSync(SKILL, 'utf8');
const results = [];
function check(id, kind, desc, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true || (r && r.ok === true);
    if (r && r.detail) detail = r.detail;
  } catch (e) {
    detail = `threw: ${e.message}`;
  }
  results.push({ id, kind, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${kind}] ${id}: ${desc}${detail ? ` (${detail})` : ''}`);
}

// All ```json fenced blocks that parse as objects.
function jsonBlocks() {
  const out = [];
  const re = /^\s*```json\s*\n([\s\S]*?)^\s*```/gm;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      /* not a full JSON document; ignore */
    }
  }
  return out;
}
const blocks = jsonBlocks();

// (a) Representative: the exact literal "approve" is stated as the decision value,
// and the doc says other strings (e.g. "approved") are refused.
check('a', 'representative', 'states literal "approve" and that other strings are refused', () => {
  const paras = text.split(/\n\s*\n/);
  const hit = paras.some((p) =>
    /`"approve"`/.test(p) && /`"changes_requested"`/.test(p) && /\bapproved\b/.test(p) && /refused/i.test(p));
  return { ok: hit, detail: hit ? '' : 'no paragraph names `"approve"`, `"changes_requested"`, and says "approved" is refused' };
});

// (b) Representative: a JSON example with decision "approve" that validates against the schema.
check('b', 'representative', 'contains an approving JSON example that validates against review.schema.json', () => {
  const approving = blocks.filter((b) => b.decision === 'approve');
  if (!approving.length) return { ok: false, detail: 'no ```json block with "decision": "approve"' };
  const valid = approving.filter((b) => validateNamed('review', b).length === 0);
  return { ok: valid.length > 0, detail: valid.length ? '' : validateNamed('review', approving[0]).join('; ') };
});

// (b2) Representative: the approving example is one the engine would accept as a re-review:
// every criterion met with ev: evidence, no open blocking/major finding, resolvedFindings present.
check('b2', 'representative', 'approving example is engine-consistent (all met with ev:, no open blocking/major, resolvedFindings)', () => {
  const ok = blocks.some((b) => b.decision === 'approve' && validateNamed('review', b).length === 0 &&
    b.criteria.every((c) => c.met === true && c.evidence.some((e) => e.startsWith('ev:'))) &&
    !b.findings.some((f) => ['blocking', 'major'].includes(f.severity) && f.status !== 'resolved') &&
    Array.isArray(b.resolvedFindings) && b.resolvedFindings.length > 0);
  return ok;
});

// (c) Regression: a valid changes_requested example is still present, with a blocking/major finding.
check('c', 'regression', 'still contains a valid changes_requested example with a blocking/major finding', () => {
  const ok = blocks.some((b) => b.decision === 'changes_requested' && validateNamed('review', b).length === 0 &&
    b.findings.some((f) => ['blocking', 'major'].includes(f.severity)));
  return ok;
});

// (d) Regression: the schema enum is unchanged (docs-only change; schema stays strict).
check('d', 'regression', 'schema decision enum is exactly [approve, changes_requested]', () => {
  const en = loadSchema('review').properties.decision.enum;
  return { ok: JSON.stringify(en) === JSON.stringify(['approve', 'changes_requested']), detail: JSON.stringify(en) };
});

// (e) Regression: validateNamed still refuses "approved" (and other near-miss spellings).
check('e', 'regression', 'schema still rejects decision "approved", "approval", "reject"', () => {
  const base = blocks.find((b) => b.decision === 'changes_requested') || {
    summary: 'Twenty characters or more here.', criteria: [{ id: 'C1', description: 'Criterion', met: true, evidence: ['ev:x'] }], findings: [],
  };
  const bad = ['approved', 'approval', 'reject'].filter((d) => validateNamed('review', { ...base, decision: d }).length === 0);
  return { ok: bad.length === 0, detail: bad.length ? `accepted: ${bad.join(',')}` : '' };
});

// (f) Regression: frontmatter and original headings intact.
check('f', 'regression', 'frontmatter name/description and original headings still present', () => {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return { ok: false, detail: 'no frontmatter' };
  const desc = 'description: How ECCode reviewers write evidence-backed gate reviews that the engine will accept - criteria with ev:/artifact: evidence, severity-ranked findings with resolution conditions, explicit resolution of earlier findings, and independently executed checks. Use whenever recording `eccode gate review`.';
  const headings = ['# Writing an ECCode gate review', '## Procedure', '## Severity guide', '## Anti-patterns that get work rejected later'];
  const lines = text.split('\n');
  const missing = headings.filter((h) => !lines.includes(h));
  const ok = /^name: review-gate$/m.test(fm[1]) && fm[1].split('\n').includes(desc) && missing.length === 0;
  return { ok, detail: missing.length ? `missing: ${missing.join(' | ')}` : '' };
});

const passed = results.filter((r) => r.ok).length;
const regressionOk = results.filter((r) => r.kind === 'regression').every((r) => r.ok);
console.log(`regression cases: ${regressionOk ? 'all pass' : 'FAILING'}`);
console.log(`ECCODE_EVAL ${JSON.stringify({ passed, total: results.length })}`);
process.exit(regressionOk ? 0 : 1);
