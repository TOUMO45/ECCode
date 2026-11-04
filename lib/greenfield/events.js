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
};

function isGfType(type) {
  return typeof type === 'string' && type.startsWith('gf.');
}

/** Error strings for a payload ([] when valid). */
function validate(type, data) {
  const schema = TYPES[type];
  if (!schema) return [`unknown event type ${type}`];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return ['the payload is not an object'];
  return validateSchema(schema, data).map((e) => `${e.path || '/'} ${e.message}`);
}

/** Validate, then commit through the frozen store (`check` runs inside its lock and may throw). */
function commit(store, type, actor, data, check) {
  const errors = validate(type, data);
  if (errors.length) throw new EccodeError('GF_EVENT_INVALID', `invalid ${type}: ${errors.join('; ')}`, { errors });
  return store.commit(type, actor, data, check);
}

module.exports = { TYPES, isGfType, validate, commit };
