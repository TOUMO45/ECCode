'use strict';
// Stage 4, the threat model: GF-THR-1. The input-validation checklist is GENERATED from the sealed OpenAPI
// (operations.requestFields), so a missing field is a computed omission, not a judgement.
const { operations, requestFields } = require('../openapi');
const { problem, shape, isObj, arr, dupes } = require('./common');

function validate(threat, ctx = {}) {
  const out = shape('GF-THR-1', 'threat-model', threat, 'threat-model.json');
  if (!isObj(threat)) return out;
  const P = (p, m) => out.push(problem('GF-THR-1', p, m));
  const docs = ctx.docs || {};
  const ops = isObj(docs.openapi) ? operations(docs.openapi).map((o) => o.operationId) : [];
  const boundaries = arr(threat.trustBoundaries).filter(isObj);
  for (const d of dupes(boundaries.map((b) => b.id))) P('/trustBoundaries', `duplicate boundary ${d}`);
  if (ops.length) {
    for (const b of boundaries) for (const o of arr(b.crosses)) if (!ops.includes(o)) P(`/trustBoundaries/${b.id}`, `boundary ${b.id} crosses unknown operation ${o}`);
    const behind = new Set(boundaries.flatMap((b) => arr(b.crosses)));
    for (const o of ops) if (!behind.has(o)) P('/trustBoundaries', `operation ${o} is behind no trust boundary`);
  }
  for (const d of dupes(arr(threat.threats).filter(isObj).map((t) => t.id))) P('/threats', `duplicate threat ${d}`);
  const criteria = arr(docs.prd && docs.prd.criteria).filter(isObj).map((c) => c.id);
  const components = arr(docs.architecture && docs.architecture.components).filter(isObj).map((c) => c.id);
  for (const t of arr(threat.threats).filter(isObj)) {
    if (!boundaries.some((b) => b.id === t.boundary)) P(`/threats/${t.id}`, `threat ${t.id} names unknown boundary ${t.boundary}`);
    const m = t.mitigation;
    if (!isObj(m)) continue;
    const pool = m.ref === 'contract' ? ops : m.ref === 'criterion' ? criteria : m.ref === 'component' ? components : null;
    const known = (m.ref === 'contract' && isObj(docs.openapi)) || (m.ref === 'criterion' && docs.prd) || (m.ref === 'component' && docs.architecture);
    if (pool && known && !pool.includes(m.id)) P(`/threats/${t.id}`, `threat ${t.id} is mitigated by ${m.ref} ${m.id}, which does not exist`);
  }
  if (ops.length) {
    const want = new Set(ops.flatMap((o) => requestFields(docs.openapi, o).map((f) => `${o}|${f}`)));
    const have = new Set(arr(threat.inputValidation).filter(isObj).map((v) => `${v.operationId}|${v.field}`));
    const missing = [...want].filter((k) => !have.has(k));
    const extra = [...have].filter((k) => !want.has(k));
    if (missing.length) P('/inputValidation', `${missing.length} request field(s) have no input-validation entry, for example ${missing.slice(0, 3).join(', ')}`);
    if (extra.length) P('/inputValidation', `${extra.length} input-validation entr${extra.length === 1 ? 'y names' : 'ies name'} a field the contract lacks, for example ${extra.slice(0, 3).join(', ')}`);
  }
  if (ctx.hashes && ctx.hashes.accessMatrix && threat.accessMatrixSha256 !== ctx.hashes.accessMatrix) {
    P('/accessMatrixSha256', 'accessMatrixSha256 is not the hash of contracts/access-matrix.json (the threat model was written against another matrix)');
  }
  return out;
}

module.exports = { validate };
