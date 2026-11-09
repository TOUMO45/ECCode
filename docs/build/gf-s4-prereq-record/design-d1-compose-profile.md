# D-1 design: stack profile `python-fastapi-postgres-worker-compose`

Module `lib/greenfield/profiles.js`; wired into `initProject` (selection + scaffold), the `gf.project.initialized`
schema (enum), the GF audit (section "stack profile"), and `eccode-gf stack check`.

## Why beside `C.STACK_PROFILES`, not inside it
`tests/gf-events.test.js:71` pins `C.STACK_PROFILES` to the one v1 profile, and existing tests may not be edited (R10).
The new profile lives in `profiles.PROFILES`; `profiles.supported()` = v1 list + scaffolded profiles. The v1 default
path is unchanged: same config keys, no scaffold, same event payload.

## What the profile declares
| Item | Declaration |
|---|---|
| Service layout | `api` (FastAPI, port 8000), `worker` (no port), `dashboard` (port 8080), `db` (postgres:16-alpine) |
| Compose generation | `compose.yaml` (JSON syntax, valid YAML; `x-eccode-profile` marks it), build context `.`, `deploy/<svc>.Dockerfile`, `depends_on` with `service_healthy`, named volume for the DB, `POSTGRES_PASSWORD` required with no default |
| Health convention | `api`/`dashboard`: `GET /healthz` → 200, unauthenticated, only when able to serve; `db`: `pg_isready`; `worker`: heartbeat file younger than 3 intervals |
| Worker scheduling | `python -m worker`; one idempotent tick every `WORKER_INTERVAL_SECONDS` (default 60); touch `WORKER_HEARTBEAT_FILE` after each successful tick |
| Ownership per service | backend: `services/api/**`, `services/worker/**`; frontend: `services/dashboard/**`; db: `migrations/**`; test: `tests/**`; api: `contracts/**`, `mocks/**` (reserved); delivery: `compose.yaml`, `.env.example`, `.dockerignore`, `deploy/**` |

## Engine-owned scaffold (structure only)
`compose.yaml`, `.env.example`, `.dockerignore`, `deploy/{api,worker,dashboard}.Dockerfile`, `deploy/PROFILE.md`.
No file under `services/`, `migrations/` or `tests/`: the engine writes no application logic. The scaffold is written
before the project record exists; if any path already exists, init refuses (GF-STACK-0) and creates nothing.

## Enforced checks
| Rule | Check | Where |
|---|---|---|
| GF-STACK-0 | the scaffold never overwrites a file | init |
| GF-STACK-1 | compose file present and valid: `docker compose config --no-interpolate --format json` (no daemon; `DOCKER_HOST` forced to a dead socket); JSON parse only when the docker CLI is absent | `stack check`, audit |
| GF-STACK-2 | the four profile services present; every service (including any the project adds) has a healthcheck that is not disabled | `stack check`, audit |
| GF-STACK-3 | the profile's default map passes the engine's own `mapProblems` (disjoint, reserved paths) and owns every scaffold path exactly once; after the seal, the breakdown's effective map must also own every scaffold path exactly once | `stack check`, audit |

Because the audit runs these, the D-2 approver (which requires a clean audit) never auto-approves a slice of a
compose-profile project whose compose structure is broken.

## Not covered (stated limits)
- No daemon-dependent check runs in the engine: build, `up`, live health, worker ticks, restart persistence. Those are
  `tools/deploy-check.sh` (operator-run, D-6).
- The breakdown stage validator (G1 plan gate) does not yet require the scaffold coverage at submit time; it is found
  by the audit after the seal.
- Base images are pinned by tag (`python:3.12-slim`, `postgres:16-alpine`), not by digest.
- The runtime guard (`gf.runtime.enforce`, opt-in, unchanged) was built for the v1 FastAPI app layout; whether it mounts
  in `services/api/` is untested.
