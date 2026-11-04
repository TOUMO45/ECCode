'use strict';
// Stage 3, the contracts bundle: GF-CON-1 (OpenAPI), GF-CON-2 (database schema + migration plan), GF-CON-3
// (the access matrix is complete over roles x operations x ownership), GF-CON-4 (fixtures and the optional
// events contract), GF-CON-5 (the PRD and the contract agree). Documents that failed to load are absent
// (undefined); their absence is reported by bundle.js and the checks that need them are skipped.
const { validateOpenApi, operations } = require('../openapi');
const { problem, shape, isObj, arr, dupes } = require('./common');

/** The ownerships a matrix needs for an operation: own and other when the path has a parameter, otherwise none. */
const ownershipsFor = (op) => (op.pathParams.length ? ['own', 'other'] : ['none']);

function db(docs, out) {
  const P = (p, m) => out.push(problem('GF-CON-2', p, m));
  if (docs.dbSchema !== undefined) {
    out.push(...shape('GF-CON-2', 'db-schema', docs.dbSchema, 'db-schema.json'));
    const tables = arr(isObj(docs.dbSchema) && docs.dbSchema.tables).filter(isObj);
    for (const d of dupes(tables.map((t) => t.name))) P('/tables', `duplicate table ${d}`);
    for (const t of tables) {
      const cols = arr(t.columns).filter(isObj);
      for (const d of dupes(cols.map((c) => c.name))) P(`/tables/${t.name}`, `table ${t.name} has two columns named ${d}`);
      if (!cols.some((c) => c.primaryKey === true)) P(`/tables/${t.name}`, `table ${t.name} has no primary key`);
      for (const c of cols) {
        if (!isObj(c.references)) continue;
        const target = tables.find((x) => x.name === c.references.table);
        if (!target) P(`/tables/${t.name}/${c.name}`, `${t.name}.${c.name} references unknown table ${c.references.table}`);
        else if (!arr(target.columns).some((x) => x.name === c.references.column)) P(`/tables/${t.name}/${c.name}`, `${t.name}.${c.name} references unknown column ${c.references.table}.${c.references.column}`);
      }
    }
  }
  if (docs.migrationsPlan !== undefined) {
    out.push(...shape('GF-CON-2', 'migrations-plan', docs.migrationsPlan, 'migrations-plan.json'));
    const steps = arr(isObj(docs.migrationsPlan) && docs.migrationsPlan.steps).filter(isObj);
    for (const d of dupes(steps.map((s) => s.id))) P('/steps', `duplicate migration step ${d}`);
    const orders = steps.map((s) => s.order);
    if (orders.some((o, i) => i > 0 && !(o > orders[i - 1]))) P('/steps', 'migration steps must be in strictly increasing order');
    const tables = arr(isObj(docs.dbSchema) && docs.dbSchema.tables).filter(isObj).map((t) => t.name);
    const created = steps.flatMap((s) => arr(s.creates));
    for (const t of created) if (docs.dbSchema !== undefined && !tables.includes(t)) P('/steps', `a step creates ${t}, which db-schema.json does not define`);
    if (docs.dbSchema !== undefined) {
      for (const t of tables) {
        const n = created.filter((x) => x === t).length;
        if (n !== 1) P('/steps', `table ${t} is created by ${n} migration steps; exactly one is required`);
      }
    }
  }
}

function matrix(docs, ops, out) {
  if (docs.accessMatrix === undefined) return;
  const P = (p, m) => out.push(problem('GF-CON-3', p, m));
  out.push(...shape('GF-CON-3', 'access-matrix', docs.accessMatrix, 'access-matrix.json'));
  if (!isObj(docs.accessMatrix)) return;
  const roles = arr(docs.accessMatrix.roles).filter(isObj);
  const cells = arr(docs.accessMatrix.cells).filter(isObj);
  for (const d of dupes(roles.map((r) => r.name))) P('/roles', `duplicate role ${d}`);
  const anon = roles.find((r) => r.name === 'anonymous');
  if (!anon || anon.level !== 0) P('/roles', 'the matrix needs an "anonymous" role at level 0');
  const key = (c) => `${c.role}|${c.operationId}|${c.ownership}`;
  for (const d of dupes(cells.map(key))) P('/cells', `duplicate cell ${d}`);
  const want = new Set();
  for (const r of roles) for (const o of ops) for (const own of ownershipsFor(o)) want.add(`${r.name}|${o.operationId}|${own}`);
  const have = new Set(cells.map(key));
  const missing = [...want].filter((k) => !have.has(k));
  const extra = [...have].filter((k) => !want.has(k));
  if (missing.length) P('/cells', `${missing.length} cell(s) missing, for example ${missing.slice(0, 3).join(', ')} (every role x operation x ownership needs a verdict)`);
  if (extra.length) P('/cells', `${extra.length} cell(s) match no role, operation or ownership, for example ${extra.slice(0, 3).join(', ')}`);
}

function fixtures(docs, ops, out) {
  const P = (p, m) => out.push(problem('GF-CON-4', p, m));
  if (docs.fixtures !== undefined) {
    out.push(...shape('GF-CON-4', 'fixtures', docs.fixtures, 'fixtures.json'));
    if (isObj(docs.fixtures) && isObj(docs.fixtures.roles)) {
      const names = isObj(docs.accessMatrix) ? arr(docs.accessMatrix.roles).filter(isObj).map((r) => r.name) : null;
      const opIds = ops.map((o) => o.operationId);
      for (const [name, f] of Object.entries(docs.fixtures.roles)) {
        if (names && !names.includes(name)) P(`/roles/${name}`, `fixtures define role ${name}, which the access matrix does not`);
        if (name === 'anonymous' && isObj(f) && Object.keys(f).length) P('/roles/anonymous', 'the anonymous role has no credentials: it must be empty in fixtures.json');
        if (isObj(f) && isObj(f.login) && ops.length && !opIds.includes(f.login.operationId)) P(`/roles/${name}`, `${name} logs in with operation ${f.login.operationId}, which the OpenAPI lacks`);
      }
      if (!Object.entries(docs.fixtures.roles).some(([n, f]) => n !== 'anonymous' && isObj(f) && (isObj(f.login) || isObj(f.headers)))) P('/roles', 'fixtures need at least one non-anonymous role with a login or headers');
    }
  }
  if (docs.events !== undefined) out.push(...shape('GF-CON-4', 'events', docs.events, 'events.json'));
}

/** The operationIds and roles a PRD criterion calls. */
function calls(prd) {
  const out = [];
  for (const c of arr(prd && prd.criteria).filter(isObj)) {
    const v = c.verify;
    if (!isObj(v)) continue;
    if (v.kind === 'http') out.push({ id: c.id, operationId: v.operationId, as: v.as });
    if (v.kind === 'flow') for (const s of arr(v.steps).filter(isObj)) out.push({ id: c.id, operationId: s.operationId, as: s.as });
  }
  return out;
}

function prdAgreement(docs, ops, prd, out) {
  const P = (p, m) => out.push(problem('GF-CON-5', p, m));
  const opIds = ops.map((o) => o.operationId);
  const roles = isObj(docs.accessMatrix) ? arr(docs.accessMatrix.roles).filter(isObj).map((r) => r.name) : null;
  const used = new Set();
  for (const c of calls(prd)) {
    used.add(c.operationId);
    if (opIds.length && !opIds.includes(c.operationId)) P(`/criteria/${c.id}`, `${c.id} calls operation ${c.operationId}, which the OpenAPI lacks`);
    if (roles && !roles.includes(c.as)) P(`/criteria/${c.id}`, `${c.id} acts as role ${c.as}, which the access matrix lacks`);
  }
  for (const o of ops) if (!o.internal && !used.has(o.operationId)) P(`/paths`, `operation ${o.operationId} is covered by no PRD criterion (cover it or mark it x-gf-internal)`);
}

function validate(docs, ctx = {}) {
  const out = [];
  if (docs.openapi !== undefined) out.push(...validateOpenApi(docs.openapi));
  const ops = docs.openapi !== undefined && isObj(docs.openapi) ? operations(docs.openapi) : [];
  db(docs, out);
  matrix(docs, ops, out);
  fixtures(docs, ops, out);
  const prd = ctx.docs && ctx.docs.prd;
  if (prd !== undefined && docs.openapi !== undefined) prdAgreement(docs, ops, prd, out);
  return out;
}

module.exports = { validate, ownershipsFor, calls };
