'use strict';
// The "Tasks API" project as a complete, mutually consistent G1 bundle: a PRD with ten machine-checkable
// criteria, an architecture with three technology choices, an OpenAPI contract of nine operations, the database
// schema and migration plan, the access matrix, test fixtures, a threat model, a work breakdown (skeleton slice
// S0, auth slice S1, tasks slice S2), the skeleton's plan.json and the pre-registered estimates.
// It is the positive case for every rule and the base that tests/fixtures/gf/mutations.js breaks one rule at a
// time. It is also the seed project for the S4 end-to-end run.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requestFields, operations } = require('../../../lib/greenfield/openapi');
const { GROUPS } = require('../../../lib/greenfield/constants');
const { task, ARCH_MD, DESIGN_MD } = require('../../helpers');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const ser = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const json = (schema) => ({ content: { 'application/json': { schema } } });
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });

function operation(operationId, { params = [], body, success = [200, { type: 'object' }], errors = [401], pub = false } = {}) {
  const responses = {};
  const [code, schema] = success;
  responses[code] = code === 204 ? { description: 'No content' } : { description: 'Success', ...json(schema) };
  for (const e of errors) responses[e] = { description: `Error ${e}`, ...json(ref('Error')) };
  return {
    operationId,
    ...(params.length ? { parameters: params } : {}),
    ...(body ? { requestBody: { required: true, ...json(body) } } : {}),
    responses,
    ...(pub ? { 'x-gf-public': true } : {}),
  };
}

function buildOpenApi() {
  const cred = { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } } };
  return {
    openapi: '3.0.3',
    info: { title: 'Tasks API', version: '1.0.0' },
    security: [{ bearer: [] }],
    paths: {
      '/healthz': { get: operation('health', { pub: true, errors: [429], success: [200, { type: 'object', properties: { status: { type: 'string' } } }] }) },
      '/auth/register': { post: operation('register', { pub: true, body: cred, success: [201, ref('User')], errors: [409, 422] }) },
      '/auth/login': { post: operation('login', { pub: true, body: cred, success: [200, ref('Token')], errors: [401, 422] }) },
      '/auth/logout': { post: operation('logout', { success: [204, null], errors: [401] }) },
      '/tasks': {
        get: operation('listTasks', { params: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } }], success: [200, { type: 'array', items: ref('Task') }] }),
        post: operation('createTask', { body: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1 }, tags: { type: 'array', items: { type: 'string' } } } }, success: [201, ref('Task')], errors: [401, 422] }),
      },
      '/tasks/{taskId}': {
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
        get: operation('getTask', { success: [200, ref('Task')], errors: [401, 404] }),
        delete: operation('deleteTask', { success: [204, null], errors: [401, 404] }),
      },
      '/admin/tasks': { get: operation('adminListTasks', { success: [200, { type: 'array', items: ref('Task') }], errors: [401, 403] }) },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: { type: 'object', required: ['detail'], properties: { detail: { type: 'string' } } },
        User: { type: 'object', required: ['id', 'email', 'role'], properties: { id: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' } } },
        Token: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
        Task: { type: 'object', required: ['id', 'title', 'done'], properties: { id: { type: 'string' }, title: { type: 'string' }, done: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } }, ownerId: { type: 'string' } } },
      },
    },
  };
}

/** The policy of the access matrix: who may do what, per operation and ownership. */
function allowed(role, operationId, ownership) {
  if (['health', 'register', 'login'].includes(operationId)) return true;
  if (role === 'anonymous') return false;
  if (operationId === 'adminListTasks') return role === 'admin';
  if (['getTask', 'deleteTask'].includes(operationId)) return ownership === 'own' || role === 'admin';
  return true;
}

function buildAccessMatrix(openapi) {
  const roles = [{ name: 'anonymous', level: 0 }, { name: 'member', level: 1 }, { name: 'admin', level: 2 }];
  const cells = [];
  for (const r of roles) {
    for (const o of operations(openapi)) {
      for (const ownership of o.pathParams.length ? ['own', 'other'] : ['none']) {
        cells.push({ role: r.name, operationId: o.operationId, ownership, expected: allowed(r.name, o.operationId, ownership) ? 'allow' : 'deny' });
      }
    }
  }
  return { roles, cells };
}

function buildPrd() {
  const http = (operationId, as, status, extra = {}) => ({ kind: 'http', operationId, as, ...extra, expect: { status } });
  return {
    problem: 'Small teams track work in chat threads and lose it: nobody can see which tasks exist, who owns them, or whether they are done, and one person\'s tasks are exposed to everyone who can read the thread.',
    users: [
      { id: 'member', description: 'A team member who manages their own tasks', goals: ['create and complete my tasks', 'be sure nobody else can read or delete them'] },
      { id: 'admin', description: 'A team lead who needs to see every task', goals: ['list all tasks across the team'] },
    ],
    scope: [
      { id: 'S-AUTH', statement: 'People register, log in and log out with an email and a password' },
      { id: 'S-TASKS', statement: 'A member creates, lists, reads and deletes their own tasks' },
      { id: 'S-ADMIN', statement: 'An admin lists every task; a member cannot' },
      { id: 'S-OPS', statement: 'The service reports its health and ships with checks that run' },
    ],
    nonGoals: ['teams or sharing of tasks between members', 'email verification or password reset', 'a native mobile client'],
    ambiguityScan: [
      { id: 'Q-1', question: 'What password policy applies?', resolution: 'assumed', assumptionId: 'Q-1' },
      { id: 'Q-2', question: 'Is deleting a task permanent or reversible?', resolution: 'assumed', assumptionId: 'Q-2' },
      { id: 'Q-3', question: 'How is the first admin created?', resolution: 'assumed', assumptionId: 'Q-3' },
    ],
    criteria: [
      { id: 'AC-1', statement: 'A new person registers and then logs in to obtain a token', covers: ['S-AUTH'], priority: 'P0', verify: { kind: 'flow', steps: [{ operationId: 'register', as: 'anonymous', expect: { status: 201 } }, { operationId: 'login', as: 'anonymous', expect: { status: 200 }, save: 'token' }] } },
      { id: 'AC-2', statement: 'A logged-in member can log out', covers: ['S-AUTH'], priority: 'P1', verify: http('logout', 'member', 204) },
      { id: 'AC-3', statement: 'A member creates a task', covers: ['S-TASKS'], priority: 'P0', verify: http('createTask', 'member', 201) },
      { id: 'AC-4', statement: 'A member lists their tasks', covers: ['S-TASKS'], priority: 'P0', verify: http('listTasks', 'member', 200) },
      { id: 'AC-5', statement: 'A member cannot read another member\'s task', covers: ['S-TASKS'], priority: 'P0', verify: http('getTask', 'member', 404, { request: { onObject: 'other' } }) },
      { id: 'AC-6', statement: 'An admin lists every task', covers: ['S-ADMIN'], priority: 'P1', verify: http('adminListTasks', 'admin', 200) },
      { id: 'AC-7', statement: 'A member cannot list every task', covers: ['S-ADMIN'], priority: 'P0', verify: http('adminListTasks', 'member', 403) },
      { id: 'AC-8', statement: 'The service answers its health check', covers: ['S-OPS'], priority: 'P1', verify: http('health', 'anonymous', 200) },
      { id: 'AC-9', statement: 'The unit test suite passes', covers: ['S-OPS'], priority: 'P1', verify: { kind: 'command', run: 'python -m pytest tests/unit -q', expectExit: 0 } },
      { id: 'AC-10', statement: 'A member deletes their own task', covers: ['S-TASKS'], priority: 'P1', verify: http('deleteTask', 'member', 204) },
    ],
  };
}

function buildArchitecture(decisions = ['dd-1', 'dd-2', 'dd-3']) {
  return {
    components: [
      { id: 'web', responsibility: 'a static single-page UI that calls the API', group: 'frontend' },
      { id: 'api', responsibility: 'the FastAPI service that implements the OpenAPI contract', group: 'backend' },
      { id: 'auth', responsibility: 'token issuing, token checks and the role checks of the access matrix', group: 'security' },
      { id: 'db', responsibility: 'the SQLite schema and its migrations', group: 'db' },
      { id: 'contracts', responsibility: 'the sealed OpenAPI, schema, matrix and the generated mock and contract tests', group: 'api' },
    ],
    dataFlow: [
      { from: 'web', to: 'api', via: 'HTTPS JSON as the OpenAPI contract says', data: 'tasks and tokens' },
      { from: 'api', to: 'auth', via: 'in-process call', data: 'the caller\'s role' },
      { from: 'api', to: 'db', via: 'SQLAlchemy sessions', data: 'rows of users, tokens and tasks' },
    ],
    techChoices: [
      { id: 'TC-1', topic: 'web framework', chosen: 'fastapi', alternatives: [{ id: 'flask', whyNot: 'no built-in OpenAPI generation, which the contract checks rely on' }, { id: 'django', whyNot: 'heavier than a small service needs and slower to iterate' }], decision: decisions[0] },
      { id: 'TC-2', topic: 'database', chosen: 'sqlite', alternatives: [{ id: 'postgresql', whyNot: 'a server to run for a service this size' }, { id: 'mysql', whyNot: 'no advantage here and one more server to run' }], decision: decisions[1] },
      { id: 'TC-3', topic: 'token format', chosen: 'opaque-token', alternatives: [{ id: 'jwt', whyNot: 'cannot be revoked at logout without a deny list' }, { id: 'session-cookie', whyNot: 'ties the API to browsers and complicates the mock' }], decision: decisions[2] },
    ],
  };
}

function buildDb() {
  const pk = { name: 'id', type: 'integer', primaryKey: true };
  return {
    dbSchema: {
      tables: [
        { name: 'users', columns: [pk, { name: 'email', type: 'text', unique: true }, { name: 'password_hash', type: 'text' }, { name: 'role', type: 'text' }] },
        { name: 'tokens', columns: [pk, { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id' } }, { name: 'token_hash', type: 'text', unique: true }, { name: 'created_at', type: 'datetime' }] },
        { name: 'tasks', columns: [pk, { name: 'owner_id', type: 'integer', references: { table: 'users', column: 'id' } }, { name: 'title', type: 'text' }, { name: 'done', type: 'boolean' }, { name: 'created_at', type: 'datetime' }], indexes: [{ name: 'ix_tasks_owner', columns: ['owner_id'] }] },
      ],
    },
    migrationsPlan: {
      steps: [
        { id: '0001', order: 1, slice: 'S0', description: 'create users', creates: ['users'], up: 'create table users', down: 'drop table users' },
        { id: '0002', order: 2, slice: 'S1', description: 'create tokens', creates: ['tokens'], up: 'create table tokens', down: 'drop table tokens' },
        { id: '0003', order: 3, slice: 'S2', description: 'create tasks', creates: ['tasks'], up: 'create table tasks with an owner index', down: 'drop table tasks' },
      ],
    },
  };
}

function buildThreat(openapi, matrixText) {
  const ids = operations(openapi).map((o) => o.operationId);
  return {
    assets: [{ id: 'A-1', description: 'each member\'s tasks' }, { id: 'A-2', description: 'credentials and tokens' }],
    trustBoundaries: [
      { id: 'B-1', description: 'the browser to the API over the public internet', crosses: ids },
      { id: 'B-2', description: 'the API to its database', crosses: ids.filter((i) => i !== 'health') },
    ],
    threats: [
      { id: 'T-1', boundary: 'B-1', category: 'spoofing', description: 'someone logs in as another person by guessing credentials', mitigation: { ref: 'contract', id: 'login' } },
      { id: 'T-2', boundary: 'B-1', category: 'information-disclosure', description: 'a member reads another member\'s task by changing the id in the URL', mitigation: { ref: 'criterion', id: 'AC-5' } },
      { id: 'T-3', boundary: 'B-1', category: 'elevation-of-privilege', description: 'a member calls the admin listing', mitigation: { ref: 'criterion', id: 'AC-7' } },
      { id: 'T-4', boundary: 'B-2', category: 'tampering', description: 'user input reaches a query unescaped', mitigation: { ref: 'component', id: 'db' } },
    ],
    inputValidation: ids.flatMap((id) => requestFields(openapi, id).map((field) => ({ operationId: id, field, rules: 'typed and bounded by the OpenAPI schema; anything else is a 422' }))),
    accessMatrixSha256: sha(matrixText),
  };
}

function buildBreakdown() {
  const t = (id, slice, group, files, dependencies, estLines, extra = {}) => ({ id, title: `Task ${id} work`, slice, group, owner: GROUPS[group][0], files, dependencies, estLines, ...extra });
  const tasks = [
    t('s0-contracts', 'S0', 'api', ['contracts/**', 'mocks/**', 'tests/contract/**'], [], 120),
    t('s0-accept', 'S0', 'test', ['tests/acceptance/**'], ['s0-contracts'], 80, { criteria: ['AC-8', 'AC-9'] }),
    t('s0-app', 'S0', 'backend', ['app/main.py', 'app/__init__.py'], ['s0-contracts'], 60, { provides: ['health'] }),
    t('s0-db', 'S0', 'db', ['app/db/**', 'migrations/**'], ['s0-contracts'], 90),
    t('s0-compose', 'S0', 'delivery', ['Dockerfile', 'docker-compose.yml'], ['s0-app'], 50, { owner: 'devops-engineer' }),
    t('s0-web', 'S0', 'frontend', ['web/**'], ['s0-contracts'], 80, { consumes: ['health'] }),
    t('s1-accept', 'S1', 'test', ['tests/acceptance/**'], ['s0-accept'], 100, { criteria: ['AC-1', 'AC-2'] }),
    t('s1-auth-core', 'S1', 'security', ['app/auth/**'], ['s0-app'], 120),
    t('s1-auth-routes', 'S1', 'backend', ['app/routes/auth.py'], ['s1-auth-core', 's0-db'], 110, { provides: ['register', 'login', 'logout'] }),
    t('s1-auth-db', 'S1', 'db', ['app/db/**', 'migrations/**'], ['s0-db'], 70),
    t('s1-web-auth', 'S1', 'frontend', ['web/auth/**'], ['s0-web'], 90, { consumes: ['register', 'login', 'logout'] }),
    t('s2-accept', 'S2', 'test', ['tests/acceptance/**'], ['s1-accept'], 110, { criteria: ['AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7', 'AC-10'] }),
    t('s2-tasks-routes', 'S2', 'backend', ['app/routes/tasks.py'], ['s1-auth-routes'], 130, { provides: ['listTasks', 'createTask', 'getTask', 'deleteTask'] }),
    t('s2-admin-routes', 'S2', 'backend', ['app/routes/admin.py'], ['s2-tasks-routes'], 60, { provides: ['adminListTasks'] }),
    t('s2-tasks-db', 'S2', 'db', ['app/db/**', 'migrations/**'], ['s1-auth-db'], 70),
    t('s2-ownership', 'S2', 'security', ['app/auth/**'], ['s1-auth-core'], 90),
    t('s2-web-tasks', 'S2', 'frontend', ['web/tasks/**'], ['s1-web-auth'], 100, { consumes: ['listTasks', 'createTask', 'getTask', 'deleteTask', 'adminListTasks'] }),
  ];
  const slices = [
    { id: 'S0', goal: 'a walking skeleton: app stub, compose, baseline migration, mock, red tests', criteria: ['AC-8', 'AC-9'], operations: ['health'], tasks: tasks.filter((x) => x.slice === 'S0').map((x) => x.id) },
    { id: 'S1', goal: 'registration, login and logout with tokens', criteria: ['AC-1', 'AC-2'], operations: ['register', 'login', 'logout'], tasks: tasks.filter((x) => x.slice === 'S1').map((x) => x.id) },
    { id: 'S2', goal: 'tasks with ownership and the admin listing', criteria: ['AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7', 'AC-10'], operations: ['listTasks', 'createTask', 'getTask', 'deleteTask', 'adminListTasks'], tasks: tasks.filter((x) => x.slice === 'S2').map((x) => x.id) },
  ];
  const groups = [
    { name: 'api', roles: ['integration-engineer'], globs: ['contracts/**', 'mocks/**', 'tests/contract/**'], denyGlobs: [] },
    { name: 'backend', roles: ['backend-engineer'], globs: ['app/**'], denyGlobs: ['app/db/**', 'app/auth/**'] },
    { name: 'db', roles: ['database-engineer'], globs: ['app/db/**', 'migrations/**', 'seed/**'], denyGlobs: [] },
    { name: 'security', roles: ['security-engineer'], globs: ['app/auth/**'], denyGlobs: [] },
    { name: 'frontend', roles: ['frontend-engineer'], globs: ['web/**'], denyGlobs: [] },
    { name: 'test', roles: ['test-engineer'], globs: ['tests/acceptance/**', 'tests/unit/**'], denyGlobs: [] },
    { name: 'delivery', roles: ['delivery-lead', 'devops-engineer'], globs: ['Dockerfile', 'docker-compose.yml', 'Makefile', 'docs/**', '.github/**'], denyGlobs: [] },
  ];
  return { groups, slices, tasks };
}

function buildPlan(breakdown) {
  const s0 = breakdown.tasks.filter((x) => x.slice === 'S0');
  return {
    phases: [{ id: 'skeleton', name: 'Walking skeleton', goal: 'A running app stub with compose, the baseline migration, the mock, generated contract tests and red acceptance tests', acceptanceCriteria: ['the health endpoint answers', 'the compose file is valid'] }],
    tasks: s0.map((x) => task(x.id, x.owner, x.files, x.dependencies, 'skeleton')),
  };
}

function buildEstimates(breakdown) {
  const groups = {};
  for (const x of breakdown.tasks) groups[x.group] = (groups[x.group] || 0) + 1;
  return {
    label: 'agent-estimate-uncalibrated',
    basis: 'Judgment ranges from the compute-ledger precedent for delegated runs (n=6); predictions, not measurements.',
    groups: Object.fromEntries(Object.entries(groups).map(([g, n]) => [g, { tasks: n, minutes: { low: 20 * n, high: 60 * n }, tokens: { low: 150000 * n, high: 400000 * n } }])),
  };
}

/** The design module's view of the request: recorded questions, assumptions, decisions and ADRs consistent with the sample. */
function buildBase() {
  const alt = (id, options) => ({ id, options: options.map((o) => ({ id: o })) });
  return {
    design: {
      ambiguities: [{ id: 'amb-1', questions: [{ id: 'Q-1', text: 'password policy', blocking: false }, { id: 'Q-2', text: 'delete semantics', blocking: false }, { id: 'Q-3', text: 'first admin', blocking: false }] }],
      clarifications: [],
      assumptions: ['Q-1', 'Q-2', 'Q-3'].map((q) => ({ question: q, reading: 'a reasonable reading', rationale: 'recorded so work continues', by: 'orchestrator' })),
      alternatives: [alt('da-1', ['fastapi', 'flask', 'django']), alt('da-2', ['sqlite', 'postgresql', 'mysql']), alt('da-3', ['opaque-token', 'jwt', 'session-cookie'])],
      decisions: [
        { id: 'dd-1', alternatives: 'da-1', chosen: 'fastapi' },
        { id: 'dd-2', alternatives: 'da-2', chosen: 'sqlite' },
        { id: 'dd-3', alternatives: 'da-3', chosen: 'opaque-token' },
      ],
      adrs: ['dd-1', 'dd-2', 'dd-3'].map((d, i) => ({ id: `adr-${i + 1}`, decision: d, artifact: `.eccode/design/${d}.md` })),
    },
    gates: {},
  };
}

/** The whole bundle. `art.base` is the fake design state; `art.events` is null (the optional events contract). */
function build() {
  const openapi = buildOpenApi();
  const accessMatrix = buildAccessMatrix(openapi);
  const breakdown = buildBreakdown();
  const { dbSchema, migrationsPlan } = buildDb();
  return {
    prd: buildPrd(),
    architecture: buildArchitecture(),
    openapi,
    dbSchema,
    migrationsPlan,
    accessMatrix,
    fixtures: {
      roles: {
        anonymous: {},
        member: { login: { operationId: 'login', body: { email: 'member@example.test', password: 'member-pass-1' } } },
        admin: { login: { operationId: 'login', body: { email: 'admin@example.test', password: 'admin-pass-1' } } },
      },
      ids: { 'getTask.taskId': 'seed-task-1' },
    },
    events: null,
    threat: buildThreat(openapi, ser(accessMatrix)),
    breakdown,
    plan: buildPlan(breakdown),
    estimates: buildEstimates(breakdown),
    base: buildBase(),
  };
}

const CONTRACT_NAMES = { openapi: 'openapi.json', dbSchema: 'db-schema.json', migrationsPlan: 'migrations-plan.json', accessMatrix: 'access-matrix.json', fixtures: 'fixtures.json', events: 'events.json' };

/** Write the bundle under `dir`; returns the artifact paths per gate. Honors the mutation hooks __noRehash, __extraFiles, __symlink. */
function write(dir, art) {
  const put = (rel, text) => { const abs = path.join(dir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); return rel; };
  const out = { architecture: [], design: [], plan: [] };
  out.architecture.push(put('.eccode/artifacts/brief.md', ARCH_MD), put('.eccode/artifacts/prd.json', ser(art.prd)), put('.eccode/artifacts/architecture.json', ser(art.architecture)));
  for (const [key, name] of Object.entries(CONTRACT_NAMES)) {
    if (art[key]) out.design.push(put(`contracts/${name}`, ser(art[key])));
  }
  const threat = clone(art.threat);
  if (!art.__noRehash) threat.accessMatrixSha256 = sha(ser(art.accessMatrix));
  out.design.push(put('.eccode/artifacts/spec.md', DESIGN_MD), put('.eccode/artifacts/threat-model.json', ser(threat)));
  out.plan.push(put('.eccode/artifacts/plan.json', ser(art.plan)), put('.eccode/artifacts/breakdown.json', ser(art.breakdown)), put('.eccode/artifacts/estimates.json', ser(art.estimates)));
  for (const extra of art.__extraFiles || []) out[extra.gate].push(put(extra.path, extra.content));
  if (art.__symlink) {
    const abs = path.join(dir, art.__symlink);
    const target = `${abs}.real`;
    fs.renameSync(abs, target);
    fs.symlinkSync(path.basename(target), abs);
  }
  return out;
}

/** The design state as the real design module would hold it for the sample, with `extraQuestions` and `skipAdr` hooks honored. */
function fakeBase(art) {
  const base = clone(art.base);
  for (const q of art.extraQuestions || []) {
    base.design.ambiguities.push({ id: `amb-${q.id}`, questions: [{ id: q.id, text: q.text, blocking: Boolean(q.blocking) }] });
    if (q.assume) base.design.assumptions.push({ question: q.id, reading: 'a reasonable reading', rationale: 'recorded', by: 'orchestrator' });
  }
  for (const choiceId of art.skipAdr || []) {
    const choice = art.architecture.techChoices.find((c) => c.id === choiceId);
    base.design.adrs = base.design.adrs.filter((a) => a.decision !== (choice && choice.decision));
  }
  return base;
}

/** A fake base whose earlier gates are approved with the submissions the written files give, for stage-level tests. */
function approvedBase(root, art, written, upTo) {
  const base = fakeBase(art);
  const order = ['architecture', 'design', 'plan'];
  for (const g of order.slice(0, order.indexOf(upTo))) {
    base.gates[g] = { status: 'approved', approvedSubmission: `sub-${g}`, submissions: [{ id: `sub-${g}`, artifacts: written[g].map((p) => ({ path: p, sha256: sha(fs.readFileSync(path.join(root, p), 'utf8')) })) }] };
  }
  return base;
}

module.exports = { build, write, fakeBase, approvedBase, ser, sha, clone, buildThreat, buildEstimates, CONTRACT_NAMES };
