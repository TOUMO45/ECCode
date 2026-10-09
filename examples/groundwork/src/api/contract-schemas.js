// Single source of request/response shapes (spec section 3).
// Routes validate requests with `requests.*`; contract tests validate
// responses with `responses.*` and `errorResponse`. Uses src/lib/schema.js.
import { checkSchema } from '../lib/schema.js';

const S = (extra = {}) => ({ type: 'string', ...extra });
const I = (extra = {}) => ({ type: 'integer', ...extra });
const NI = { type: ['integer', 'null'] };
const NS = { type: ['string', 'null'] };
const B = { type: 'boolean' };
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });

export const ROLES = ['viewer', 'responder', 'lead'];
export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];
export const SECTIONS = ['summary', 'impact', 'timeline', 'contributingFactors', 'actionItems'];
export const PROVIDER_CHOICES = ['auto', 'anthropic', 'cli', 'fallback', 'fake', 'fake-clean'];

export const LIMITS = Object.freeze({
  bodyBytes: 1048576,
  noteLines: 2000,
  noteText: 2000,
  noteAuthor: 64,
  statementText: 600,
  maxCites: 20,
  maxInt: 2147483647,
  errorDetailItems: 20,
});

/** code -> { status, message } ; messages are fixed strings (never derived from input). */
export const ERRORS = Object.freeze({
  INVALID_JSON: { status: 400, message: 'Request body is not valid JSON' },
  VALIDATION_FAILED: { status: 400, message: 'Request validation failed' },
  NOTES_INVALID: { status: 400, message: 'Some note lines could not be parsed' },
  UNAUTHENTICATED: { status: 401, message: 'Authentication required' },
  INVALID_CREDENTIALS: { status: 401, message: 'Invalid username or password' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to do that' },
  CSRF_FAILED: { status: 403, message: 'CSRF validation failed' },
  NOT_FOUND: { status: 404, message: 'Not found' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Method not allowed' },
  STALE_VERSION: { status: 409, message: 'The draft was changed by someone else; reload and retry' },
  NOTES_LOCKED: { status: 409, message: 'Notes cannot be replaced after a draft exists' },
  DRAFT_PUBLISHED: { status: 409, message: 'The draft is already published' },
  UNGROUNDED_STATEMENTS: { status: 409, message: 'Some statements are not grounded in the cited notes' },
  NO_NOTES: { status: 409, message: 'The incident has no notes' },
  NOTES_CHANGED: { status: 409, message: 'Notes changed while the draft was being generated' },
  GENERATION_IN_PROGRESS: { status: 409, message: 'A draft is already being generated for this incident' },
  USERNAME_TAKEN: { status: 409, message: 'That username is already taken' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Request body is too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Content-Type must be application/json' },
  RATE_LIMITED: { status: 429, message: 'Too many attempts; try again later' },
  INTERNAL: { status: 500, message: 'Something went wrong' },
  PROVIDER_BAD_OUTPUT: { status: 502, message: 'The provider returned an unusable draft' },
  PROVIDER_UNAVAILABLE: { status: 502, message: 'The provider is unavailable' },
  PROVIDER_BUSY: { status: 503, message: 'The provider is busy; try again shortly' },
  PROVIDER_TIMEOUT: { status: 504, message: 'The provider timed out' },
});

// ---- shared shapes -------------------------------------------------------

const idInt = I({ minimum: 1, maximum: LIMITS.maxInt });
const isoString = S({ minLength: 10, maxLength: 40, pattern: '^\\d{4}-\\d{2}-\\d{2}' });
const username = S({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' });

export const shapes = {
  errorEnvelope: obj(
    {
      error: obj(
        {
          code: S({ enum: Object.keys(ERRORS) }),
          message: S({ minLength: 1 }),
          requestId: S({ minLength: 8, maxLength: 64 }),
          details: { type: 'object' },
        },
        ['code', 'message', 'requestId'],
      ),
    },
  ),
  user: obj({
    id: I(), username: S(), displayName: S(), role: S({ enum: ROLES }), teamId: I(), teamName: S(),
  }),
  noteLine: obj({ n: I({ minimum: 1 }), time: S({ pattern: '^\\d{2}:\\d{2}$' }), ts: NS, author: S(), text: S() }),
  reason: obj({ code: S(), detail: S() }),
  statement: obj({
    id: I(),
    text: S({ minLength: 1, maxLength: LIMITS.statementText }),
    cites: arr(I({ minimum: 1 })),
    status: S({ enum: ['verified', 'flagged'] }),
    reasons: arr(obj({ code: S(), detail: S() })),
    edited: B,
  }),
  auditEntry: obj({
    id: I(), at: S(), actor: NS, action: S(), targetType: NS, targetId: NI,
    outcome: S({ enum: ['ok', 'denied', 'fail'] }), detail: { type: 'object' },
  }),
};

shapes.draft = obj({
  id: I(), incidentId: I(), version: I({ minimum: 1 }),
  state: S({ enum: ['draft', 'published'] }),
  provider: S(), model: NS, isFallback: B,
  generatedAt: S(), publishedAt: NS, publishedBy: NI,
  flaggedCount: I({ minimum: 0 }),
  sections: obj(Object.fromEntries(SECTIONS.map((s) => [s, arr(shapes.statement)]))),
});

shapes.incident = obj({
  id: I(), title: S(), severity: S({ enum: SEVERITIES }), startedAt: S(), description: S(),
  createdBy: obj({ id: I(), displayName: S() }),
  createdAt: S(), noteCount: I({ minimum: 0 }),
  draft: {
    type: ['object', 'null'],
    additionalProperties: false,
    required: ['id', 'state', 'version', 'provider', 'isFallback', 'flaggedCount'],
    properties: {
      id: I(), state: S({ enum: ['draft', 'published'] }), version: I(), provider: S(),
      isFallback: B, flaggedCount: I(),
    },
  },
});

const providerInfo = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'available', 'isFallback', 'sendsNotesOffHost'],
  properties: {
    id: S(), label: S(), available: B, isFallback: B, sendsNotesOffHost: B, version: S(),
  },
};

// ---- requests ------------------------------------------------------------

const noteJsonLine = obj({
  time: S({ minLength: 1, maxLength: 40 }),
  author: S({ minLength: 1, maxLength: LIMITS.noteAuthor }),
  text: S({ minLength: 1, maxLength: LIMITS.noteText }),
});

export const requests = {
  login: obj({
    username,
    password: S({ minLength: 1, maxLength: 128 }),
  }),
  logout: obj({}),
  createUser: obj({
    username,
    displayName: S({ minLength: 1, maxLength: 80 }),
    password: S({ minLength: 10, maxLength: 128 }),
    role: S({ enum: ROLES }),
  }),
  auditQuery: obj({ limit: I({ minimum: 1, maximum: 200 }), before: I({ minimum: 1, maximum: LIMITS.maxInt }) }, []),
  createIncident: obj({
    title: S({ minLength: 1, maxLength: 140 }),
    severity: S({ enum: SEVERITIES }),
    startedAt: isoString,
    description: S({ maxLength: 4000 }),
  }, ['title', 'severity', 'startedAt']),
  // Two-variant body; use validateNotesBody() so each variant gets exact errors.
  notesText: obj({ format: S({ enum: ['text'] }), content: S({ minLength: 1, maxLength: 4 * 1024 * 1024 }) }),
  notesJson: obj({
    format: S({ enum: ['json'] }),
    content: arr(noteJsonLine, { minItems: 1, maxItems: LIMITS.noteLines }),
  }),
  generateDraft: obj({ provider: S({ enum: PROVIDER_CHOICES }) }, []),
  editStatement: obj({
    expectedVersion: I({ minimum: 1, maximum: LIMITS.maxInt }),
    text: S({ minLength: 1, maxLength: LIMITS.statementText }),
    cites: arr(I({ minimum: 1, maximum: LIMITS.maxInt }), { maxItems: LIMITS.maxCites }),
  }, ['expectedVersion']),
  deleteStatementQuery: obj({ expectedVersion: I({ minimum: 1, maximum: LIMITS.maxInt }) }),
  publish: obj({ expectedVersion: I({ minimum: 1, maximum: LIMITS.maxInt }) }),
};

/** Select the notes schema by `format` (unknown/missing format -> the text schema errors on format). */
export function notesSchemaFor(body) {
  return body && typeof body === 'object' && body.format === 'json' ? requests.notesJson : requests.notesText;
}

// ---- responses (success bodies) -----------------------------------------

const usage = obj({
  provider: S(), model: NS, inputTokens: { type: ['integer', 'null'] }, outputTokens: { type: ['integer', 'null'] },
  costUsd: { type: ['number', 'null'] }, durationMs: I({ minimum: 0 }), attempts: I({ minimum: 1 }),
});

export const responses = {
  csrf: obj({ csrfToken: S({ minLength: 1 }) }),
  login: obj({ user: shapes.user, csrfToken: S({ minLength: 1 }) }),
  me: obj({ user: shapes.user, csrfToken: S({ minLength: 1 }) }),
  logout: obj({ ok: { type: 'boolean', enum: [true] } }),
  createUser: obj({ user: shapes.user }),
  listUsers: obj({ users: arr(shapes.user) }),
  audit: obj({ entries: arr(shapes.auditEntry), nextBefore: NI }),
  providers: obj({ providers: arr(providerInfo), default: NS }),
  createIncident: obj({ incident: shapes.incident }),
  listIncidents: obj({ incidents: arr(shapes.incident, { maxItems: 200 }) }),
  getIncident: obj({ incident: shapes.incident }),
  putNotes: obj({ count: I({ minimum: 1 }), lines: arr(shapes.noteLine) }),
  getNotes: obj({ lines: arr(shapes.noteLine) }),
  generateDraft: obj({ draft: shapes.draft, usage }),
  getDraft: obj({ draft: shapes.draft }),
  editStatement: obj({ draft: shapes.draft }),
  deleteStatement: obj({ draft: shapes.draft }),
  publish: obj({ draft: shapes.draft }),
  listPostmortems: obj({
    postmortems: arr(obj({
      draftId: I(), incidentId: I(), title: S(), severity: S({ enum: SEVERITIES }),
      startedAt: S(), publishedAt: S(), publishedBy: obj({ displayName: S() }), isFallback: B,
    })),
  }),
  getPostmortem: obj({
    postmortem: obj({
      incident: obj({ id: I(), title: S(), severity: S({ enum: SEVERITIES }), startedAt: S(), description: S() }),
      draft: shapes.draft,
      lines: arr(shapes.noteLine),
    }),
  }),
  health: obj({ status: S({ enum: ['ok'] }), version: S(), schemaVersion: I({ minimum: 1 }) }),
};

/** Error-envelope schema (alias used by contract tests). */
export const errorResponse = shapes.errorEnvelope;

/** Per-code `details` schemas (optional; absent where the spec says "none"). */
const fieldList = (itemProps) => arr(obj(itemProps), { maxItems: LIMITS.errorDetailItems });
export const errorDetails = {
  VALIDATION_FAILED: obj({ fields: fieldList({ path: S(), message: S() }) }),
  NOTES_INVALID: obj({ lines: fieldList({ line: I({ minimum: 1 }), message: S() }), total: I({ minimum: 1 }) }),
  METHOD_NOT_ALLOWED: obj({ allow: arr(S()) }),
  STALE_VERSION: obj({ currentVersion: I() }),
  UNGROUNDED_STATEMENTS: obj({
    statements: arr(obj({ id: I(), section: S({ enum: SECTIONS }), reasons: arr(shapes.reason) })),
  }),
  RATE_LIMITED: obj({ retryAfterSeconds: I({ minimum: 1 }) }),
  PROVIDER_BAD_OUTPUT: obj({ fallbackAvailable: B }),
  PROVIDER_UNAVAILABLE: obj({ provider: S(), fallbackAvailable: B }),
  PROVIDER_BUSY: obj({ fallbackAvailable: B }),
  PROVIDER_TIMEOUT: obj({ provider: S(), fallbackAvailable: B }),
};

// Fail at import time if any schema uses an unsupported keyword.
for (const group of [shapes, requests, responses, errorDetails]) {
  for (const s of Object.values(group)) checkSchema(s);
}
