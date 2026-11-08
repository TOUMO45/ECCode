'use strict';
// The gf.* events. Every payload is validated against its schema BEFORE the log is touched, then committed
// through the frozen store, so the events join the same hash chain as the engine's own. The frozen reducer
// ignores unknown events (lib/reducer.js default branch), so state.json is unaffected; GF state is rebuilt by
// projection.js.
const { EccodeError } = require('../util');
const { validate: validateSchema } = require('./jsonschema');
const C = require('./constants');

const SHA = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const STR = { type: 'string', minLength: 1 };
const HEX = { type: 'string', pattern: '^[0-9a-f]{40,64}$' };
const STEP = { enum: ['comprehension', 'critique', 'readiness'] };
const FINDING = { type: 'object', required: ['id', 'severity', 'kind', 'summary'], additionalProperties: false, properties: { id: STR, severity: { enum: ['blocking', 'major', 'minor'] }, kind: { enum: ['defect', 'documentation'] }, summary: { type: 'string', minLength: 10 } } };
const COUNT = { type: 'integer', minimum: 0 };
const TOKENS = { anyOf: [{ type: 'integer', minimum: 0 }, { const: 'unmeasurable' }] };
const range = { type: 'object', required: ['low', 'high'], additionalProperties: false, properties: { low: { type: 'number', minimum: 0 }, high: { type: 'number', minimum: 0 } } };
const estimateGroups = {
  type: 'object',
  additionalProperties: { type: 'object', required: ['tasks', 'minutes', 'tokens'], additionalProperties: false, properties: { tasks: { type: 'integer', minimum: 0 }, minutes: range, tokens: range } },
};

const TYPES = {
  'gf.project.initialized': {
    type: 'object', required: ['stackProfile', 'schemaVersion', 'groups'], additionalProperties: false,
    properties: {
      stackProfile: { enum: C.STACK_PROFILES },
      schemaVersion: { const: 1 },
      groups: { type: 'object', additionalProperties: { type: 'array', minItems: 1, items: STR } },
    },
  },
  'gf.artifact.registered': {
    type: 'object', required: ['stage', 'gate', 'submissionId', 'files', 'validator'], additionalProperties: false,
    properties: {
      stage: { enum: C.STAGES },
      gate: { enum: Object.keys(C.GATE_STAGES) },
      submissionId: STR,
      files: { type: 'array', minItems: 1, items: { type: 'object', required: ['path', 'sha256'], additionalProperties: false, properties: { path: STR, sha256: SHA } } },
      validator: { type: 'object', required: ['name', 'version'], additionalProperties: false, properties: { name: STR, version: { type: 'integer', minimum: 1 } } },
    },
  },
  'gf.estimate.registered': {
    type: 'object', required: ['id', 'planSubmissionId', 'sha256', 'label', 'basis', 'groups'], additionalProperties: false,
    properties: { id: STR, planSubmissionId: STR, sha256: SHA, label: { const: C.ESTIMATE_LABEL }, basis: { type: 'string', minLength: 40 }, groups: estimateGroups },
  },
  'gf.estimate.revised': {
    type: 'object', required: ['id', 'of', 'reason', 'groups'], additionalProperties: false,
    properties: { id: STR, of: STR, reason: { type: 'string', minLength: 20 }, groups: estimateGroups },
  },
  'gf.g1.sealed': {
    type: 'object', required: ['contractsHash', 'hashes', 'planSubmissionId', 'estimateSeq'], additionalProperties: false,
    properties: { contractsHash: SHA, hashes: { type: 'object', additionalProperties: SHA }, planSubmissionId: STR, estimateSeq: { type: 'integer', minimum: 1 } },
  },
  'gf.message': {
    type: 'object', required: ['id', 'from', 'to', 'kind', 'subject', 'body'], additionalProperties: false,
    properties: {
      id: STR, from: STR, to: { type: 'array', minItems: 1, items: STR }, kind: { enum: C.MESSAGE_KINDS },
      subject: { type: 'string', minLength: 3, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 4096 },
      refs: { type: 'array', items: STR }, inReplyTo: STR,
    },
  },
  'gf.contract.amendment.requested': {
    type: 'object', required: ['id', 'contract', 'reason', 'message', 'proposed'], additionalProperties: false,
    properties: { id: STR, contract: STR, reason: { type: 'string', minLength: 20 }, message: STR, proposed: { type: 'string', minLength: 10 } },
  },
  'gf.contract.amended': {
    type: 'object', required: ['id', 'request', 'contract', 'fromSha', 'toSha', 'reason', 'classification', 'affectedOps', 'invalidates'], additionalProperties: false,
    properties: {
      id: STR, request: STR, contract: STR, fromSha: SHA, toSha: SHA, reason: { type: 'string', minLength: 30 },
      classification: { enum: ['additive', 'breaking', 'none'] }, affectedOps: { type: 'array', items: STR }, invalidates: { type: 'array', items: STR },
    },
  },
  'gf.ownership.amended': {
    type: 'object', required: ['id', 'group', 'from', 'to', 'reason', 'message'], additionalProperties: false,
    properties: { id: STR, group: STR, from: { type: 'array', items: STR }, to: { type: 'array', minItems: 1, items: STR }, reason: { type: 'string', minLength: 30 }, message: STR },
  },
  'gf.config.pinned': {
    type: 'object', required: ['id', 'scope', 'files', 'reason'], additionalProperties: false,
    properties: { id: STR, scope: STR, files: { type: 'object', additionalProperties: SHA }, reason: { type: 'string', minLength: 10 } },
  },
  'gf.dispatch.recorded': {
    type: 'object', required: ['id', 'scope', 'role', 'step', 'treeHash', 'inputs'], additionalProperties: false,
    properties: { id: STR, scope: STR, role: STR, step: STEP, treeHash: HEX, inputs: { type: 'array', minItems: 1, items: { type: 'object', required: ['path', 'sha256'], additionalProperties: false, properties: { path: STR, sha256: SHA } } } },
  },
  'gf.review.recorded': {
    type: 'object', required: ['id', 'scope', 'step', 'dispatch', 'treeHash', 'summary', 'verdict'], additionalProperties: false,
    properties: { id: STR, scope: STR, step: STEP, dispatch: STR, treeHash: HEX, summary: { type: 'string', minLength: 100 }, verdict: { enum: ['clean', 'findings', 'go', 'no-go'] }, findings: { type: 'array', items: FINDING }, evidence: { type: 'array', items: STR } },
  },
  'gf.finding.resolved': {
    type: 'object', required: ['id', 'finding', 'resolution'], additionalProperties: false,
    properties: { id: STR, finding: STR, resolution: { enum: ['fixed', 'withdrawn', 'deferred'] }, proof: STR, reproduction: STR, reason: STR, limit: STR },
  },
  'gf.battery.recorded': {
    type: 'object', required: ['id', 'scope', 'round', 'treeHash', 'evidence', 'total', 'killed', 'survived', 'survivors'], additionalProperties: false,
    properties: { id: STR, scope: STR, round: { type: 'integer', minimum: 1 }, treeHash: HEX, evidence: { type: 'string', pattern: '^ev:.+' }, total: COUNT, killed: COUNT, survived: COUNT, survivors: { type: 'array', items: { type: 'object', required: ['key'], additionalProperties: false, properties: { key: STR } } } },
  },
  'gf.slice.closed': {
    type: 'object', required: ['scope', 'treeHash', 'steps', 'batteries', 'accounting'], additionalProperties: false,
    properties: {
      scope: STR, treeHash: HEX,
      steps: { type: 'object', required: ['comprehension', 'critique', 'readiness'], additionalProperties: false, properties: { comprehension: STR, critique: STR, readiness: STR } },
      batteries: { type: 'array', items: STR },
      accepted: { type: 'array', items: { type: 'object', required: ['key', 'reason'], additionalProperties: false, properties: { key: STR, reason: { type: 'string', minLength: 30 } } } },
      accounting: { type: 'object', required: ['unit', 'start', 'end'], additionalProperties: false, properties: { unit: { const: 'all-processed-tokens' }, start: TOKENS, end: TOKENS } },
    },
  },
  'gf.slice.accepted': {
    type: 'object', required: ['id', 'scope', 'treeHash', 'accepted', 'caveat'], additionalProperties: false,
    properties: {
      id: STR, scope: STR, treeHash: HEX,
      accepted: { type: 'array', items: { type: 'object', required: ['finding', 'severity', 'limit', 'reason'], additionalProperties: false, properties: { finding: STR, severity: { enum: ['blocking', 'major', 'minor'] }, limit: { type: 'string', pattern: '^L-GF-[0-9]+$' }, reason: { type: 'string', minLength: 30 } } } },
      caveat: { const: C.ACCEPT_CAVEAT },
    },
  },
  // S2.4 (design 21): kernel isolation.
  'gf.isolation.checked': {
    type: 'object', required: ['ok', 'platform', 'usable', 'landlockAbi', 'bwrap', 'pidns', 'reasons'], additionalProperties: false,
    properties: { ok: { type: 'boolean' }, platform: STR, usable: { type: 'array', items: { enum: ['both', 'landlock', 'bwrap'] } }, landlockAbi: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }, bwrap: { anyOf: [STR, { type: 'null' }] }, pidns: { type: 'boolean' }, reasons: { type: 'array', items: { type: 'string' } } },
  },
  'gf.group.committed': {
    type: 'object', required: ['id', 'group', 'actor', 'task', 'branch', 'parent', 'commit', 'tree', 'files', 'sanitized'], additionalProperties: false,
    properties: {
      id: STR, group: STR, actor: STR, task: STR, branch: STR, parent: HEX, commit: HEX, tree: HEX,
      files: { type: 'array', minItems: 1, items: { type: 'object', required: ['path', 'action'], additionalProperties: false, properties: { path: STR, action: { enum: ['add', 'modify', 'delete'] }, mode: { enum: ['100644', '100755'] }, blob: HEX } } },
      sanitized: { type: 'array', items: STR },
    },
  },
  'gf.groups.merged': {
    type: 'object', required: ['id', 'scope', 'target', 'from', 'to', 'order', 'merges', 'checks'], additionalProperties: false,
    properties: {
      id: STR, scope: STR, target: STR, from: HEX, to: HEX, order: { type: 'array', items: STR },
      merges: { type: 'array', minItems: 1, items: { type: 'object', required: ['group', 'branch', 'commit', 'merge', 'tree'], additionalProperties: false, properties: { group: STR, branch: STR, commit: HEX, merge: HEX, tree: HEX } } },
      checks: { type: 'array', minItems: 1, items: STR },
    },
  },
  'gf.deps.installed': {
    type: 'object', required: ['id', 'command', 'evidence', 'status', 'lockfiles', 'mechanism'], additionalProperties: false,
    properties: { id: STR, command: STR, evidence: STR, status: STR, mechanism: { enum: ['both', 'landlock', 'bwrap'] }, lockfiles: { type: 'array', items: { type: 'object', required: ['path', 'sha256'], additionalProperties: false, properties: { path: STR, sha256: SHA } } } },
  },
};

function isGfType(type) {
  return typeof type === 'string' && type.startsWith('gf.');
}

/** Error strings for a payload ([] when valid). */
function validate(type, data) {
  const schema = TYPES[type];
  if (!schema) return [`unknown event type ${type}`];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return ['the payload is not an object'];
  const out = validateSchema(schema, data).map((e) => `${e.path || '/'} ${e.message}`);
  // the schema counts characters; the limit is in bytes
  if (type === 'gf.message' && typeof data.body === 'string' && Buffer.byteLength(data.body) > C.MAX_MESSAGE_BYTES) out.push(`/body is ${Buffer.byteLength(data.body)} bytes; the limit is ${C.MAX_MESSAGE_BYTES}`);
  return out;
}

/** Validate, then commit through the frozen store (`check` runs inside its lock and may throw). */
function commit(store, type, actor, data, check) {
  const errors = validate(type, data);
  if (errors.length) throw new EccodeError('GF_EVENT_INVALID', `invalid ${type}: ${errors.join('; ')}`, { errors });
  return store.commit(type, actor, data, check);
}

module.exports = { TYPES, isGfType, validate, commit };
