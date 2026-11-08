# S3 handoff: everything a fresh session needs to build S3

**Start S3 in a NEW session** (clean per-slice metering; L-GF-73). This document is self-contained.

## What S3 is
Build one small FastAPI task-tracker through the Greenfield-Senior engine, two groups (backend, test), kernel isolation per S2.4. The full scope, the authorization rule, the hidden acceptance suite, the metrics and the budget are pre-registered in **`bench/protocols/2026-11-08-gf-s3.md`** — read it first and follow it. Do NOT re-decide scope; it is sealed there.

## State at handoff
- Branch: `claude/wonderful-goldberg-o6u7m6`. Base it on the current head (after S2.4.1).
- S1 and S2 are built; S2.4 (kernel isolation) is built and accepted by the owner; S2.3 (the tool allowlist) is suspended and unreviewed (L-GF-78). S3 has NOT started.
- Frozen v3 engine: 48 files, unchanged. Verify before and after with `ECCODE_FREEZE_FILE=bench/pilot/phase2-freeze-v3.json node bench/pilot/phase2-seeds.js check` (must print "frozen: 48 files").
- Protected files never edited by this line of work: `docs/limits.md`, `scripts/guards/*.py`, `lib/project.js`. Confirm with `git diff --stat c59ee39..HEAD -- docs/limits.md scripts/guards lib/project.js` (must be empty).

## Commands
- Start a Greenfield-Senior project: `node bin/eccode-gf.js init --name <n> --idea "<idea>"`.
- The G1 pipeline (gates): `gate start|submit|review architecture|design|plan` then `seal`. See `bin/eccode-gf.js --help` and design sections 3-4.
- A group role's command: `node bin/eccode-gf.js run --actor <role> --label <l> --command "<pinned form>" --task <id>` (GF-ISO-1, runs in the kernel sandbox).
- Commit a group's work: `node bin/eccode-gf.js commit --actor <role> --task <id>` (GF-ISO-2).
- Merge groups: `node bin/eccode-gf.js merge --actor orchestrator --scope <s> --checks ev:<id>,...` (GF-ISO-3).
- Dependency install (network, orchestrator only): `node bin/eccode-gf.js deps install --actor orchestrator --command "<pinned install form>"`.
- Isolation self-test: `node bin/eccode-gf.js isolation check` (must report group mode available).
- Close a slice: `close dispatch|review|resolve|battery|slice` (GF-CLOSE-1..6).
- Tests: `node --test tests/*.test.js` (full), `node --test tests/gf-*.test.js` (greenfield). Use `--test-concurrency=4` to avoid a `standards.extract` parallelism flake.

## The FastAPI venv (for running the stack's own checks)
- A venv with FastAPI 0.162.1, Starlette 1.10.0, Pydantic 2.14.3, SQLAlchemy 2.1.8, Alembic 1.20.1, httpx 0.28.1, uvicorn, pytest, hypothesis is needed to run the FastAPI-dependent tests and the built project. Build it with `--only-binary=:all:` (no sdist builds, so no package code runs during install) at `/root/.cache/eccode/phase3-venv`; point the engine at it with `ECCODE_PYTHON` and `ECCODE_GF_PYTHON`. The engine-mediated install (`deps install`) is the sanctioned route; see `docs/build/gf-s2-4-evidence.md` section on A3 for the hashed-requirements evidence and the supply-chain limit.

## Limits to respect (docs/limits-greenfield.md)
- L-GF-2: FastAPI/SQLAlchemy/SQLite only.
- L-GF-7: hidden-suite read-denial depends on the harness running hooks on Read.
- L-GF-73: per-slice metering needs a fresh session; take a usage snapshot with `lib/greenfield/usage.js` as the FIRST action and after every numbered step.
- L-GF-76, 79, 80: the S2.4 isolation residuals (ptrace mitigated by the pid namespace; UDP open under Landlock-alone; the private-tmp base is same-uid readable).
- L-GF-78: S2.3 is suspended and unreviewed.

## Budget rule (enforced after every step)
- Snapshot with `lib/greenfield/usage.js` as the FIRST action; again after each numbered step. Record per-message input, cache-read, cache-write, output; report all-processed tokens and a dated dollar estimate.
- Cap = the S3 estimate + 25% (estimate 70-130 M; register the exact cap before the first build step). Pause at 80%, hard stop at 100%, checked after EVERY step. If a snapshot cannot be taken, say so and stop.

## Evidence paths
- Design: `docs/design/greenfield-senior.md` (sections 3-4 the pipeline, 18 S2 as built, 21 kernel isolation, 22 cost governor).
- S2.4 build and review: `docs/build/gf-s2-4-evidence.md`, `docs/build/gf-s2-4-record/`.
- This protocol: `bench/protocols/2026-11-08-gf-s3.md`.
- Usage snapshots: `docs/build/gf-s2-4-record/s241-usage-*.json`, and S3 writes its own under `docs/build/`.

## Do first in the S3 session
1. Usage snapshot (start).
2. Read `bench/protocols/2026-11-08-gf-s3.md` in full.
3. Confirm frozen 48/48 and the protected files untouched.
4. Spawn the SEPARATE agent to write the hidden suite from the PRD (B2) before the build groups start.
5. Register the exact budget cap from the chosen estimate point.
