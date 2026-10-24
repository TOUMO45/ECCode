# Pre-registered protocol: the Mealie pilot — every ECCode capability on a real project

Committed and pushed before any measured run of the pilot starts; the git commit timestamp is the registration. Design: `docs/specs/2026-10-24-big-project-pilot-design.md` (the spec); plan: `docs/plans/2026-10-24-big-project-pilot.md`. Where this protocol is more specific than the spec, this protocol is what runs; every such point is listed under "Deviations from the spec's wording".

**Why.** Every earlier measurement of ECCode used small suites: synthetic multi-file tasks, and twenty real bugs in five small projects. The evaluation page lists "helps on real projects" as not proven. This pilot runs every capability on one real, large codebase, with criteria fixed in advance (spec section 8), and reports what it finds, met or missed.

## Subject

- **Mealie** (`github.com/mealie-recipes/mealie`), a self-hosted recipe manager: Python 3.12 backend (FastAPI, SQLAlchemy, Alembic, pydantic) and a Nuxt / TypeScript / Vue frontend.
- **Pin P = v3.20.0** = `dbe84cc91b9e1dfc88b783a1e31d8a8495800337`. **Window W = v3.20.0..v3.27.0** (first-parent history).
- **Licence.** Mealie is AGPL-3.0; ECCode is MIT. **No Mealie file is in this repository.** Tasks name upstream commits; hidden tests are exported from a local mirror at run time; committed reports quote names, counts and ECCode's own messages, never Mealie source. Transcripts and run records, which can quote Mealie code, stay outside the repository.
- Several upstream commits in W, three of the selected items among them, carry `Co-authored-by:` trailers naming an AI model. The model under test may have seen Mealie's history. Both affect every variant alike.

## What runs, and where

- **ECCode under test:** the commit of this protocol, run from a git worktree pinned at it.
- **Machine:** Linux container, 4 cores, 15 GB RAM. Node 22.22.0; Python 3.12.3 managed by uv 0.11.32; Claude Code CLI 2.1.310; model alias `sonnet`.
- **Mealie environments** (`bench/suites/mealie/_tools/setup.sh`, `env.js`), outside every sandbox under `ECCODE_MEALIE_ENVS`:
  - one venv per `uv.lock` (`uv sync --frozen --python 3.12 --no-install-project`). The project is not installed into it: tests import `mealie` from the tree, and a venv shared by many sandboxes must not point into one of them. The venvs hold no `pip`;
  - **`python-ldap`: mode `headers`** — `libldap2-dev` and `libsasl2-dev` were installed with apt and `python-ldap` built against them. No LDAP test is stubbed or excluded;
  - one `node_modules` per frontend lockfile, installed with `--ignore-scripts` and linked into each tree's `frontend/`; `nuxt prepare` runs per tree. yarn (with `--ignore-engines`: the lockfiles pin Node ^22.22.2, the machine has 22.22.0) before Mealie's switch to pnpm (#7663), pnpm through corepack after it.
- `TMPDIR=/tmp/mp` (short, outside any session scratchpad).
- **Baseline at P:** the full backend suite passes, 2,483 tests, 0 failures, 16 skipped by Mealie's own markers, 509 s.
- **Order:** Part A runs first, with no agent running: A1 alone (its timings need an idle machine), then A2, then A3, A4, A5 and A6 (A4 and A5 side by side), then A7. Parts B and C then run in parallel. Part B and C runs use the protocol's commit whatever Part A finds: Part A's findings are fixed after the whole batch.

## Part A: model-free measurements at P over W

Every script is in `bench/pilot/mealie/` and writes `results/<name>.json` there. Development runs used v3.18.0 and a 30-commit range ending there; no measured number at P has been seen.

| # | Command | Method |
|---|---|---|
| A1 | `node a1-index.js dbe84cc9…` | `eccode onboard --json` on a git checkout of P with an empty `.eccode/`: cold, warm, then warm after a one-line edit of one file. Intra-project imports per language (Python: dotted names starting `mealie` or `tests`; TS/JS: relative or through `~`, `@`, `~~`, `@@`), every unresolved one listed; files and lines per language; source files ECCode does not index (`.vue`) counted; dynamic loaders listed. |
| A2 | `node a2-impact.js dbe84cc9… --sample 40 --faults 10 --jobs 3 --frontend 10` | Ground truth from **one** run of the whole backend suite with per-test coverage contexts (a ten-line pytest plugin, `cov_context.py`, calling `coverage.switch_context` per test: pytest-cov is not a Mealie dependency and the venv is not modified). Population: backend modules some test executes, excluding `mealie/**/__init__.py` and `mealie/alembic/` (migrations are not import dependencies); 40 drawn with seed 42, stratified by package. Static `eccode impact`, and `--trace` with that same run merged per module. 10 of the 40 (seed 42) get a fault (below); the same coverage run is the no-fault baseline. Frontend: 10 modules under `frontend/app/lib` and `frontend/app/composables`; truth: the modules each spec file, run alone, loads, recorded from vitest's module graph by our setup file (`a2-loaded.mjs`, through a wrapper config written into the throwaway tree). |
| A3 | `node a3-compat.js v3.20.0..v3.27.0 --route-sample 20` | The compat check between parent and commit for every commit of W. Route recall on 20 commits touching `mealie/routes` (seed 42): FastAPI's own `app.routes` at parent and commit, imported in the pinned venv; a served route matches a declared one by method and path suffix (ECCode records paths as written under a router prefix). Destructive-migration recall (`op.drop_*` in an added migration's `upgrade()`) is reported with no criterion. |
| A4 | `node a4-fixverify.js v3.20.0..v3.27.0` | Population: `fix:` subjects (not `fix(deps)`) changing `mealie/` and `tests/`. Per commit, a scratch repository (parent tree committed as base, the commit's tree over it), `eccode debug`, the claim, then `eccode fix verify --json`. Oracle: the changed test files run directly on the parent with the new tests (pre) and at the commit (post): pre fails and post passes → proven, unless the pre output anywhere names a missing API (ImportError, ModuleNotFoundError, AttributeError, NameError, "cannot import name") → inconclusive; otherwise not proven. |
| A5 | `node a5-mutate.js v3.20.0..v3.27.0` | `eccode mutate` on each A4 commit's changed lines, with its changed tests. |
| A6 | `node a6-bugs.js v3.20.0..v3.27.0` | `eccode bugs` on every commit's diff. |
| A7 | `node a7-stack.js dbe84cc9…` | `eccode stack` detection and checks; each check run through ECCode and the same tool run as P's own `Taskfile.yml` runs it (`ruff check mealie`, `mypy mealie`, `pytest`, `yarn lint --max-warnings=0`, `yarn test:ci`; Python tools from the venv instead of `uv run`); the secrets scan. |

**Labels**, each with a one-line reason, written and committed before `report.js` runs: `labels/compat.json` (each detection: `true` breaking change or `false`), `labels/bugs.json` (each hit: `real`, `intentional` or `false-positive`), `labels/secrets.json` (each error-level hit in code: `true` or `false-positive`), `labels/fixverify.json` (each disagreement with the oracle: `engine-wrong` or `oracle-wrong`).

**Report:** `node bench/pilot/mealie/report.js --out bench/pilot-results/2026-10-24-mealie-part-a.md`, committed verbatim with the results and labels.

**Criteria** (spec section 8):

| Capability | Measure | Criterion |
|---|---|---|
| Index (A1) | intra-project imports resolved | Python ≥ 95%; TS/JS ≥ 90%; every unresolved import listed |
| Index (A1) | wall time of onboard at P | cold ≤ 120 s; warm ≤ 10 s; after a one-file edit ≤ 10 s |
| Impact (A2) | median recall against coverage over the 40 modules | static ≥ 0.90; with `--trace` ≥ 0.95 |
| Impact (A2) | median selected share of all test files | ≤ 0.5 |
| Impact (A2) | recall against the injected faults, pooled over the 10 | ≥ 0.90 |
| Compat (A3) | precision of detections over W, from the labels | ≥ 0.90 |
| Compat (A3) | recall against FastAPI's route table, 20 commits | ≥ 0.90 |
| `fix verify` (A4) | agreement with the direct run, each disagreement labelled | 100%: no disagreement labelled `engine-wrong` (raw agreement printed beside it) |
| `mutate` (A5) | runs completing | ≥ 90% |
| Bug rules (A6) | false positives per 10,000 changed lines | ≤ 1 |
| Stack (A7) | stacks detected at P | Python and Node |
| Stack (A7) | detected checks runnable, result equal to the tool run directly | all |
| Secrets (A7) | error-level false positives at P | ≤ 5, each labelled |

**Predictions from the development runs**, stated so that the measured run is not read as a surprise and no number is tuned on P:
- TS/JS resolution will likely miss: imports through Nuxt's `~/` alias resolve through a generated tsconfig ECCode does not read (v3.18.0: 37%). `.vue` files are not indexed (v3.18.0: 196 files), so imports from them are not counted at all.
- Fault recall will likely miss: modules reached from tests only through HTTP (`tests/conftest.py` imports `mealie.app`, which imports the routes) have no import path from any test, so static impact predicts none of their tests (v3.18.0: fault recall 0). This is a capability gap, measured as it is; a fix comes after the measured run.
- Compat precision is at risk from test helpers removed from `tests/`, which the export check counts as removed exports.
- Stack detection will likely miss the Node stack: Mealie's `package.json` is in `frontend/`, not at the root (v3.18.0: Python only, so no eslint or vitest check was listed). The checks criterion will likely miss on ruff: ECCode runs `ruff check .` over the whole repository, which failed at v3.18.0 where Mealie's `ruff check mealie` passed.

**After.** A capability fixed after the measured run is measured again at P, as an "after" run reported next to the "before" run, which is never replaced (spec section 7).

## Part B: ten real changes as work items

The ten items, in chain order (spec numbering: fix 1, debug 2, quick 3, feature 4, migration 5, routes 6, refactor 7, frontend 8, fullstack 9, security 10). Each item's hidden tests are the upstream fix's own; its request is in `bench/suites/mealie/_tools/prompts.json`.

| Order | Item | Track | Upstream change | Source commit | Target | Regression |
|---|---|---|---|---|---|---|
| 1 | `mealie-01-refactor` | refactor | One home for the slug-or-id lookup and the slug-on-update logic of groups and households (written for the pilot) | `dbe84cc9` | duplicate-body check | full backend suite (2,483 tests) |
| 2 | `mealie-02-fix` | fix | fix: harden LDAP and OIDC authentication providers (#7902, `280cd58b`) | `f2873227` | 5 tests | 32 tests |
| 3 | `mealie-03-fullstack` | feature | feat: Add feedback for bad JSON in HTML-JSON page (#7956, `5e886b11`) | `318f05f2` | 4 tests | 50 tests |
| 4 | `mealie-04-feature` | feature | feat: add native OIDC endpoints for mobile/desktop clients (#7804, `29897e35`) | `66afe5b4` | 5 tests | 23 tests |
| 5 | `mealie-05-frontend` | fix | fix: remove unsupported partitioned cookie (#8278, `aa0bf11e`) | `cbddafab` | 2 tests + 1 spec file | 7 tests + 32 spec files |
| 6 | `mealie-06-migration` | feature | feat: use OIDC avatars (#7624, `7808c944`) | `8007285b` | 36 tests | 23 tests |
| 7 | `mealie-07-quick` | quick | fix: coerce null food/unit description to empty string (#8309, `9429a591`) | `56fbf6ad` | 2 tests | 1 test |
| 8 | `mealie-08-debug` | debug | fix: auto_init merges model_config.exclude with default {"id"} instead of replacing it (#8336, `d204b719`) | `ed7d7aa9` | 1 test | 3 tests |
| 9 | `mealie-09-security` | fix | fix: Add permission checks for Group & Household members, hide totalUsers card for non-managers (#8348, `250d4996`) | `8553cfee` | 1 test | 4 tests |
| 10 | `mealie-10-routes` | feature | feat: add connectivity test for AI providers (#8123, `5530edeb`) | `6a42f7a0` | 15 tests | 39 tests |

**Selection** (`bench/suites/mealie/_tools/select.js`, recorded in `selection.json`), done before any model saw a task:
- Pools as in spec Part B, over W, each drawn with seed 42 in the order fix, debug (from the fix pool), quick, feature, migration, routes, frontend, fullstack, security. Each commit is used once.
- A commit is accepted only if, on two consecutive runs each: its new or changed tests fail on its parent and pass at the commit, and the regression set passes at both. Frontend items are validated per vitest spec file. Every skip is recorded with its reason.
- **Size cap**, added before registration after the first draw accepted features of 2,228 and 1,269 changed non-test lines: at most 400 changed non-test lines in at most 12 non-test files (tests, lockfiles, translations and docs not counted). A request must be able to state every interface the hidden tests pin, and an item should be one reviewable change. The draw then restarted from scratch under the final rules; the first draw is kept in `selection.json` (`firstDraw`).
- **Item 7, the refactor**, is the one item not taken from history (spec Part B, row 7): no pure refactor with tests exists in W. At P, `RepositoryGroup` and `RepositoryHousehold` each carry the same `get_by_slug_or_id` and the same `update`; the pair was found by a normalized-AST duplicate scan of `mealie/` at P, the largest duplicated pair of methods shared by two classes of one layer. Its request names both by file and function. Its target check is ours (`bench/suites/mealie/_hidden/dup_check.py`): it holds only hashes of the normalized duplicated bodies, no Mealie code, and fails while any hashed body appears in two functions. Its regression check is the full backend suite, which passes at P.

**Requests** (`_tools/prompts.json`), written from each PR and its tests, issue-style: the symptom or need, expected behaviour, the test command. Each names what the hidden tests pin — classes, functions, routes, settings, response shapes, module-level names the tests replace — by symbol, never by the path of a file its fix changes. `tests/mealie.test.js` checks that no request names a file its fix changes or contains a line of its fix.

**Hidden checks:** `target`, the PR's new or changed tests that fail on the parent and pass at the commit; `regression`, the other tests of the touched test files that pass at both (target tests and tests failing at both deselected). They are exported from the mirror at run time and run in a throwaway copy of the sandbox. **Live validation** before this registration (`ECCODE_MEALIE_VALIDATE=1 node --test tests/mealie.test.js`): for each of the nine historical items, the target check fails at the source commit and passes at the fix commit, and the regression check passes at both. A model-free smoke of the chain path (a no-op agent on items 7 and 8) ran end to end: toolkit installed, tree synced, setup, hidden checks in the throwaway copy (target failed, regression passed), chain summary written.

**Chain mode** (`--chain`): one sandbox and one ECCode record across the ten items in upstream order (by the date of each source commit; the refactor at P's date). Before each item the tracked tree is replaced by the item's source tree, keeping `.eccode/` and `.claude/`, and committed as `upstream: <sha>`. An item that ends with its work item still active (the agent stopped before delivering, timed out or crashed) is closed by the harness as the benchmark's human operator: `recover --all`, then `work abandon --actor user` with the reason "bench operator: item <id> ended without delivery; abandoned by the pre-registered policy so the next item can start". The engine refuses a new work item while one is active and only the user may abandon one; without this every later item of the chain would stall. These events are visible in the record as the user's.

**Variants and processes.** Six `eccode bench` processes, started detached at the same time from the pinned worktree, each with `--timeout 3600 --save <scratch>/<name>.jsonl --transcripts <scratch>/tr-<name>` and its share of the $250 ceiling:

| Process | Suite and options | Runs | `--max-cost` |
|---|---|---|---|
| b1 | mealie, `--chain --variant engine --runs 1 --engine-profile guard --engine-agents inherit` | 10 | 70 |
| b2 | the same, the second chain | 10 | 70 |
| b3 | mealie, `--variant without --runs 2` (a fresh sandbox at each item's source) | 20 | 40 |
| b4 | mealie, `--tasks <the quick item> --variant engine --engine-profile no-shell --engine-agents inherit --runs 2` | 2 | 15 |
| c1 | planner, `--chain --variant engine --runs 2 --engine-profile guard --engine-agents inherit` | 6 | 45 |
| c2 | planner, `--chain --variant without --runs 2` | 6 | 10 |

The spec's two engine chains run as two processes of one chain each (the same design; they run in the same hours as the bare runs). The MCP item is the quick-track item (spec row 3), wherever it falls in the chain order. Exactly:

```sh
B() { node bin/eccode.js bench --suite bench/suites/mealie --timeout 3600 --agent "$AGENT_B" "$@"; }
C() { node bin/eccode.js bench --suite bench/suites/planner --timeout 3600 --agent "$AGENT_C" "$@"; }
B --chain --variant engine --runs 1 --engine-profile guard --engine-agents inherit --max-cost 70 --save <scratch>/b1.jsonl --transcripts <scratch>/tr-b1
B --chain --variant engine --runs 1 --engine-profile guard --engine-agents inherit --max-cost 70 --save <scratch>/b2.jsonl --transcripts <scratch>/tr-b2
B --variant without --runs 2 --max-cost 40 --save <scratch>/b3.jsonl --transcripts <scratch>/tr-b3
B --tasks mealie-07-quick --variant engine --engine-profile no-shell --engine-agents inherit --runs 2 --max-cost 15 --save <scratch>/b4.jsonl --transcripts <scratch>/tr-b4
C --chain --variant engine --runs 2 --engine-profile guard --engine-agents inherit --max-cost 45 --save <scratch>/c1.jsonl --transcripts <scratch>/tr-c1
C --chain --variant without --runs 2 --max-cost 10 --save <scratch>/c2.jsonl --transcripts <scratch>/tr-c2
```

Each line runs detached (`setsid nohup`) from the pinned worktree, with `TMPDIR=/tmp/mp` and `ECCODE_MEALIE_ENVS` set.

**Agent commands**, one for each suite, identical across its variants:
- Mealie: `cat PROMPT.md | claude -p --model sonnet --setting-sources project,local --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(python*) Bash(pytest*) Bash(ruff*) Bash(mypy*) Bash(alembic*) Bash(cd frontend*) Bash(npx vitest*) Bash(npx eslint*) Bash(npx vue-tsc*) Bash(npx nuxi*) Bash(yarn test*) Bash(yarn lint*) Bash(yarn vitest*) Bash(pnpm test*) Bash(pnpm lint*) Bash(pnpm vitest*) Bash(pnpm exec vitest*) Bash(node .claude/eccode/bin/eccode.js*) Bash(git diff*) Bash(git status*) Bash(git log*) mcp__eccode_orchestrator mcp__eccode_product-architect mcp__eccode_architecture-reviewer mcp__eccode_technical-designer mcp__eccode_technical-reviewer mcp__eccode_backend-engineer mcp__eccode_frontend-engineer mcp__eccode_ai-engineer mcp__eccode_devops-engineer mcp__eccode_test-engineer mcp__eccode_security-reviewer mcp__eccode_delivery-lead mcp__eccode_learning-debugger"`
- Planner: `cat PROMPT.md | claude -p --model sonnet --setting-sources project,local --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(node*) Bash(npm*) Bash(npx*) Bash(git diff*) Bash(git status*) Bash(git log*)"`

`--setting-sources project,local` keeps the operator's user-level settings and plugins out of the sessions: in this container a default headless session fires a user-level plugin's SessionStart hook that injects skill text (it did so in every variant of the earlier batches; disclosed, register row). With it, project settings still load: smoke runs before this protocol showed the guard hook refusing a Write to `.eccode/events.jsonl`, and the no-shell profile's per-role MCP servers loading and answering (both smoke sessions excluded; $0.36). Frontend tools are allowed only in their test, lint and typecheck forms, so no session can install packages into the shared `node_modules`; the shared venvs hold no `pip`. After the batch, any file under `ECCODE_MEALIE_ENVS` newer than the launch is listed and disclosed, and so is any file an agent wrote into this repository or the pinned worktree (`git status` of both; register row 70).

## Part C: greenfield companion, `mealie-planner`

`bench/suites/planner`, ours, MIT: `SPEC.md`, the requests `c1` (greenfield track: build the service), `c2` (feature track: diet filters and label groups) and `c3` (feature track: households, through a new migration), a fake Mealie API (`_hidden/fake-mealie`, synthetic data) and black-box acceptance tests (`_hidden/acceptance.test.js`, 9, 4 and 5 tests for c1, c2, c3) run by `_hidden/check.js` against the started service. c2's regression check is c1's tests; c3's is c1's and c2's. A reference implementation (`reference/`, never shown to an agent) passes every test.

## Outcomes and criteria (spec section 8)

| Capability | Measure | Criterion |
|---|---|---|
| Tracks (B) | engine items delivered with a clean audit | ≥ 80% per chain; zero audit failures |
| Friction (B, C) | false refusals (ECCode wrong), over every engine-variant item run of b1, b2, b4 and c1 | ≤ 1 per item run on average; each one a register row |
| Long-lived record (B) | per chain, after item 10 | `eccode audit` clean; `status`, `metrics` and `audit` each ≤ 2 s; at least one lesson recorded in one item and surfaced in a later one |
| MCP (B) | the quick item with no shell | delivered with a clean audit in ≥ 1 of 2 |
| Greenfield (C) | gates in order; c1 to c3 delivered | in both engine chains: c1's gates approved in the order architecture, design, plan, phases, verification; c1, c2 and c3 delivered; c3 adds a migration file and edits or deletes no earlier one |
| Correctness (B, C) | runs passing every hidden check, engine against bare | reported with the permutation test stratified by item (20,000 seeded resamples, two-sided); no criterion (underpowered) |
| Cost (B, C) | median cost per item, engine over bare, per track | reported |

Operational definitions:
- *Delivered with a clean audit:* the record's work item for the run is delivered and `eccode audit` passes, as `bench` measures it.
- *Refusal:* every `eccode: [CODE] …` result and every tool-permission denial in an engine-variant transcript, extracted by `bench/pilot/refusals.js`. Each is labelled `correct`, `false` (ECCode wrong), `agent-error`, or `harness` (a permission denial by the benchmark's own `--allowedTools` list, not by an ECCode rule), with a reason, in `bench/pilot/mealie/labels/refusals.json`, before any summary figure is computed. Only `false` counts against the criterion.
- *Lesson surfaced:* a lesson the record lists after item i whose id or title appears in a tool result of a transcript of a later item of the same chain.
- *c1's gate order and c3's migration:* read from the copy of the record each engine run leaves next to its transcripts, and from c3's patch in its run record.
- Also reported per item, with no criterion: review rounds and findings (each checked real or not), compat detections and declarations, the impact summary at completion, tests written, tokens, cost and wall time; per chain: record size, incremental index time per item, `metrics` per track.

## Honesty rules (spec section 7)

- **One batch.** A run that fails for an infrastructure reason (API error, timeout, no result line) stays in the results as a failure. A sensitivity analysis without never-started sessions (no result line or zero turns) is reported next to the primary one.
- **A chain that dies mid-way** is not restarted; its remaining items count as not delivered, with the cause.
- **A defect found while runs are under way** is fixed after the batch, unless it invalidates every variant alike: then the batch stops, this protocol gets a dated amendment listing every finished run, and the batch restarts.
- **Budget:** a process stops before its next run once its runs have reported its `--max-cost` share; the shares sum to the $250 ceiling. A stop is reported as a partial batch with the stop disclosed.
- **Part A's measured run is reported verbatim**; fixes are measured in an "after" run next to it.
- **Labels before figures**, every false-positive label with its reason.
- These items and the planner are not sampled again with `sonnet` in these variants.

**Reporting:** `bench/pilot-results/2026-10-24-mealie-pilot.md` (every criterion and its result), with the saved runs as `2026-10-24-mealie-pilot.runs.jsonl` (scratch paths shortened to `<scratch>`) and the Part A report next to it. Every finding gets a register row in `docs/limits.md`; each defect gets a fix with a failing-first test.

## Deviations from the spec's wording

- **A2's fault** rewrites every function of the module to raise on entry (`fault.py`, an AST rewrite), not "the module raises at import": `tests/conftest.py` imports `mealie.app`, so an import fault in any module the app imports fails every test file, and the comparison would measure the conftest rather than the module's dependents. The AST rewrite also reaches FastAPI handlers registered at decoration time.
- **A2's frontend truth** is the set of modules each spec file loads (vitest's module graph, recorded by our setup file), not `vitest run --coverage`: Mealie's own coverage provider cannot run at P (its lockfile pairs vitest 4.1.9 with `@vitest/coverage-v8` 3.2.4: "Running mixed versions is not supported", then a TypeError; checked on 9ea0991d, a commit before P with P's exact frontend lockfile). Like the backend's line coverage, which counts code run at import, it is import-level; a module a spec mocks without loading is not counted. No package is installed and no Mealie file changes.
- **A2's `--trace`** merges the one whole-suite coverage run per module instead of tracing "the predicted tests" per module, which could never add a test outside the prediction.
- **Selection and building** are Node scripts (`select.js`, `build.js`), not `select.py`, to reuse the mirror and environment helpers.
- **The size cap** on every pool (above).
- **The operator abandon policy** in chain mode (above).
- **Two engine-chain processes** instead of one process running two chains (above).
- **Each engine run's record** is copied next to its transcripts, outside the repository, for the per-item measures.

## Development findings, fixed before this registration

Found by the development runs at v3.18.0 or by the harness's tests, before any measured run:
- **ECCode:** `fix verify` called a true reproduction inconclusive when pytest printed the failing frame as a path relative to its root; the check that the error passed through the fixed code now matches the path at a word boundary (`lib/fixverify.js`; test in `tests/fixverify.test.js`). Register row: "found by the pilot's development run, fixed before the measured run".
- **Instruments:** A4's oracle read only the last 40 lines of output (a collection error sat above Mealie's warnings summary); A3's route lister counted log lines as routes; A6 counted no added lines for new files; A7's direct commands did not match the Taskfile; the report had no row for the spec's stack-detection requirement; the planner's hidden check passed vacuously, deadlocked and leaked servers. Each was fixed with a test.
- **Harness:** hidden checks carry their own timeouts; the frontend environments (pnpm after #7663, yarn engines, `nuxt prepare` per tree) — the twelve environment-caused skips of the first draw are on record in `selection.json`.
- **Measured as they are, not fixed before the run:** the A2 HTTP-reach gap, TS alias resolution and `.vue` indexing, removed test helpers counted as removed exports, and Alembic `op.drop_*` not seen by the destructive-SQL rule.

## Amendment 1 (2026-10-24T16:07Z, during the batch, before any label or figure)

**What was found.** The first saved records showed it. The batch was launched from a Claude Code session, and every benchmark session inherited that session's id (`CLAUDE_CODE_SESSION_ID`). The items of a chain share one sandbox directory, so they appended to one transcript file. The copy kept for item k therefore holds the lines of items 1 to k. This was checked on b1's first three items:
- Each copy is an exact prefix of the next.
- Only the main session's file is affected. Subagent files are new for each item.

**The sessions themselves were independent.** The first request of every later item has the same input size as item 1's (about 37k tokens), so no item saw an earlier item's conversation.

**What it would do to the analysis.** Read as copied, the transcripts would:
- count an earlier item's refusals again in every later item;
- credit a later item with "surfacing" a lesson whose id is only in the earlier item's own lines.

**The amendment.** For each chain item, the analysis counts only the lines its copy added to the copy of an earlier item of the same chain (`ownOffset`, `sessionOffset`, `itemToolText` in `bench/pilot/analyse.js`; test in `tests/pilot.test.js`). No run, criterion or label rule changes.

**For later runs.** The harness no longer passes the launching session's identity and IPC variables to agents (`agentEnv` in `lib/bench.js`; test in `tests/bench.test.js`). This batch keeps running unchanged from the pinned worktree.

**Also disclosed.** The rest of the launching session's environment reached every session of this batch and of the earlier batches, in all variants alike. That includes `CLAUDE_EFFORT=xhigh`, `CLAUDE_AUTO_BACKGROUND_TASKS=true` and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`.
- Every subagent of this batch ran as a background task (46 of 46 at 16:20Z).
- Whether `CLAUDE_EFFORT` changes a headless session's behaviour was not tested.
- In the after-fix checks of the MCP item (outside the batch), the orchestrator ended its turn while a background engineer was working. The session then stopped the engineer.

The harness now strips these settings too, so later runs start as plain headless sessions. Stripping them did not change the default: in a third after-fix check, the subagent again started in the background. In this version of Claude Code the Agent tool starts agents in the background unless the call passes `run_in_background: false`. The playbooks now say to dispatch in the foreground and never to end the turn while a dispatched agent is working (`tests/quick.test.js`).

That third check also lost its record. The stopped engineer's test run kept writing into the sandbox, so removing the sandbox failed (ENOTEMPTY). The harness now:
- runs each agent in its own process group and stops what it left running;
- reports a removal failure instead of losing the run (`tests/bench.test.js`).

The registered batch runs with the earlier harness, so a removal failure there would end its process.

**Defects found in ECCode so far.** Each is fixed with a failing-first test in the main tree. None changes this batch, which runs from the pinned worktree:
- **MCP item (b4):** in the no-shell profile, role agents had no MCP tools, so they could not claim a task.
- **Refactor items (b1, b2 item 1):** `init --track refactor` accepted no behaviour command, so the work item could never pass verification.
- **Found by the after-fix check of the MCP item:**
  - The quick track's detected check was pinned to the frontend sub-project's tests for a backend change. This regression came from a pilot fix to stack detection.
  - Claude Code's 60-second default MCP call timeout cut off `evidence_run` on a full suite.
- **Greenfield chain (c1, item 1):** the integrity window around a checked command restored the record to its pre-command snapshot. While two agents worked, `mutate` therefore erased a passing evidence run another engineer had just recorded, whose completion was then refused ("evidence … does not exist"), and the orchestrator's run end. The window now holds the record lock while the command runs. Other writers wait for it, and an engine write from inside a checked command is refused (`tests/integrity.test.js`).
- **Guard (c1, item 1):** the guard misread a double-quoted `sed` expression with escaped quotes. It took a garbled word inside the project for the write target and refused a reviewer's edit of its own scratch file outside the project. It also counted a `find` without write actions as a write to the record (`tests/security.test.js`).
- **Reviews (c1, item 1):** design and plan reviews could cite only the submission's own files. Reviewers who cited the approved architecture brief or design spec, to show the work traces back to them, were refused. A review may now also cite what an earlier gate approved, since the audit pins those artifacts (`tests/gates.test.js`).
- **Plans (b1 and b2, item 2):** both chains stalled the same way on the fix item. The plan pinned the code task to tests whose fixtures a later, dependent task updated, so neither task could finish. Only the user may change an approved plan. The delivery-lead and technical-reviewer instructions now require each task's check to be able to pass once that task alone is done (`tests/quick.test.js`). It is guidance, not an engine rule: the engine cannot know in advance which tests a change breaks.
