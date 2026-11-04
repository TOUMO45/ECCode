'use strict';
// OpenAPI 3.x as the greenfield layer reads it: a structural validator (rule GF-CON-1), an operation index, the
// list of request fields the threat model must cover, and an operation-level differ for amendments.
// Structural means: the shapes the layer relies on are present and consistent. It does not interpret every
// OpenAPI feature (callbacks, links, webhooks are ignored) and it is not a replacement for a full validator.
const { resolveRef, canonical } = require('./jsonschema');

const RULE = 'GF-CON-1';
const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'];
const PATH_ITEM_OTHER = new Set(['parameters', 'summary', 'description', 'servers']);
const OPERATION_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const NO_BODY = new Set(['204', '205', '304']);
const MAX_PROBLEMS = 100;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ANNOTATION_ONLY = new Set(['description', 'example', 'examples', 'title', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs', 'xml']);
/** A schema that constrains nothing: not an object, or only annotations. Such a schema makes a response contract vacuous. */
const vacuous = (schema) => !isObj(schema) || Object.keys(schema).every((k) => ANNOTATION_ONLY.has(k) || k.startsWith('x-'));
const problem = (message, path = '') => ({ rule: RULE, path, message });

/** Follow a chain of local $ref (bounded). Returns the target, or undefined when it does not resolve. */
function deref(doc, node) {
  let cur = node;
  for (let i = 0; i < 20 && isObj(cur) && typeof cur.$ref === 'string'; i++) cur = resolveRef(doc, cur.$ref);
  return cur;
}

/** Every operation of the document: [{ operationId, method, path, op, item }] (operations without a string operationId are included with operationId null). */
function walkOperations(doc) {
  const out = [];
  if (!isObj(doc) || !isObj(doc.paths)) return out;
  for (const [p, item] of Object.entries(doc.paths)) {
    if (!isObj(item)) continue;
    for (const m of METHODS) {
      if (isObj(item[m])) out.push({ operationId: typeof item[m].operationId === 'string' ? item[m].operationId : null, method: m, path: p, op: item[m], item });
    }
  }
  return out;
}

function securityOf(doc, op) {
  if (Array.isArray(op.security)) return op.security;
  return Array.isArray(doc.security) ? doc.security : [];
}

function operations(doc) {
  return walkOperations(doc)
    .filter((o) => o.operationId !== null)
    .map(({ operationId, method, path, op }) => ({
      operationId,
      method,
      path,
      public: op['x-gf-public'] === true,
      internal: op['x-gf-internal'] === true,
      pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]),
      security: securityOf(doc, op),
    }));
}

function validateOpenApi(doc) {
  const problems = [];
  const add = (message, path) => { if (problems.length < MAX_PROBLEMS) problems.push(problem(message, path)); };
  if (!isObj(doc)) return [problem('the document is not a JSON object')];
  if (typeof doc.openapi !== 'string' || !/^3\./.test(doc.openapi)) add('openapi must be a 3.x version string', '/openapi');
  if (!isObj(doc.info) || typeof doc.info.title !== 'string' || !doc.info.title) add('info.title is required', '/info/title');
  if (!isObj(doc.info) || typeof doc.info.version !== 'string' || !doc.info.version) add('info.version is required', '/info/version');
  if (!isObj(doc.paths) || Object.keys(doc.paths).length === 0) {
    add('paths must be a non-empty object', '/paths');
  } else {
    const seen = new Set();
    const duplicated = new Set();
    const schemes = isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : {};
    const undefinedSchemes = new Set();
    for (const [p, item] of Object.entries(doc.paths)) {
      if (!isObj(item)) { add(`path item ${p} is not an object`, `/paths/${p}`); continue; }
      if (!p.startsWith('/')) add(`path "${p}" must start with a slash`, `/paths/${p}`);
      if (has(item, '$ref')) { add(`path item ${p} is defined by $ref, which is not supported: its operations would be invisible to the access matrix, the threat model and the breakdown. Define the operations inline`, `/paths/${p}/$ref`); continue; }
      for (const key of Object.keys(item)) {
        if (!METHODS.includes(key) && !PATH_ITEM_OTHER.has(key) && !key.startsWith('x-')) add(`unknown key "${key}" in path item ${p}`, `/paths/${p}/${key}`);
      }
      for (const m of METHODS) {
        const op = item[m];
        if (op === undefined) continue;
        const where = `${m} ${p}`;
        if (!isObj(op)) { add(`${where} is not an object`, `/paths/${p}/${m}`); continue; }
        if (typeof op.operationId !== 'string' || !op.operationId) add(`${where} has no operationId`, `/paths/${p}/${m}/operationId`);
        else {
          if (!OPERATION_ID.test(op.operationId)) add(`operationId "${op.operationId}" of ${where} must match ${OPERATION_ID}`, `/paths/${p}/${m}/operationId`);
          if (seen.has(op.operationId)) duplicated.add(op.operationId);
          seen.add(op.operationId);
        }
        const responses = isObj(op.responses) ? op.responses : null;
        if (!responses) add(`${where} has no responses`, `/paths/${p}/${m}/responses`);
        else {
          const codes = Object.keys(responses);
          if (!codes.some((c) => /^2(\d\d|XX)$/i.test(c))) add(`${where}: no 2xx response`, `/paths/${p}/${m}/responses`);
          if (!codes.some((c) => /^4(\d\d|XX)$/i.test(c) || c === 'default')) add(`${where}: no 4xx or default response`, `/paths/${p}/${m}/responses`);
          for (const c of codes) {
            const r = deref(doc, responses[c]);
            if (!isObj(r)) continue; // an unresolved $ref is reported by the global pass
            if (NO_BODY.has(c)) continue;
            const schema = isObj(r.content) && isObj(r.content['application/json']) ? r.content['application/json'].schema : undefined;
            if (schema === undefined) add(`response ${c} of ${where} has no JSON schema (content.application/json.schema)`, `/paths/${p}/${m}/responses/${c}`);
            else if (vacuous(schema)) add(`response ${c} of ${where} has an empty schema: it constrains nothing, so the contract says nothing about this response`, `/paths/${p}/${m}/responses/${c}`);
          }
        }
        if (op.requestBody !== undefined) {
          const rb = deref(doc, op.requestBody);
          const schema = isObj(rb) && isObj(rb.content) && isObj(rb.content['application/json']) ? rb.content['application/json'].schema : undefined;
          if (isObj(rb) && schema === undefined) add(`requestBody of ${where} needs content.application/json.schema`, `/paths/${p}/${m}/requestBody`);
          else if (isObj(rb) && vacuous(schema)) add(`requestBody of ${where} has an empty schema: it constrains nothing`, `/paths/${p}/${m}/requestBody`);
        }
        const sec = securityOf(doc, op);
        if (op['x-gf-public'] !== true && sec.length === 0) add(`${where}: no security requirement and not x-gf-public`, `/paths/${p}/${m}/security`);
        else if (op['x-gf-public'] !== true && sec.some((req) => isObj(req) && Object.keys(req).length === 0)) add(`${where}: an empty security requirement ({}) makes the operation anonymous, and it is not marked x-gf-public`, `/paths/${p}/${m}/security`);
        for (const req of sec) {
          if (!isObj(req)) continue;
          for (const name of Object.keys(req)) if (!has(schemes, name)) undefinedSchemes.add(name);
        }
      }
    }
    for (const id of duplicated) add(`duplicate operationId ${id}`, '/paths');
    for (const name of undefinedSchemes) add(`security scheme "${name}" is not defined in components.securitySchemes`, '/components/securitySchemes');
  }
  // Every $ref in the document must be local and resolve. Iterative walk: a hostile depth cannot overflow the stack.
  const stack = [[doc, '']];
  const unresolved = new Set();
  while (stack.length) {
    const [node, path] = stack.pop();
    if (Array.isArray(node)) { node.forEach((v, i) => { if (v !== null && typeof v === 'object') stack.push([v, `${path}/${i}`]); }); continue; }
    if (!isObj(node)) continue;
    if (typeof node.$ref === 'string') {
      if (!node.$ref.startsWith('#')) add(`only local $ref is supported, found ${node.$ref}`, path);
      else if (resolveRef(doc, node.$ref) === undefined && !unresolved.has(node.$ref)) { unresolved.add(node.$ref); add(`unresolved $ref ${node.$ref}`, path); }
    }
    for (const [k, v] of Object.entries(node)) if (v !== null && typeof v === 'object') stack.push([v, `${path}/${k}`]);
  }
  return problems;
}

/** The request fields of one operation: path:x, query:x, header:x and body:a.b (leaves of the JSON body, depth 3). Sorted. */
function requestFields(doc, operationId) {
  const found = walkOperations(doc).find((o) => o.operationId === operationId);
  if (!found) throw new Error(`unknown operationId ${operationId}`);
  const out = new Set();
  const params = [...(Array.isArray(found.item.parameters) ? found.item.parameters : []), ...(Array.isArray(found.op.parameters) ? found.op.parameters : [])];
  for (const raw of params) {
    const prm = deref(doc, raw);
    if (isObj(prm) && ['path', 'query', 'header'].includes(prm.in) && typeof prm.name === 'string') out.add(`${prm.in}:${prm.name}`);
  }
  for (const m of found.path.matchAll(/\{([^}]+)\}/g)) out.add(`path:${m[1]}`);
  const rb = found.op.requestBody === undefined ? null : deref(doc, found.op.requestBody);
  const schema = isObj(rb) && isObj(rb.content) && isObj(rb.content['application/json']) ? rb.content['application/json'].schema : undefined;
  if (schema !== undefined) {
    const leaf = (s, name, depth) => {
      let node = deref(doc, s);
      if (isObj(node) && Array.isArray(node.allOf)) {
        const merged = { properties: {} };
        for (const part of node.allOf) { const d = deref(doc, part); if (isObj(d) && isObj(d.properties)) Object.assign(merged.properties, d.properties); }
        node = { ...node, properties: { ...merged.properties, ...(isObj(node.properties) ? node.properties : {}) } };
      }
      if (!isObj(node)) { out.add(`body:${name || '(root)'}`); return; }
      if (isObj(node.properties) && Object.keys(node.properties).length && depth < 3) {
        for (const [k, v] of Object.entries(node.properties)) leaf(v, name ? `${name}.${k}` : k, depth + 1);
      } else if (node.type === 'array' && node.items !== undefined) {
        const item = deref(doc, node.items);
        if (isObj(item) && isObj(item.properties) && Object.keys(item.properties).length && depth < 3) {
          for (const [k, v] of Object.entries(item.properties)) leaf(v, `${name}[].${k}`, depth + 1);
        } else out.add(`body:${name || '(root)'}`);
      } else out.add(`body:${name || '(root)'}`);
    };
    leaf(schema, '', 0);
  }
  return [...out].sort();
}

/** The operation with every local $ref inlined (a cycle becomes a marker), for comparison. */
function inline(doc, node, trail = [], depth = 0) {
  if (depth > 40) return { $depth: true };
  if (Array.isArray(node)) return node.map((v) => inline(doc, v, trail, depth + 1));
  if (!isObj(node)) return node;
  if (typeof node.$ref === 'string') {
    if (trail.includes(node.$ref)) return { $cycle: node.$ref };
    const target = resolveRef(doc, node.$ref);
    return target === undefined ? { $unresolved: node.$ref } : inline(doc, target, [...trail, node.$ref], depth + 1);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = inline(doc, v, trail, depth + 1);
  return out;
}

function operationMap(doc) {
  const map = new Map();
  for (const o of walkOperations(doc)) {
    if (o.operationId !== null) map.set(o.operationId, canonical({ method: o.method, path: o.path, params: inline(doc, o.item.parameters || []), op: inline(doc, o.op) }));
  }
  return map;
}

/** Operation-level difference by operationId. An operation moved to another method or path counts as changed. */
function diff(a, b) {
  const before = operationMap(a);
  const after = operationMap(b);
  return {
    added: [...after.keys()].filter((k) => !before.has(k)).sort(),
    removed: [...before.keys()].filter((k) => !after.has(k)).sort(),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)).sort(),
  };
}

/** Conservative: removing or changing an operation is breaking; only additions are additive. */
function classify(d) {
  if (d.removed.length || d.changed.length) return 'breaking';
  return d.added.length ? 'additive' : 'none';
}

module.exports = { validateOpenApi, operations, requestFields, diff, classify, deref, walkOperations, RULE };
