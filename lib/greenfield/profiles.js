'use strict';
// S4-PREREQ D-1: stack profiles beside the v1 one. C.STACK_PROFILES (the v1 list, pinned by tests/gf-events.test.js)
// is not changed; this module adds profiles that carry an engine-owned SCAFFOLD: structure and conventions only, never
// application logic.
//
// Profile `python-fastapi-postgres-worker-compose`: four compose services (api, worker, dashboard, db), one file per
// engine-generated path, every service with a healthcheck, a health endpoint convention, a worker scheduling
// convention, and a default ownership map in the engine's own map format (ownership.js), so the existing
// disjointness and reserved-path rules judge it.
//
// Enforcement (GF-STACK-*), run by `eccode-gf stack check` and by the audit for projects on this profile:
//   GF-STACK-1  the compose file exists and is valid (`docker compose config`, which needs no daemon; JSON parse
//               when the docker CLI is absent)
//   GF-STACK-2  the profile's services are all present, every service has a healthcheck (and none disables it)
//   GF-STACK-3  the ownership map covers every scaffold path exactly once (the profile's default map always; the
//               sealed breakdown's effective map once G1 is sealed)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./constants');
const ownership = require('./ownership');
const { matchesAny } = require('../util');

const COMPOSE_FILE = 'compose.yaml';
const NAME = 'python-fastapi-postgres-worker-compose';

const pyHttpCheck = (port) => ['CMD', 'python', '-c', `import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:${port}/healthz', timeout=3).status == 200 else 1)`];
const HEARTBEAT_CHECK = ['CMD', 'python', '-c', "import os, sys, time; p = os.environ['WORKER_HEARTBEAT_FILE']; n = int(os.environ['WORKER_INTERVAL_SECONDS']); sys.exit(0 if os.path.exists(p) and time.time() - os.path.getmtime(p) < 3 * n else 1)"];
const HC = (test, start = '20s') => ({ test, interval: '10s', timeout: '5s', retries: 6, start_period: start });
const DB_URL = 'postgresql+psycopg://app:${POSTGRES_PASSWORD}@db:5432/app';

const dockerfile = ({ svc, port, cmd }) => [
  `# Engine-owned scaffold (${NAME}): build glue for the ${svc} service, no application logic.`,
  '# Convention: the service declares its Python dependencies in services/' + svc + '/requirements.txt.',
  'FROM python:3.12-slim',
  'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1',
  'WORKDIR /srv',
  `COPY services/${svc}/requirements.txt ./requirements.txt`,
  'RUN pip install --no-cache-dir -r requirements.txt',
  `COPY services/${svc}/ ./`,
  'USER 10001',
  ...(port ? [`EXPOSE ${port}`] : []),
  `CMD ${JSON.stringify(cmd)}`,
  '',
].join('\n');

const PROFILE_DOC = `# Stack profile: ${NAME}

Engine-owned scaffold. The engine writes the files below and checks them (\`eccode-gf stack check\`, and the audit). It
writes no application logic: every service's code is the project's.

| Path | Owner group | What it is |
|---|---|---|
| \`compose.yaml\` | delivery | the four services (JSON syntax, which is valid YAML) |
| \`.env.example\` | delivery | the variables compose needs; copy to \`.env\` |
| \`.dockerignore\` | delivery | keeps \`.eccode/\`, \`.git/\` and \`.env\` out of the build context |
| \`deploy/*.Dockerfile\`, \`deploy/PROFILE.md\` | delivery | build glue and this file |
| \`services/api/**\`, \`services/worker/**\` | backend | the HTTP API and the background worker |
| \`services/dashboard/**\` | frontend | the dashboard |
| \`migrations/**\` | db | schema migrations |
| \`contracts/**\`, \`mocks/**\` | api | sealed G1 contracts (reserved) |
| \`tests/**\` | test | tests (\`tests/acceptance/**\` reserved) |

## Conventions
- **Health.** \`api\` (port 8000) and \`dashboard\` (port 8080) answer \`GET /healthz\` with HTTP 200 and no authentication,
  and only once they can serve requests (the database reachable for \`api\`). \`db\` is healthy when \`pg_isready\` is.
- **Entry points.** \`api\`: ASGI app \`app.main:app\` in \`services/api/\`. \`dashboard\`: ASGI app \`app.main:app\` in
  \`services/dashboard/\`; it reads data only through the API at \`API_URL\`. \`worker\`: \`python -m worker\` in
  \`services/worker/\`.
- **Worker scheduling.** The worker runs one tick every \`WORKER_INTERVAL_SECONDS\` (default 60). A tick is idempotent:
  running it twice on the same input changes nothing the second time. After each successful tick it touches
  \`WORKER_HEARTBEAT_FILE\`; the healthcheck fails when the heartbeat is older than 3 intervals.
- **Database.** PostgreSQL 16 at \`DATABASE_URL\`; schema changes only through \`migrations/\`.
- **Secrets.** \`POSTGRES_PASSWORD\` has no default: compose refuses to start without it.
`;

/** The extra profiles (beyond C.STACK_PROFILES). */
const PROFILES = {
  [NAME]: {
    name: NAME,
    composeFile: COMPOSE_FILE,
    services: {
      api: { group: 'backend', root: 'services/api', port: 8000, health: { method: 'GET', path: '/healthz', expect: 200 }, entry: 'uvicorn app.main:app' },
      worker: { group: 'backend', root: 'services/worker', port: null, health: { heartbeatEnv: 'WORKER_HEARTBEAT_FILE', staleAfterIntervals: 3 }, entry: 'python -m worker' },
      dashboard: { group: 'frontend', root: 'services/dashboard', port: 8080, health: { method: 'GET', path: '/healthz', expect: 200 }, entry: 'uvicorn app.main:app' },
      db: { group: 'db', root: null, port: 5432, health: { command: 'pg_isready' }, image: 'postgres:16-alpine' },
    },
    worker: { entry: 'python -m worker', intervalEnv: 'WORKER_INTERVAL_SECONDS', defaultIntervalSeconds: 60, heartbeatEnv: 'WORKER_HEARTBEAT_FILE', staleAfterIntervals: 3, idempotentTicks: true },
    ownership: {
      groups: {
        api: { roles: C.GROUPS.api, globs: ['contracts/**', 'mocks/**'], denyGlobs: [] },
        backend: { roles: C.GROUPS.backend, globs: ['services/api/**', 'services/worker/**'], denyGlobs: [] },
        frontend: { roles: C.GROUPS.frontend, globs: ['services/dashboard/**'], denyGlobs: [] },
        db: { roles: C.GROUPS.db, globs: ['migrations/**'], denyGlobs: [] },
        test: { roles: C.GROUPS.test, globs: ['tests/**'], denyGlobs: [] },
        delivery: { roles: C.GROUPS.delivery, globs: [COMPOSE_FILE, '.env.example', '.dockerignore', 'deploy/**'], denyGlobs: [] },
      },
    },
  },
};

const names = () => Object.keys(PROFILES);
/** Every profile initProject accepts: the v1 list, then the scaffolded ones. */
const supported = () => [...C.STACK_PROFILES, ...names()];
const get = (name) => PROFILES[name] || null;

/** The compose document of a profile (an object; written as JSON, which is valid YAML). */
function composeOf(name) {
  if (name !== NAME) return null;
  const build = (svc) => ({ context: '.', dockerfile: `deploy/${svc}.Dockerfile` });
  return {
    name: 'app',
    'x-eccode-profile': NAME,
    services: {
      db: {
        image: 'postgres:16-alpine',
        environment: { POSTGRES_USER: 'app', POSTGRES_DB: 'app', POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set (see .env.example)}' },
        volumes: ['db-data:/var/lib/postgresql/data'],
        healthcheck: HC(['CMD-SHELL', 'pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"'], '10s'),
        restart: 'unless-stopped',
      },
      api: {
        build: build('api'),
        environment: { DATABASE_URL: DB_URL },
        ports: ['${API_PORT:-8000}:8000'],
        depends_on: { db: { condition: 'service_healthy' } },
        healthcheck: HC(pyHttpCheck(8000)),
        restart: 'unless-stopped',
      },
      worker: {
        build: build('worker'),
        environment: { DATABASE_URL: DB_URL, WORKER_INTERVAL_SECONDS: '${WORKER_INTERVAL_SECONDS:-60}', WORKER_HEARTBEAT_FILE: '/tmp/worker.heartbeat' },
        depends_on: { db: { condition: 'service_healthy' } },
        healthcheck: HC(HEARTBEAT_CHECK, '30s'),
        restart: 'unless-stopped',
      },
      dashboard: {
        build: build('dashboard'),
        environment: { API_URL: 'http://api:8000' },
        ports: ['${DASHBOARD_PORT:-8080}:8080'],
        depends_on: { api: { condition: 'service_healthy' } },
        healthcheck: HC(pyHttpCheck(8080)),
        restart: 'unless-stopped',
      },
    },
    volumes: { 'db-data': {} },
  };
}

/** Every engine-generated path of a profile and its bytes: { rel: text }. */
function scaffoldFiles(name) {
  if (name !== NAME) return {};
  return {
    [COMPOSE_FILE]: `${JSON.stringify(composeOf(name), null, 2)}\n`,
    '.env.example': '# Copy to .env and set real values. Never commit .env.\nPOSTGRES_PASSWORD=\nAPI_PORT=8000\nDASHBOARD_PORT=8080\nWORKER_INTERVAL_SECONDS=60\n',
    '.dockerignore': '.git\n.eccode\n.env\n**/__pycache__\n**/*.pyc\n',
    'deploy/api.Dockerfile': dockerfile({ svc: 'api', port: 8000, cmd: ['uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '8000'] }),
    'deploy/worker.Dockerfile': dockerfile({ svc: 'worker', port: null, cmd: ['python', '-m', 'worker'] }),
    'deploy/dashboard.Dockerfile': dockerfile({ svc: 'dashboard', port: 8080, cmd: ['uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '8080'] }),
    'deploy/PROFILE.md': PROFILE_DOC,
  };
}

/** Write the scaffold into `root`. Refused (nothing written) when any of its paths exists already. */
function writeScaffold(root, name) {
  const files = scaffoldFiles(name);
  const clash = Object.keys(files).filter((rel) => fs.existsSync(path.join(root, rel)));
  if (clash.length) return { written: [], problems: [{ rule: 'GF-STACK-0', message: `the scaffold of ${name} would overwrite ${clash.join(', ')}; a greenfield project starts without them` }] };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { written: Object.keys(files), problems: [] };
}

/** Owners of `rel` in a map ({ groups: { name: { globs, denyGlobs } } }). */
function ownersOf(map, rel) {
  return Object.entries(map.groups).filter(([, g]) => matchesAny(rel, g.globs || []) && !matchesAny(rel, g.denyGlobs || [])).map(([n]) => n);
}

/** GF-STACK-3: every scaffold path has exactly one owner in `map`. */
function coverageProblems(name, map, label = 'the ownership map') {
  const out = [];
  for (const rel of Object.keys(scaffoldFiles(name))) {
    const owners = ownersOf(map, rel);
    if (owners.length === 0) out.push({ rule: 'GF-STACK-3', message: `${rel} is owned by no group in ${label}` });
    else if (owners.length > 1) out.push({ rule: 'GF-STACK-3', message: `${rel} is owned by ${owners.length} groups in ${label} (${owners.join(', ')})` });
  }
  return out;
}

/** Parse the compose file: { doc } or { problem }. Uses `docker compose config` (no daemon) when the CLI exists. */
function readCompose(root, file = COMPOSE_FILE, { docker = 'docker' } = {}) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) return { problem: `${file} is missing` };
  const r = spawnSync(docker, ['compose', '-f', abs, '--project-directory', root, 'config', '--no-interpolate', '--format', 'json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, DOCKER_HOST: 'unix:///nonexistent/eccode-no-daemon.sock' } });
  if (r.error && r.error.code === 'ENOENT') {
    try { return { doc: JSON.parse(fs.readFileSync(abs, 'utf8')), validator: 'json-parse (docker CLI absent)' }; } catch (e) { return { problem: `${file} could not be validated: the docker CLI is absent and it is not JSON (${e.message})` }; }
  }
  if (r.status !== 0) return { problem: `${file} is not a valid compose file: ${String(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}` };
  try { return { doc: JSON.parse(r.stdout), validator: 'docker compose config' }; } catch (e) { return { problem: `docker compose config printed no JSON: ${e.message}` }; }
}

/** GF-STACK-1..2 on a parsed compose document. */
function composeProblems(name, doc) {
  const out = [];
  const p = get(name);
  const services = (doc && doc.services) || {};
  for (const svc of Object.keys(p.services)) if (!services[svc]) out.push({ rule: 'GF-STACK-2', message: `the compose file has no ${svc} service (the profile declares api, worker, dashboard and db)` });
  for (const [svc, s] of Object.entries(services)) {
    const hc = s && s.healthcheck;
    if (!hc || !hc.test || (Array.isArray(hc.test) && hc.test.length === 0)) out.push({ rule: 'GF-STACK-2', message: `service ${svc} has no healthcheck: every service declares one` });
    else if (hc.disable === true || (Array.isArray(hc.test) && hc.test[0] === 'NONE')) out.push({ rule: 'GF-STACK-2', message: `service ${svc} disables its healthcheck` });
  }
  return out;
}

/** Every GF-STACK problem of the project at `root` on profile `name`. `map`: the effective breakdown map, when sealed. */
function check(root, name, { map = null, docker } = {}) {
  const p = get(name);
  if (!p) return [];
  const out = [];
  const m = ownership.mapProblems(p.ownership);
  for (const x of m) out.push({ rule: 'GF-STACK-3', message: `the profile's own ownership map: ${x}` });
  out.push(...coverageProblems(name, p.ownership, "the profile's default ownership map"));
  if (map) out.push(...coverageProblems(name, map, 'the sealed breakdown (after amendments)'));
  const c = readCompose(root, p.composeFile, { docker });
  if (c.problem) out.push({ rule: 'GF-STACK-1', message: c.problem });
  else out.push(...composeProblems(name, c.doc));
  return out;
}

module.exports = { NAME, COMPOSE_FILE, PROFILES, names, supported, get, composeOf, scaffoldFiles, writeScaffold, ownersOf, coverageProblems, readCompose, composeProblems, check };
