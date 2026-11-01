# Phase 3 recon: the engine as it is, before any Phase 3 code

Written 2026-11-01 before any Phase 3 code, from reading the engine (v0.16.0, commit `96ac8f2`), the benchmark harness and the design documents. Every statement names the file it comes from. The Phase 3 brief is mapped onto this code in [phase3-plan.md](phase3-plan.md); section 9 lists every forced deviation.

## 1. Language, layout, entry points

- Node.js, CommonJS, zero runtime dependencies; Python only as a subject (`lib/lab.js:70` `pythonFor`: `ECCODE_PYTHON`, then `.venv`/`venv`, then `python3`). 11,840 lines under `lib/` and `bin/`.
- Entry points: `bin/eccode.js` (CLI, `main` at 351; dispatch order: `init`, `debug` lab subcommands, `quick`/`debug`, `behavior`, `mcp`/`install`/`export`, project-bound groups, memory groups, then the `switch(group)` for status, work, gate, plan, task, evidence, handoff, run, risk, decision, metrics, audit, deliver); `lib/mcp.js` `tools()` (30-185) exposes the same operations per role over newline JSON-RPC, actor locked at startup, and executes only `approvedCommands` (191-203).
- The toolkit a project gets: `lib/install.js` copies bin, lib, schemas, scripts, templates to `.claude/eccode/`, agents to `.claude/agents/`, skills to `.claude/skills/eccode-*`, commands to `.claude/commands/eccode/`, and merges the SessionStart and PreToolUse hooks (`scripts/hooks/session-start.js`, `scripts/hooks/guard.js`). Profiles `sandbox`, `no-shell`, `guard`.
- Agent-facing text: `commands/*.md` (quick, debug, start, review, deliver, …), `agents/*.md` (12 roles), `skills/*/SKILL.md`. `scripts/validate-toolkit.js` checks every config role has an agent file.

## 2. The event log

- `.eccode/events.jsonl`, append-only, hash-chained: `store.commit(type, actor, data, check)` (`lib/store.js:103`) runs `check(state)` under the record lock, merges what `check` returns into the data, writes `{seq, ts, type, actor, data, prevHash, hash}` with `hash = sha256(prevHash + body)`, re-reduces, writes the snapshot. `state.json` is a cache (`store.js:87`, `STATE_VERSION` check).
- `lib/reducer.js` is pure and never rejects; `initialState()` (61-87); per-work state (`work`, gates, plan, tasks, `lab`, `behavior`) is reset on `work.started` (143-147) and archived into `pastWorks[id]` (138). `STATE_VERSION = 5` (35) must be bumped when a state key is added.
- **Adding an event type** (the Phase 2 commit `e5c57e4` is the template): a `store.commit` in a domain module with the role and state checks inside `check`; a reducer case; initial state; artifacts under `.eccode/<area>/<id>.json` with `artifact` and `artifactSha256` in the event; `Store.artifactErrors` (`store.js:156-179`) re-hashes them for `audit`, current scope and every `pastWorks` scope; the guard's `RECORD_FILES` (`scripts/hooks/guard.js:34`) protects the directory; `lib/install.js` `SANDBOX_DENY` (96) should too (it lacks `lab/` and `behavior/` today).
- Event payloads are not schema-validated; `lib/schema.js` validates review, plan, handoff and memory artifacts (`schemas/*.schema.json`, `additionalProperties: false`).
- `audit` (`store.js:126`): chain, hashes, snapshot equals replay, artifact hashes; CLI `audit --against <ref>` adds unreviewed-change detection; it also runs in `delivery.preconditions` and the session-start hook.
- The integrity window (`lib/evidence.js:82-151` `runCommand`): the record files are snapshotted and restored around every executed command, nested `eccode` writes throw (`ECCODE_EVIDENCE`), tracked changes outside the actor's ownership give exit 99 and an `integrity` field, output is redacted, pytest outcomes are captured through `PYTEST_ADDOPTS --junitxml`. Options `purpose`, `externalCwd`/`cwdLabel` (worktrees), `extra` (merged into the event).

## 3. The gate and rule engine

- Gate order per track (`reducer.js:17-27`): greenfield architecture → design → plan → phases → verification; feature design → plan → …; refactor and fix plan → …; quick and debug have an automatic one-task plan (`works.ONE_TASK`, `works.js:27-41`), debug has no verification gate.
- `gates.startGate` (50) and `submit` (115): authors and reviewers come from `config.roles[kind]` (`config.js:29-36`; a new gate kind needs a `roles` entry or `project.rolesFor` throws `UNKNOWN_GATE`, `project.js:69`); the last gate runs `delivery.coverage` and `works.checkTrackRules` (`works.js:137`), which concatenates `lab.trackProblems` and `behavior.trackProblems` and throws `TRACK_RULE` with `details.problems`.
- `checkReview` (201) returns reasons; approvals need evidence refs per criterion, no open blocking findings, and on phase and verification gates the **re-run rule** (254-265): a passing command evidence recorded by the reviewer after the submission, cited in the review. Verification also consults `stack.requiredCheckProblems` and `behavior.reviewProblems` (the reviewer's own fresh diff).
- Tasks (`lib/tasks.js`): `claimOnly` (116) refuses in order `UNKNOWN_TASK`, `GATE_BLOCKED`, `OWNERSHIP`, `INVALID_TRANSITION`, `TRACK_RULE` (refactor baseline), `DEPENDENCY_PENDING`, `RETRY_LIMIT`, `CONCURRENCY_LIMIT`, `OWNERSHIP_CONFLICT`, budget. `complete` (188) collects every problem (handoff schema, passing check after the claim, files inside ownership, lean, compat, bugs, `lab.completionProblems`) into one `INVALID_HANDOFF`. `rescope` (319) is user-only on reviewed plans, orchestrator on one-task tracks, needs a reason ≥ 10 chars, records `task.rescoped` with `from`/`fromCommand`.
- Delivery (`lib/delivery.js:57` `preconditions`): gates approved, tasks done, audit ok, no unreviewed changes, coverage, probe leftovers, `behavior.deliveryProblems`, no open runs; `deliver` (187) writes `.eccode/delivery/final-handoff[-wN].md` and `.json` and commits `delivery.completed`. The report (`buildReport`, 85) has a plug-in point: `lab.reportLines` and `behavior.reportLines` (103-104); the "Limitations and unverified items" section (176-183) is where open questions would surface. **Nothing today records an assumption or an open question as an event**: `remainingIssues` of handoffs are required but never rendered; `lab.escalated` with kind `ask-user` is the only engine-level ask.
- Refusals: `EccodeError(code, message, details)` (`util.js:8`); CLI prints `eccode: [CODE] message` plus `recovery:`; exit 2.
- Budgets: `project.assertBudget` (`project.js:55`) on cost and minutes only, from `run.ended`.
- Decisions today: `runs.recordDecision` (`runs.js:116`) commits `decision.recorded {title, decision, rationale, alternatives, lessons}` from any actor, unvalidated, shown in the report only. This is the seed of Part A, not its enforcement.

## 4. Tracks and what the brief's parts touch

| Part | Where it hooks today |
|---|---|
| A design before code | `tasks.claimOnly` (ownership refusal), `gates.submit` design gate (`config.review.requiredSections`), `delivery.preconditions`, `handoff` rendering; `decision.recorded` exists but is global and unvalidated; the design gate exists on feature and greenfield, not on refactor (`reducer.js:17-24`) |
| B production guards | `compat.detectAll` (`lib/compat.js:123`: removed exports and routes, edited migrations, destructive content in new migrations, regex only, no OpenAPI, no lock analysis, no downgrade check); `tasks.complete` calls `compat.checkCompletion`; `codebase.impact` (`lib/codebase.js:557`) gives dependents and tests, with HTTP-reach edges; `behavior.surfacesOf` (`lib/behavior.js:70-121`) gives routes and imported definitions of a change; `mutate` (`lib/mutate.js`) is a baseline-then-variant timing loop in the live tree; worktrees are built inline in `behavior.worktreeAt` (250), `lab.bisect`, `lab.recordTestsBaseline`, `fixverify.verify` and are not exported |
| C security | `.eccode/behavior.json` roles with headers; `probe_runner.py` `generate_http` builds per-role probes from the OpenAPI schema and `run_http` executes them with the TestClient and the network closed; `stack.checks` has `eccode-secrets`, gitleaks, osv; security-reviewer is a configured reviewer |
| D large changes | `schemas/plan.schema.json` has no size field; `lean.stats` measures lines per task; `docs/architecture.md:66` states "measure lines instead of capping them"; no checkpoint exists; the multi-file run's causes (`bench/pilot-results/2026-10-27-mealie-multifile.md:150-162`): 4 timeouts on one item, 5 stops waiting for a user who never answers (a refused pinned check, a test file no task owned, a generator refused, a stale test database) |
| E standards | `lib/memory/records.js` (layers, fail→pass rule 181-213, promotion, BM25 search); `lessonsFor` (81-91) excludes project-layer records and is shown at work start, quick/debug start and claim, not at onboarding; `codebase.onboardBrief` (788-842) reads no memory; `codebase.hotSpots` (762) is the only git-history mining |
| F routing and cost | `behavior.route` records `behavior.routing` per work item; `metrics` and `costByWork` (`lib/memory/metrics.js`) give cost per work item; tracks are the unit |

## 5. Tools to reuse

| Tool | Module | Reused for |
|---|---|---|
| `evidence.runCommand` | lib/evidence.js | every executed guard and probe (integrity window, redaction, hashes) |
| worktree + overlay pattern | lib/behavior.js:250-287 (not exported; frozen) | a new `lib/worktree.js` with the same code, for perf and API diffs and race probes |
| `surfacesOf` | lib/behavior.js:70 | routes and functions a change reaches, for B.2, B.3, C |
| `impact` | lib/codebase.js:557 | dependents, tests, HTTP reach, routing of guards |
| `compat.routesIn`, `MIGRATION_FILE`, `DESTRUCTIVE_OPS` | lib/compat.js | migration file detection; the destructive-op list for B.1 |
| `probe_runner.py` roles and OpenAPI examples | scripts/behavior/probe_runner.py (frozen) | the model for the access-matrix and IDOR prober (a new script, not an edit) |
| `mutate` timing loop | lib/mutate.js | the shape of the micro-benchmark runner (baseline then variant, per-run evidence windows) |
| `pytestCapture`, `tests.baseline` | lib/evidence.js, lib/lab.js:722 | per-test outcomes for harness-side checks |
| `records.js` layers and `verificationGaps` | lib/memory/records.js | `observed` standards as a new project-memory kind |
| `phase2-analysis.js` | bench/pilot | item-level tests and power for 0.A and Senior Bench |
| `bench.js` variants, `installEcc` | lib/bench.js | the three arms; `report`/`tally` have no ECC section (use `phase2-analysis.js analyze`) |
| fixture builder | tests/fixtures/phase2/build.js | the pattern for the Phase 3 fixture app (materialize, seed, apply) |

## 6. Identity and ownership

- Actors are roles; `user` is never servable over MCP and `ECCODE_ACTOR` may not supply it (`bin/eccode.js` findRoot/actor). Implementers write only inside claimed globs (guard hook `ownershipDenial`, `guard.js:411-429`); other roles only in draft areas.
- The user-only operations today: abandon work, rescope on reviewed plans, reopen escalated gates, reset escalated tasks, `stack adopt`.

## 7. Tests

- `node --test tests/*.test.js` (429 tests at HEAD, 414 pass, 15 skip without `ECCODE_PYTHON`); `npm run check` adds `scripts/validate-toolkit.js`. CI (`.github/workflows/check.yml:57`) installs pytest, coverage, hypothesis, fastapi, httpx into `/tmp/phase2-venv` and sets `ECCODE_REQUIRE_PHASE2=1`.
- Conventions: `tests/helpers.js` (`tmpProject`, `approveThroughPlan`, `expectCode`, `handoffFor`); gate tests call lib functions directly and assert codes; bypass tests (`tests/phase2-bypass.test.js`) forge raw `store.commit` payloads and assert the refusal and `audit().ok === false`; fixture tests skip with the reason when Python is missing.
- Python fixture app: `tests/fixtures/phase2/shop` (FastAPI, sqlite via stdlib, roles by `X-Role` header, `.eccode/behavior.json`); seeds in `seeds.js` (`BUGS`, `CHANGES`), builder `build.js`.

## 8. Toolchain in this container

Node 22.23.4, Claude Code CLI 2.1.316, uv 0.11.32, pnpm 10.28.0, Python 3.11/3.12/3.13 system, Python 3.8.20 (realbugs venvs), the Mealie checkout at `/root/.cache/eccode/mealie-seed` (commit `7533256`, `.venv` with fastapi 0.146.0, sqlalchemy 2.1.5, alembic 1.20.0, no hypothesis), Mealie bench environments for the 19 pool commits, a Phase 3 fixture venv at `/root/.cache/eccode/phase3-venv` (fastapi, httpx, hypothesis, coverage, pytest, sqlalchemy, alembic, pytest-xdist), 4 cores, 15 GB.

## 9. Deviations the code forces on the brief

1. **The H-B freeze covers the engine, not two files.** Amendment 1 froze the require closure of `lib/behavior.js`: 24 files under `lib/` and `bin/eccode.js`, `lib/cli-args.js`, the probe runner and the seed harness. Every Phase 3 part needs edits to `lib/reducer.js`, `lib/gates.js`, `lib/tasks.js`, `lib/delivery.js`, `lib/config.js`, `bin/eccode.js` and more, all frozen. "Frozen H-B files stay untouched" cannot hold on HEAD and still deliver Parts A–F. **Resolution (stated assumption, for the owner to confirm):** the H-B measurement runs from a git worktree of ECCode at a tagged commit (`phase2-hb-freeze`, created by 0.C after the configuration and runner are added to the freeze), where `assertFrozen` verifies every hash; the two detector files (`lib/behavior.js`, `scripts/behavior/probe_runner.py`) stay byte-identical on HEAD throughout Phase 3 as well; the other frozen files change on HEAD only for Phase 3 and never influence the measurement, which never loads HEAD. Register row 157.
2. **`worktreeAt` and `overlay` cannot be exported** from the frozen `lib/behavior.js`; Phase 3 adds `lib/worktree.js` with the same code (duplication, like `lab.js` and `fixverify.js` already do).
3. **Part D's task-size budget reverses a documented decision** (`docs/architecture.md:66`, "measure lines instead of capping"); the brief's waiver path keeps correct-but-large changes possible; the architecture doc is amended to say so.
4. **Hot paths do not exist as a concept**; B.3 uses the change's surfaces (`surfacesOf`: HTTP routes and functions imported elsewhere) and `impact`'s dependents as the hot-path set, and says so.
5. **OpenAPI diffing does not exist**; B.2 reads `app.openapi()` in two worktrees through a new Python helper (the probe runner's pattern), Python/FastAPI only; exported function signatures come from `lean.definedNames` plus an `inspect.signature` helper.
6. **The ECC arm has no comparison section** in `bench report`/`tally`; 0.A and Senior Bench use `phase2-analysis.js analyze`. ECC commits its fix (phase 6), so `measureChange` reads 0 lines for those runs; hidden checks still see the tree; the runner records that.
7. **Part A on refactor:** the refactor track has no design gate; the design decision is enforced at task ownership (`claimOnly`) for feature, refactor and greenfield rather than through a gate on refactor.
8. **Ambiguity stop, headless:** no human answers in a benchmark; the brief allows a recorded reasonable-reading decision marked as an assumption; the engine records it as `request.assumption` and the handoff and final report render it.
9. **Mealie H-B configuration (0.C):** the probe runner takes only static role headers; Mealie's bearer tokens carry the user id, so the setup step must create probe users with fixed ids and a fixed secret so the tokens are constants. The rule is stated in the plan (§0.C).
