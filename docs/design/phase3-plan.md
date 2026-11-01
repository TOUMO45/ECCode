# Phase 3 plan: judgment, production guards and proof

Status: written 2026-11-01 after [phase3-recon.md](phase3-recon.md), before implementation. Baseline `npm run check`: 429 tests, 414 pass, 15 skipped without `ECCODE_PYTHON`, at commit `96ac8f2`. The brief is the owner's Phase 3 master prompt; section 7 lists every deviation and the test that pins it.

## 0. Order of work and the freeze

1. **Part 0 first.** 0.B is done (independent label `agent-error`, amendment 3). 0.A runs in the background under amendment 3 (ECC calibration, then the three arms). 0.C (this section) lands **before any Phase 3 engine edit**, because the H-B pipeline is frozen by content hash and 0.C is the last change to it.
2. **The freeze after 0.C.** The configuration generator, the Mealie setup script and the per-seed runner live in `bench/pilot/phase2-hb/` and are added to `bench/pilot/phase2-freeze.json` (hashes only; the rule in `phase2-seeds.js` is untouched, the freeze file is not a frozen file). The commit is tagged `phase2-hb-freeze` and recorded in protocol section 4a. **0.D runs the measurement from a git worktree of ECCode at that tag**, where `assertFrozen` checks every hash; HEAD is never loaded by the measurement. On HEAD, Phase 3 edits the frozen engine files except the two detector files, which stay byte-identical (a test pins their hashes to the freeze). Recon §9.1; register row 157.

### 0.C The Mealie configuration and the per-seed runner (deterministic rule)

`bench/pilot/phase2-hb/config.js` writes `.eccode/behavior.json` for a Mealie checkout from the rule below; nothing in it is chosen per seed, and the seed kind labels are never read by it (the generator takes the checkout path and the frozen-tree path only).

| Key | Rule |
|---|---|
| `app` | `mealie.app:app` (the module that defines `app = FastAPI(` : `mealie/app.py:105`) |
| `python` | unset: `pythonFor` resolves the checkout's `.venv` |
| `env` | `DATA_DIR={tmp}/data`, `TESTING=True`, `PRODUCTION=True`, `ALLOW_SIGNUP=True` (the backend suite's environment, `tests/conftest.py:24-29`), `NLTK_DATA` to the shared corpus, and the two probe tokens as `ECCODE_HB_USER_TOKEN` / `ECCODE_HB_ADMIN_TOKEN` for the setup script |
| `setup` | `<checkout>/.venv/bin/python <frozen tree>/bench/pilot/phase2-hb/mealie_setup.py`: writes a fixed `.secret` and `.session_secret` under `DATA_DIR` (so `SECRET` is a constant), runs `mealie.db.init_db.main()`, creates two users with **fixed ids** (`…-4111-8111-…` user, `…-4222-8222-…` admin) in the default group and household, and stores one long-lived API token row per user whose `token` column is the constant JWT from the environment |
| `roles` | `anonymous` (no header), `user`, `admin` (`Authorization: Bearer <token>`); the tokens are HS256 JWTs over `{"long_token": "eccode-hb", "id": <fixed user id>}` under the fixed secret, computed in the generator with no randomness, so the file is byte-identical on every run |
| `normalizers`, `ignoreFields`, `unordered` | empty: the engine's defaults only (uuid, ISO timestamp, address, object-at). Nothing Mealie-specific, so no field can be tuned toward a seed |

Why long-lived tokens: `get_current_user` (`mealie/core/dependencies/dependencies.py:102`) resolves a `long_token` payload through the `long_live_tokens` row whose `token` equals the whole JWT and whose `user_id` equals the payload's `id`; with fixed user ids and a fixed secret the JWT is a constant, so static role headers work.

`bench/pilot/phase2-hb/run.js <frozen tree> <mealie checkout> [--only ids]`: for each seed, in order: reset the checkout to the registered commit (`.eccode/` excluded through `.git/info/exclude`), `eccode init --track fix`, write the configuration, declare the contract of an intended seed (`behavior contract`, from the seed's own `contract` entries), `phase2-seeds.js apply` (which runs `assertFrozen` on the frozen tree), `behavior route`, `behavior diff --runs 2`, and record `{id, intended, kind, route, probes, executed, dropped, unexplained, coverage, flagged}` to `bench/pilot-results/<date>-phase2-hb.jsonl`; every `eccode` call is `node <frozen tree>/bin/eccode.js`. `flagged` = unexplained ≥ 1 for an unintended seed, unexplained = 0 for an intended one; a `skip` routing or `insufficient-coverage` is a miss, reported as its own line. Tested on the Phase 2 fixtures (`tests/phase2-hb.test.js`: the generator is deterministic, the runner flags the fixture's seeded changes through the same path, the runner refuses a tree whose hashes differ).

## 1. Modules (new and changed)

| File | Purpose |
|---|---|
| `lib/worktree.js` | `worktreeAt`, `overlay`, `withWorktrees` (two sides, cleanup in `finally`): the pattern of `lib/behavior.js:250-287`, exported |
| `lib/design.js` | Part A: alternatives, decision, ADR artifact, spikes, amendments; ambiguity and clarification; the problem lists for claim, review and delivery |
| `lib/guards/index.js` | Part B and F routing: which guards a work item needs (`guard.routing`), waivers, the problem lists |
| `lib/guards/migration.js` | B.1: Alembic static analysis, expand/contract check, rollback proof (upgrade → downgrade → upgrade on a seeded sqlite copy, schema round-trip) |
| `lib/guards/api.js`, `scripts/guards/openapi_dump.py` | B.2: OpenAPI (and exported signatures) baseline vs candidate, classification breaking / additive / none |
| `lib/guards/perf.js`, `scripts/guards/perf_probe.py` | B.3: micro-benchmark on the change's surfaces in two worktrees (warmup, N repetitions, median and IQR) and SQLAlchemy query counts per request (N+1) |
| `lib/guards/race.js`, `scripts/guards/race_probe.py` | B.4: concurrent operations against a seeded DB with declared invariants |
| `lib/guards/release.js` | B.5: `release.plan` with reviewer acknowledgement |
| `lib/security.js`, `scripts/guards/access_probe.py` | Part C: access matrix, IDOR probes, auth-flow checks, input probes; policy declarations |
| `lib/plan-budget.js` | Part D: `plan.contracts`, task budgets, checkpoints, rescope-cites-contract, the double-change ambiguity stop |
| `lib/standards.js` | Part E: observed standards from git history and tool configs, into project memory, shown at onboarding |
| `lib/metrics.js` (extend `memory/metrics.js`) | Part F: cost per track and per correct change |
| `lib/reducer.js`, `lib/store.js`, `lib/config.js`, `lib/gates.js`, `lib/tasks.js`, `lib/works.js`, `lib/delivery.js`, `bin/eccode.js`, `lib/cli-args.js`, `lib/mcp.js`, `lib/install.js`, `scripts/hooks/guard.js`, `schemas/plan.schema.json`, `schemas/handoff.schema.json` | wiring: state, hashes, config defaults, gates, CLI groups `design`, `request`, `guard`, `security`, `plan contracts|checkpoint`, `standards`; record protection |
| `tests/fixtures/phase3/` | the FastAPI + SQLAlchemy + Alembic fixture app (`ledger`: users with 3 roles, owned accounts and transfers, products, orders), seeded data, seeded flaws for B and C, the scorecard builder |
| `bench/suites/senior/` | Part G items, `_tools` builder and harness-side checks |

## 2. Events

Every event is committed through `store.commit` with its checks in `check`, reduced into per-work state (reset on `work.started`, archived in `pastWorks`), with artifacts content-hashed and re-hashed by `audit` (`store.artifactErrors`). `STATE_VERSION` → 6.

| Event | Payload | Written by |
|---|---|---|
| `request.ambiguity` | `{id, questions: [{id, text, blocking, options?}]}` | orchestrator / product-architect |
| `request.clarified` | `{question, answer}` | user only |
| `request.assumption` | `{question, reading, rationale}` (headless reasonable reading; surfaced in handoff and report) | orchestrator |
| `design.alternatives` | `{id, options: [{id, title, tradeoffs: {complexity, risk, performance, security, reversibility}}]}` (≥ 2 options, every tradeoff present) | technical-designer / product-architect |
| `design.decision` | `{id, alternatives, chosen, rationale, rejected: [{option, why}], interfaces: [{surface, target}]}` | technical-designer / product-architect |
| `design.adr` | `{id, decision, artifact, artifactSha256}` (rendered ADR at `.eccode/design/<id>.md`) | technical-designer |
| `design.spike.started` / `design.spike.closed` | `{id, question, paths}` / `{id, proved, discarded: true}` | implementer |
| `design.amended` | `{id, decision, interfaces, reason, reviewer}` | reviewer only |
| `guard.routing` | `{id, surfaces, required: [migration, api, perf, race, security], reasons, treeFingerprint}` | engine, at the first claim and re-checked at delivery |
| `migration.analysis` | `{id, files, findings: [{kind, severity: blocking\|warning, file, line, message}], expandContract: [...], artifact, artifactSha256}` | implementer / reviewer |
| `migration.rollback.proof` | `{id, evidence: [ev ids], schemaBefore, schemaAfter, roundTrip: true\|false}` | implementer / reviewer |
| `api.diff` | `{id, base, head, breaking: [...], additive: [...], artifact, artifactSha256}` | implementer / reviewer |
| `perf.result` | `{id, probes: [{target, baseline: {median, iqr, queries}, candidate: {...}, regression}], threshold, artifact, artifactSha256}` | implementer / reviewer |
| `race.result` | `{id, operations: [{name, concurrency, invariants: [{name, held}]}], artifact, artifactSha256}` | implementer / reviewer |
| `release.plan` | `{id, flag\|rollout, monitoring, rollback}` + `release.acknowledged {plan, reviewer}` | delivery-lead; reviewer |
| `guard.waiver` | `{id, guard, finding, reason}` | reviewer only |
| `security.policy` | `{id, cells: [{role, endpoint, ownership, expected}]}` | security-reviewer / technical-designer |
| `security.matrix.result`, `security.idor.result`, `security.authflow.result`, `security.input.result` | `{id, cells\|probes: [...], unexplained, artifact, artifactSha256}` (request/response pairs in the artifact) | implementer / security-reviewer |
| `plan.contracts` | `{id, contracts: [{id, kind: interface\|schema\|api, text}]}` | technical-designer, before implementation |
| `task.budget.waived` | `{task, reason}` | orchestrator |
| `plan.checkpoint` | `{id, afterTasks, evidence: [...], passed}` | orchestrator |
| `project.standards` | `{id, observed: [{kind, rule, examples, source}], artifact}` | engine (report-only) |

## 3. Gates (each with a positive and a negative test; bypass tests forge the raw event)

1. **Design before ownership.** `tasks.claimOnly` on feature, refactor and greenfield refuses (`TRACK_RULE`) until a `design.decision` exists whose `alternatives` has ≥ 2 options with every tradeoff; quick, debug and fix are exempt (fix keeps the Lab). Negative: claim without a decision; a decision citing one option; a forged `design.decision` with a missing tradeoff (reducer keeps it, the check refuses).
2. **Spike never ships.** `tasks.complete` and `delivery.preconditions` refuse when any path of an open or closed spike is in the changed files, or a spike's recorded file hashes appear in the delivered tree. Negative: a spike file renamed into the diff (hash match).
3. **ADR cited and honoured.** Verification approval on those tracks must cite `artifact:.eccode/design/<adr>.md`; delivery refuses when `api.diff` breaking entries or declared behavior-contract targets are not among the ADR's `interfaces` and no reviewed `design.amended` covers them. Negative: a breaking route change without amendment.
4. **Ambiguity stop.** `gates.startGate('plan')` and `quick.start` on non-quick tracks refuse (`AMBIGUITY_OPEN`) while a `blocking` question has neither `request.clarified` nor `request.assumption`; an assumption is rendered in every handoff's `remainingIssues` and in the final report's "Assumptions" section. Negative: planning with an open blocking question; an assumption with an empty reading.
5. **Migration guard.** Delivery refuses a change with a migration file (`compat.MIGRATION_FILE`) without `migration.analysis` and `migration.rollback.proof` for the current tree fingerprint, or with a blocking finding without a reviewer's `guard.waiver`. Negative: a drop column without waiver; a missing downgrade; an in-place rename.
6. **API compatibility.** A breaking `api.diff` must be declared in the design (`interfaces`) and the behavior contract; otherwise delivery refuses. Negative: a removed endpoint, a new required parameter.
7. **Performance budget.** `perf.result` with a regression beyond `config.guards.perf.maxLatencyRegression` (0.20) or any new N+1 refuses delivery unless declared in the design and waived with rationale. Negative: a seeded N+1.
8. **Race probe.** Required when `guard.routing` flags shared state (ownership of `config.guards.race.surfaces` or the fixture's declared operations); a failed invariant refuses delivery. Negative: a double-spend.
9. **Release plan.** feature and greenfield delivery requires `release.plan` acknowledged by a reviewer; its content is reported only.
10. **Security.** A change touching routes, auth, permissions or models with ownership fields (routing by `surfacesOf` and the configured ownership models) refuses delivery without `security.matrix.result` and `security.idor.result` at the current fingerprint with zero unexplained failures; an `unknown` cell on a new endpoint needs a reviewed `security.policy`; the security reviewer's own re-run is required (existing rule). Negative: each seeded flaw.
11. **Task budget.** `validatePlan` refuses a task with more than `config.plan.maxFilesPerTask` (3) explicit files; `tasks.complete` refuses a task whose changed lines exceed `config.plan.maxLinesPerTask` (150) without `task.budget.waived`. Negative: an over-budget completion.
12. **Checkpoint.** After every `config.plan.checkpointEvery` (3) completed tasks a `plan.checkpoint` must pass before the next claim; a failed checkpoint blocks claims until a passing one. Negative: claim with a due checkpoint.
13. **Rescope cites a contract**; a contract changed twice records a blocking `request.ambiguity`.

## 4. Commands and MCP tools

`eccode design alternatives|decide|adr|spike start|spike close|amend`, `eccode request ambiguity|clarify|assume`, `eccode guard route|migration|api|perf|race|release|waive`, `eccode security policy|matrix|idor|authflow|input`, `eccode plan contracts|checkpoint`, `eccode task waive-budget`, `eccode standards extract|show`, `eccode metrics cost-per-track`. MCP tools `design_*`, `request_*`, `guard_*`, `security_*`, `plan_contracts`, `plan_checkpoint`, `standards_*`; every executed probe over MCP comes from `approvedCommands`. Role tools in `install.giveRoleTools`; the quick/debug command docs unchanged; new sections in `commands/start.md`, `commands/review.md`, `commands/deliver.md`; `docs/design-decisions.md`, `docs/production-guards.md`, `docs/security-probes.md`, `docs/large-changes.md`.

## 5. Fixtures and scorecards

`tests/fixtures/phase3/ledger`: FastAPI + SQLAlchemy 2 + Alembic on sqlite, roles `admin` / `member` / `viewer` by bearer token (static tokens in `.eccode/security.json`), owned objects (accounts, transfers), products and orders with totals, a password-reset token table, a template-rendered endpoint; seeded data; `.eccode/behavior.json`, `.eccode/guards.json`, `.eccode/security.json`. Seeds (`seeds.js`): B.1 four unsafe migrations (NOT NULL without default on a large table, drop column, missing downgrade, rename in place) and four safe ones; B.2 three breaking API changes and three additive; B.3 two N+1 and one latency regression plus their safe counterparts; B.4 double-spend and duplicate insert plus safe counterparts; C three IDORs (read, update, delete), mass-assignment escalation, field leakage, missing auth on one route, reset-token reuse, SQL concatenation, plus safe counterparts. `tests/phase3-fixtures.test.js` runs each guard on each seed and prints the scorecard (caught / false positives) to `tests/fixtures/phase3/scorecard.md`; the CI job installs sqlalchemy and alembic.

## 6. Senior Bench (Part G) and cost (Part F)

Registered in `bench/protocols/<date>-senior-bench.md` before screening: categories, sources (Mealie and a second FastAPI + SQLAlchemy + Alembic project, commits after the model's cutoff where available, dates stated), item minimums per category by simulation, harness-side checks (the Phase 3 guards run by the harness on every arm's delivered tree, frozen by hash), independent labellers for the ambiguous category, arms, metrics, go/no-go, screening cap $100, and the measured-arm estimate for approval. Part F publishes cost per correct change per track on the fixtures (`metrics cost-per-track`) against the targets quick 1.5×, fix 4×, feature 8× bare, and names where to narrow checks if a track exceeds its target.

## 7. Deviations (each pinned by a test)

| Deviation | Why | Test |
|---|---|---|
| H-B measured from the `phase2-hb-freeze` worktree, not HEAD; frozen engine files other than the two detector files change on HEAD | the freeze covers the whole engine (recon §9.1) | `tests/phase2-stats.test.js`: the two detector hashes equal the freeze; `tests/phase2-hb.test.js`: the runner refuses a tree whose hashes differ |
| `lib/worktree.js` duplicates `behavior.worktreeAt` | frozen module cannot export | `tests/worktree.test.js` |
| Task-size budget reverses "measure, never cap" | the brief; waiver path kept | `tests/plan-budget.test.js` |
| Hot paths = change surfaces + impact dependents | no runtime profile exists | `tests/guards.test.js` |
| OpenAPI and signature diff only for Python/FastAPI | brief's rule 9 | `tests/guards.test.js` |
| Design enforced at claim on refactor (no design gate there) | track definition | `tests/design.test.js` |
| Headless ambiguity resolved by a recorded assumption | no human in a benchmark | `tests/design.test.js` |
| Part E report-only, `observed` records never enforced | the brief | `tests/standards.test.js` |
