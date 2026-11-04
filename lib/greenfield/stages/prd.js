'use strict';
// Stage 1, the PRD: GF-PRD-1 (shape, coverage), GF-PRD-2 (every criterion is machine-checkable),
// GF-PRD-3 (ambiguity is scanned, and every guess is a recorded assumption).
const { problem, shape, isObj, arr, dupes } = require('./common');

const KINDS = ['http', 'flow', 'command', 'browser'];
const status = (e) => isObj(e) && Number.isInteger(e.status);
const str = (v) => typeof v === 'string' && v.length > 0;

/** The way a criterion is verified, or a reason it is not machine-checkable. */
function verifyProblem(v) {
  if (!isObj(v)) return 'verify is missing: a criterion must say how a machine checks it';
  if (!KINDS.includes(v.kind)) return `verify.kind "${v.kind}" is not one of ${KINDS.join(', ')}`;
  if (v.kind === 'http') {
    if (!str(v.operationId)) return 'an http check needs verify.operationId';
    if (!str(v.as)) return 'an http check needs verify.as (the role that calls)';
    if (!status(v.expect)) return 'an http check needs verify.expect.status (an integer)';
  } else if (v.kind === 'flow') {
    if (!Array.isArray(v.steps) || v.steps.length === 0) return 'a flow check needs at least one step';
    for (const [i, s] of v.steps.entries()) {
      if (!isObj(s) || !str(s.operationId) || !str(s.as) || !status(s.expect)) return `flow step ${i} needs operationId, as and expect.status`;
    }
  } else if (v.kind === 'command') {
    if (!str(v.run)) return 'a command check needs verify.run';
    if (!Number.isInteger(v.expectExit)) return 'a command check needs verify.expectExit (an integer)';
  } else if (v.kind === 'browser') {
    if (!str(v.script)) return 'a browser check needs verify.script';
    if (!isObj(v.expect)) return 'a browser check needs verify.expect';
  }
  return null;
}

/** Questions recorded by the design module, with whether anyone answered them. */
function recorded(base) {
  const d = (base && base.design) || {};
  const answered = new Set([...arr(d.clarifications).filter((c) => c.by === 'user').map((c) => c.question), ...arr(d.assumptions).map((a) => a.question)]);
  const all = arr(d.ambiguities).flatMap((a) => arr(a.questions));
  return { all, open: all.filter((q) => !answered.has(q.id)), design: d };
}

function validate(prd, ctx = {}) {
  const out = shape('GF-PRD-1', 'prd', prd, 'prd.json');
  if (!isObj(prd)) return out;
  const scope = arr(prd.scope).filter(isObj);
  const criteria = arr(prd.criteria).filter(isObj);
  const scopeIds = scope.map((s) => s.id);
  for (const d of dupes(scopeIds)) out.push(problem('GF-PRD-1', '/scope', `duplicate scope id ${d}`));
  for (const d of dupes(criteria.map((c) => c.id))) out.push(problem('GF-PRD-1', '/criteria', `duplicate criterion id ${d}`));
  for (const d of dupes(arr(prd.users).filter(isObj).map((u) => u.id))) out.push(problem('GF-PRD-1', '/users', `duplicate user id ${d}`));
  const covers = new Set();
  for (const c of criteria) {
    for (const s of arr(c.covers)) {
      if (!scopeIds.includes(s)) out.push(problem('GF-PRD-1', `/criteria/${c.id}/covers`, `${c.id} covers unknown scope id ${s}`));
      covers.add(s);
    }
  }
  for (const s of scopeIds) if (!covers.has(s)) out.push(problem('GF-PRD-1', '/scope', `scope item ${s} is covered by no criterion`));

  for (const c of criteria) {
    const why = verifyProblem(c.verify);
    if (why) out.push(problem('GF-PRD-2', `/criteria/${c.id}/verify`, `${c.id}: ${why}`));
  }

  const scan = prd.ambiguityScan;
  const rec = recorded(ctx.base);
  if (isObj(scan) && scan.none === true) {
    if (rec.all.length) out.push(problem('GF-PRD-3', '/ambiguityScan', `ambiguityScan claims nothing is ambiguous, but ${rec.all.length} question(s) are recorded (${rec.all.map((q) => q.id).join(', ')})${rec.open.length ? `; ${rec.open.length} still open` : ''}`));
  } else if (Array.isArray(scan)) {
    const ids = scan.filter(isObj).map((e) => e.id);
    for (const d of dupes(ids)) out.push(problem('GF-PRD-3', '/ambiguityScan', `duplicate ambiguity entry ${d}`));
    for (const e of scan.filter(isObj)) {
      if (e.resolution === 'assumed') {
        if (!str(e.assumptionId) || !arr(rec.design.assumptions).some((a) => a.question === e.assumptionId)) out.push(problem('GF-PRD-3', `/ambiguityScan/${e.id}`, `${e.id} is marked assumed but no recorded assumption answers question ${e.assumptionId || '(none given)'}`));
      } else if (e.resolution === 'clarified') {
        if (!arr(rec.design.clarifications).some((c) => c.question === e.id && c.by === 'user')) out.push(problem('GF-PRD-3', `/ambiguityScan/${e.id}`, `${e.id} is marked clarified but the user has not clarified question ${e.id}`));
      }
    }
    for (const q of rec.all) if (!ids.includes(q.id)) out.push(problem('GF-PRD-3', '/ambiguityScan', `question ${q.id} is recorded but missing from ambiguityScan`));
  }
  return out;
}

module.exports = { validate, verifyProblem, KINDS };
