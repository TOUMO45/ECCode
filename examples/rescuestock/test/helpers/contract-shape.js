// Shape comparison for the contract tests: an actual JSON value against the `response` of a fixture in
// test/fixtures/contracts, by key set and value type, never by value.
//   - objects: the key sets must be equal;
//   - arrays: when both are non-empty, every actual element is compared with the first expected element;
//   - null on either side matches anything (a nullable field shows one case in an example);
//   - scalars: typeof must be equal (string, number, boolean).
// compareShape(expected, actual, { optional, free }) -> string[] of mismatches, empty when the shapes agree.
//   optional: paths where a missing or extra key is accepted (for example 'stranded' or 'order.pickup').
//   maps: paths (strings or RegExps) of objects whose keys are data (a count per status): the keys are not compared,
//         and every value must have the shape of the first expected value.
//   free: paths (strings, or RegExps tested against the path) whose content is free-form and is not compared
//         below that point (for example 'plan.trace.inputs'; the spec types Trace.inputs as `object`, candidates as `object[]`).
// Paths are dotted, with [] for an array element: 'plan.body.lines[].supplierCode'.

export function typeOfValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function compareShape(expected, actual, { optional = [], free = [], maps = [] } = {}) {
  const optionalSet = new Set(optional);
  const matches = (list, path) => list.some((entry) => (entry instanceof RegExp ? entry.test(path) : entry === path));
  const isMap = (path) => matches(maps, path);
  const isFree = (path) => matches(free, path);
  const problems = [];

  function walk(exp, act, path) {
    const where = path === '' ? '(root)' : path;
    if (isFree(path)) return;
    if (exp === null || act === null) return; // nullable: either side may be null
    const te = typeOfValue(exp);
    const ta = typeOfValue(act);
    if (te !== ta) {
      problems.push(`${where}: expected ${te}, got ${ta}`);
      return;
    }
    if (te === 'array') {
      if (exp.length === 0 || act.length === 0) return;
      for (const item of act) walk(exp[0], item, `${path}[]`);
      return;
    }
    if (te === 'object' && isMap(path)) {
      // Dynamic keys (for example a count per status): each actual value has the shape of the first expected value.
      const sample = Object.values(exp)[0];
      if (sample === undefined) return;
      for (const value of Object.values(act)) walk(sample, value, `${path}.*`);
      return;
    }
    if (te === 'object') {
      const ek = Object.keys(exp);
      const ak = Object.keys(act);
      const join = (key) => (path === '' ? key : `${path}.${key}`);
      for (const key of ek) {
        if (!Object.hasOwn(act, key)) {
          if (!optionalSet.has(join(key))) problems.push(`${join(key)}: missing (the fixture has it)`);
        }
      }
      for (const key of ak) {
        if (!Object.hasOwn(exp, key)) {
          if (!optionalSet.has(join(key))) problems.push(`${join(key)}: extra (not in the fixture)`);
        }
      }
      for (const key of ek) if (Object.hasOwn(act, key)) walk(exp[key], act[key], join(key));
    }
  }

  walk(expected, actual, '');
  return [...new Set(problems)];
}
