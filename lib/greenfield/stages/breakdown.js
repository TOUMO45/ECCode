'use strict';
// Stage 5, the work breakdown. GF-WBS-1: tasks are consistent with their group, their budget, their dependencies
// and the skeleton's plan.json. GF-WBS-2: group ownership is disjoint and the reserved paths belong to their
// groups. GF-WBS-3: every criterion has a slice and a test task, and every operation exactly one provider.
const { globsOverlap } = require('../../util');
const { GROUPS } = require('../constants');
const { operations } = require('../openapi');
const ownership = require('../ownership');
const { problem, shape, isObj, arr, dupes } = require('./common');

const hasGroup = (name) => typeof name === 'string' && Object.prototype.hasOwnProperty.call(GROUPS, name);
/** Only the strings of a list: a malformed entry is already a shape problem and must not crash the semantic checks. */
const strs = (v) => arr(v).filter((x) => typeof x === 'string');

function hasCycle(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, arr(t.dependencies)]));
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'active') return true;
    state.set(id, 'active');
    for (const d of deps.get(id) || []) if (deps.has(d) && visit(d)) return true;
    state.set(id, 'done');
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

function validate(bd, ctx = {}) {
  const out = shape('GF-WBS-1', 'breakdown', bd, 'breakdown.json');
  if (!isObj(bd)) return out;
  const W1 = (p, m) => out.push(problem('GF-WBS-1', p, m));
  const W2 = (p, m) => out.push(problem('GF-WBS-2', p, m));
  const W3 = (p, m) => out.push(problem('GF-WBS-3', p, m));
  const config = ctx.config || {};
  const budget = (config.plan && config.plan.maxLinesPerTask) || 150;
  const groups = arr(bd.groups).filter(isObj);
  const tasks = arr(bd.tasks).filter(isObj);
  const slices = arr(bd.slices).filter(isObj);
  const docs = ctx.docs || {};

  for (const d of dupes(groups.map((g) => g.name))) W1('/groups', `duplicate group ${d}`);
  for (const g of groups) {
    if (!hasGroup(g.name)) W1(`/groups/${g.name}`, `unknown group ${g.name} (groups: ${Object.keys(GROUPS).join(', ')})`);
    else for (const r of strs(g.roles)) if (!GROUPS[g.name].includes(r)) W1(`/groups/${g.name}`, `role ${r} does not belong to group ${g.name}`);
  }
  const taskIds = tasks.map((t) => t.id);
  for (const d of dupes(taskIds)) W1('/tasks', `duplicate task id ${d}`);
  const sliceIndex = new Map(slices.map((s, i) => [s.id, i]));
  for (const d of dupes(slices.map((s) => s.id))) W1('/slices', `duplicate slice id ${d}`);

  for (const t of tasks) {
    const g = groups.find((x) => x.name === t.group);
    const where = `/tasks/${t.id}`;
    if (!g) { W1(where, `task ${t.id} names group ${t.group}, which is not declared`); continue; }
    if (!strs(g.roles).includes(t.owner)) W1(where, `task ${t.id} is owned by ${t.owner}, who is not in group ${g.name} (${strs(g.roles).join(', ')})`);
    for (const f of strs(t.files)) {
      if (!ownership.covered(f, strs(g.globs))) W1(where, `task ${t.id} file ${f} is outside group ${g.name}'s globs (${strs(g.globs).join(', ')})`);
      else if (globsOverlap([f], strs(g.denyGlobs))) W1(where, `task ${t.id} file ${f} is inside group ${g.name}'s denied globs`);
    }
    if (Number.isInteger(t.estLines) && t.estLines > budget) W1(where, `task ${t.id} estimates ${t.estLines} lines, over the budget of ${budget}; split it`);
    for (const dep of arr(t.dependencies)) {
      const target = tasks.find((x) => x.id === dep);
      if (!target) W1(where, `task ${t.id} depends on unknown task ${dep}`);
      else if (sliceIndex.has(target.slice) && sliceIndex.has(t.slice) && sliceIndex.get(target.slice) > sliceIndex.get(t.slice)) W1(where, `task ${t.id} (slice ${t.slice}) depends on ${dep} from the later slice ${target.slice}`);
    }
    if (!sliceIndex.has(t.slice)) W1(where, `task ${t.id} names unknown slice ${t.slice}`);
  }
  if (hasCycle(tasks)) W1('/tasks', 'the task dependencies contain a cycle');
  for (const s of slices) {
    for (const id of arr(s.tasks)) {
      const t = tasks.find((x) => x.id === id);
      if (!t) W1(`/slices/${s.id}`, `slice ${s.id} lists unknown task ${id}`);
      else if (t.slice !== s.id) W1(`/slices/${s.id}`, `slice ${s.id} lists task ${id}, which belongs to slice ${t.slice}`);
    }
  }
  for (const t of tasks) if (sliceIndex.has(t.slice) && !arr(slices[sliceIndex.get(t.slice)].tasks).includes(t.id)) W1(`/tasks/${t.id}`, `task ${t.id} is not listed by its slice ${t.slice}`);

  // The skeleton slice is the first work item's plan.json: same tasks, same owners, same files.
  if (isObj(docs.plan) && slices.length) {
    const first = tasks.filter((t) => t.slice === slices[0].id);
    const planTasks = arr(docs.plan.tasks).filter(isObj);
    for (const t of first) {
      const p = planTasks.find((x) => x.id === t.id);
      if (!p) W1(`/tasks/${t.id}`, `skeleton task ${t.id} is missing from plan.json`);
      else {
        if (p.owner !== t.owner) W1(`/tasks/${t.id}`, `plan.json gives ${t.id} to ${p.owner} but the breakdown gives it to ${t.owner}`);
        if (JSON.stringify([...arr(p.files)].sort()) !== JSON.stringify([...arr(t.files)].sort())) W1(`/tasks/${t.id}`, `plan.json and the breakdown disagree on the files of ${t.id}`);
      }
    }
    for (const p of planTasks) if (!first.some((t) => t.id === p.id)) W1('/tasks', `plan.json has task ${p.id}, which is not in the skeleton slice ${slices[0].id} of the breakdown`);
  }

  // GF-WBS-2
  for (const p of ownership.disjointProblems(groups.map((g) => ({ name: g.name, globs: strs(g.globs), denyGlobs: strs(g.denyGlobs) })))) W2('/groups', p);
  for (const p of ownership.reservedProblems(groups.map((g) => ({ name: g.name, globs: strs(g.globs) })))) W2(p.group ? `/groups/${p.group}` : '/groups', p.message);

  // GF-WBS-3
  const prdIds = arr(docs.prd && docs.prd.criteria).filter(isObj).map((c) => c.id);
  if (docs.prd) {
    const inSlice = new Set(slices.flatMap((s) => arr(s.criteria)));
    const tested = new Set(tasks.filter((t) => t.group === 'test').flatMap((t) => arr(t.criteria)));
    for (const s of slices) for (const c of arr(s.criteria)) if (!prdIds.includes(c)) W3(`/slices/${s.id}`, `slice ${s.id} lists criterion ${c}, which the PRD lacks`);
    for (const c of prdIds) {
      if (!inSlice.has(c)) W3('/slices', `criterion ${c} is in no slice`);
      if (!tested.has(c)) W3('/tasks', `criterion ${c} has no task in the test group`);
    }
  }
  if (isObj(docs.openapi)) {
    const opIds = operations(docs.openapi).map((o) => o.operationId);
    const providers = tasks.filter((t) => t.group === 'backend');
    for (const o of opIds) {
      const who = providers.filter((t) => arr(t.provides).includes(o));
      if (who.length !== 1) W3('/tasks', `operation ${o} is provided by ${who.length} backend task(s)${who.length ? ` (${who.map((t) => t.id).join(', ')})` : ''}; exactly one is required`);
      const owning = slices.filter((s) => arr(s.operations).includes(o));
      if (owning.length !== 1) W3('/slices', `operation ${o} is in ${owning.length} slice(s); exactly one is required`);
      else if (who.length === 1 && who[0].slice !== owning[0].id) W3('/slices', `operation ${o} belongs to slice ${owning[0].id} but its provider ${who[0].id} is in slice ${who[0].slice}`);
    }
    for (const t of tasks) for (const o of [...arr(t.provides), ...arr(t.consumes)]) if (!opIds.includes(o)) W3(`/tasks/${t.id}`, `task ${t.id} names operation ${o}, which the OpenAPI lacks`);
  }
  return out;
}

module.exports = { validate };
