# Big-project pilot: every ECCode capability on a real codebase

Status: design approved in conversation on 2026-10-24; this spec is for review before planning.

## 1. Why

The evaluation's largest unproven claim is "It helps on real projects": every session so far ran on fixtures or benchmark sandboxes. The real-bug batch used real code but one bug at a time, in small slices of five projects. No test has yet run ECCode on one large, living codebase across many work items, with every capability engaged where it matters.

This pilot does that, on a project ECCode's authors did not write. Answers are checked by something other than the agent: the project's own tests and history, a coverage run, FastAPI's own route table.

**What it must show, per capability:** that the capability works at the scale of a real project. Each capability has a pre-registered criterion (section 8). A missed criterion is a finding: it becomes a register row and, where it is a defect, a fix measured again.

**What it does not try to show:** a significant correctness difference between ECCode and a bare agent. Ten items at n = 2 cannot detect anything but a very large effect. The comparison is reported with its test and stated plainly as underpowered.

## 2. Subject

- **Mealie** (`github.com/mealie-recipes/mealie`), a self-hosted recipe manager:
  - Python 3.12 backend: FastAPI, SQLAlchemy, Alembic, pydantic;
  - Nuxt / TypeScript / Vue frontend.
- **Pin P = v3.20.0** (`dbe84cc91b9e1dfc88b783a1e31d8a8495800337`, 2026-06-24).
- **Window W = v3.20.0..v3.27.0** (`dedc6cc7…`, 2026-09-17): 410 commits, all on Python 3.12. Of these, 101 are code fixes, 79 dependency bumps and 39 features.
- At v3.22.0 the tree held:
  - 433 backend Python files (about 44k lines) and 111 backend test files (about 39k lines);
  - about 23k lines of TypeScript and 39k of Vue, with 19 frontend spec files;
  - 48 Alembic migrations;
  - about 250 FastAPI route decorators.
- Backend tests run with pytest on SQLite, with no services. Frontend unit tests run with vitest.
- **Licence:** Mealie is AGPL-3.0, and ECCode is MIT. **No Mealie file is copied into this repository.**
  - Tasks name upstream commits.
  - Hidden tests are exported from a local mirror when a run happens.
  - Committed reports quote names, counts and ECCode's own messages, never Mealie source.
  - Transcripts, which can quote Mealie code, stay outside the repository.

## 3. Structure

Three parts, run in this order:
- **A:** model-free measurements;
- **B:** ten real changes as agent work items;
- **C:** a greenfield companion module.

A needs no model and runs first, so its defects are found and fixed before agents spend money on them.

### Part A: model-free measurements at scale

Every measurement is a script under `bench/pilot/mealie/`. It writes JSON plus a markdown table. Development runs use **v3.18.0**, so that the measured numbers at P are not tuned on. The measured run happens at P after the protocol is pushed.

**A1. Index and onboard.**
- On a clean checkout of P: `eccode onboard` cold, then warm, then warm after a one-file edit.
- Report:
  - wall time;
  - files and lines per language;
  - intra-project imports resolved and unresolved, per language;
  - dynamic loaders flagged.
- Ground truth for "intra-project":
  - Python: an import whose dotted name starts with `mealie` or `tests`;
  - TS/JS: a relative import, or an import through a configured alias (`~`, `@`, `~~`, `@@`).
- Unresolved imports are listed, so that a gap such as Nuxt's generated `tsconfig` is visible.

**A2. Impact against the tests that actually run the code.**
- Ground truth, run once:
  - the backend suite runs under `coverage run` with per-test contexts (`--cov-context=test`);
  - for every backend module, the set of test files with at least one test that executes a line of it.
- Sample: 40 backend modules drawn with seed 42, stratified by package (`routes`, `services`, `repos`, `db/models`, `schema`, `core`, other). Modules that no test executes are excluded and counted.
- For each module, `eccode impact <module>` (static) and `eccode impact <module> --trace -- "<pytest of the predicted tests>"`. Report:
  - recall: covering test files predicted, over all covering test files;
  - precision: predicted test files that cover, over all predicted;
  - selected share: predicted test files over all test files.
- Fault injection on 10 of the 40, seed 42:
  - the module raises at import;
  - the full suite runs;
  - the test files that fail are compared with the prediction.
- Frontend: the same recall measure for 10 modules under `frontend/lib` and `frontend/composables`. vitest has no per-test coverage contexts, so the ground truth comes from running each spec file alone under `vitest run --coverage` and reading which modules it executes.
- This shows whether the import graph crosses into tests at all, and what `--trace` adds.

**A3. Breaking-change replay over history.**
- For each of W's 410 commits, the compat check runs between parent and commit over the whole repository.
- Every detection is labelled by hand, with a one-line reason, in `bench/pilot/mealie/labels/compat.json`:
  - kinds: removed export, removed route, edited or deleted migration, destructive SQL in a new migration;
  - labels: true breaking change, or false positive (for example, a route moved to another file, or an export re-exported elsewhere).
- Recall sample: 20 commits drawn with seed 42 from those that touch `mealie/routes`.
  - At parent and at commit, the set of routes is read from FastAPI's own `app.routes`, by importing the app in the pinned venv.
  - Route removals there that the compat check missed are counted.

**A4. `fix verify` on real fixes.**
- Population: every commit in W whose subject starts `fix:` (dependency bumps excluded) and that changes both `mealie/` and `tests/`.
- For each:
  - the parent tree plus the commit's test files are put in a scratch record;
  - the engine's own reproduction and verification runs are recorded;
  - `fix verify` gives its verdict: PROVEN, INCONCLUSIVE or NOT PROVEN.
- Ground truth: run the commit's changed tests directly on the parent (expected: fail) and on the commit (expected: pass).
- Report the agreement, every disagreement with its cause, and the runtime.

**A5. `mutate` on real changes.** On the same population, `eccode mutate` on the commit's changed lines with its changed tests. Report:
- mutants per changed line;
- kill rate;
- runs that timed out or errored;
- wall time.

**A6. Bug rules.** `eccode bugs` on every commit diff in W. Every hit is labelled as a real defect, intentional, or a false positive. Report hits per 10,000 changed lines.

**A7. Stack and secrets.**
- `eccode stack` on P must detect the Python and Node stacks.
- Every check it lists is run (pytest, ruff, mypy, eslint, vitest, as present). Each result is compared with running the same tool directly.
- `eccode stack run eccode-secrets` on P: every hit is labelled.

### Part B: ten real changes as agent work items

**Selection, done mechanically before any model sees a task** (`bench/suites/mealie/_tools/select.py`, output `selection.json`, seed 42):

| # | Category | Pool in W | ECCode feature exercised |
|---|---|---|---|
| 1 | Backend bug, fix track | `fix:` commits changing `mealie/` and `tests/` whose new tests fail on the parent | reproduction rule, plan gate |
| 2 | Backend bug, debug track | same pool, a different draw | `fix verify` and `mutate` gates |
| 3 | Small backend change, quick track | `fix:` or `feat:` commits changing at most 3 `mealie/` files, with tests | one-step path |
| 4 | Backend feature, feature track | `feat:` commits changing `mealie/` and `tests/` | design and plan gates, multi-task plan |
| 5 | Feature adding an Alembic migration | commits adding a file under `mealie/alembic/versions` with tests | migration rules |
| 6 | Change to HTTP routes | commits adding, removing or changing a route decorator under `mealie/routes`, with tests | route compat, `breakingChanges` declarations |
| 7 | Refactor, refactor track | **no pure refactor with tests exists in W.** This item is a refactor request I write on real duplicated backend code, chosen before any model run and disclosed as the one item not taken from history | behavior suite before and after, no route or export removed |
| 8 | Frontend change with vitest specs | commits changing `frontend/` and a `*.spec.ts` / `*.test.ts` | TS stack, frontend impact |
| 9 | Full-stack feature | `feat:` commits changing `mealie/`, `frontend/` and tests | plan across owners, cross-language |
| 10 | Security fix | `fix:` commits whose subject or diff concerns permissions, SSRF, auth or filtering, with tests | security review |

- A commit enters a pool only if:
  - its new or changed tests fail on its parent;
  - they pass at the commit;
  - the regression set passes at both;
  - all three hold on two consecutive runs, so flaky tests are kept out.
- Each commit is used once. Draws go in pool order; skips are recorded with reasons.
- The chain runs the items in upstream chronological order. Item 7 runs at its position by its chosen base commit.

**Each task** (`bench/suites/mealie/<id>/task.json`, no Mealie file inside):
- `source`: `{repo, commit}`, the fix commit's parent. The sandbox is that tree with no history.
- `prompt`: an issue-style request written from the PR's description and tests: symptom or need, an example, expected behavior, how to run tests. No line of the fix appears in it; a test checks this, as for the real-bug suite.
- `hiddenChecks`:
  - **target**: the PR's new or changed tests;
  - **regression**: the other tests in the touched test modules that pass before and after.
  - Hidden files are declared as `fromSource: {commit, paths}` and exported from the mirror at run time.
- `env` and `setup`:
  - the venv lives outside the sandbox (`UV_PROJECT_ENVIRONMENT`);
  - `setup` runs `uv sync --frozen` when the item's `uv.lock` differs from the previous item's;
  - node modules are cached by lockfile hash.

**Chain mode** (new in `lib/bench.js`, `--chain`). One sandbox and one ECCode record are kept across all ten items in order. Before each item:
- the tracked tree is replaced by the item's source tree, keeping `.eccode/` and `.claude/`, and committed in the sandbox as `upstream: <sha>`, as if teammates' commits had landed;
- the agent then works the item as a new work item (`eccode quick`, `eccode debug`, or `work start --track …`) on the same record.

Hidden checks run in a throwaway copy of the sandbox, so hidden files never reach the next item. The agent never sees future upstream commits: the sandbox history holds only syncs and the agent's own commits.

**Variants and runs** (Sonnet, `claude -p`, toolkit installed with the `guard` profile, timeout 3,600 s per item):
- `engine-chain`: 2 chains of all 10 items, i.e. 20 runs;
- `bare`: each item twice, independently, in a fresh sandbox at its source commit, i.e. 20 runs;
- `mcp`: item 3 twice through `eccode mcp`, no shell, i.e. 2 runs.

That is 42 runs. Each run's patch is kept in its record. Transcripts are kept outside the repository.

**Measured per item:**
- hidden checks;
- delivered with a clean audit;
- review rounds and findings, each checked as real or not;
- compat detections and declarations;
- impact summary at completion;
- tests written;
- cost, tokens, wall time;
- every ECCode refusal in every transcript, labelled correct, false (ECCode wrong) or agent error (`bench/pilot/refusals.js` extracts them; labels go in `bench/pilot/mealie/labels/refusals.json`).

**Measured per chain, after item 10:**
- `eccode audit` on the whole record;
- record size;
- the latency of `status`, `metrics` and `audit`;
- `metrics` per track;
- incremental index time per item;
- lessons recorded in earlier items, and whether a later item's brief or agent read them.

### Part C: greenfield companion, `mealie-planner`

A new Node/TypeScript service, in its own fresh repository. It reads recipes and foods from Mealie's REST API, builds a weekly meal plan from rules, and produces a merged shopping list with unit conversion. It stores plans in SQLite through SQL migrations and serves an Express API.

**Fixed in advance, committed before any run** (`bench/suites/planner/`, all ours, MIT):
- `SPEC.md`: the request a user would give: endpoints, behavior, data rules.
- `fake-mealie/`: a small Express server serving synthetic recipe data that follows Mealie's documented API shapes.
- `hidden/`: a black-box acceptance suite against the built service, with the fake API running.
- Two follow-up requests on the same record:
  - **C2**, a feature: dietary filters;
  - **C3**, a schema change: plans gain households, through a new migration, without editing old ones.

**Runs:**
- `engine`: 2 chains of C1 (greenfield track: architecture → design → plan → phases → verification), then C2 (feature track), then C3 (feature track);
- `bare`: C1 to C3 twice, each item continuing the bare agent's own previous output.

That is 12 runs. This part covers what Part B cannot:
- the greenfield gates;
- Express route compat;
- destructive-SQL detection in a codebase the agent shapes itself.

## 4. Components to build

Each unit has one job and is tested on its own.

1. **`lib/bench.js`, hidden files from source.**
   - `hidden.fromSource: {commit, paths}` exports those paths from the task's mirror at `commit` and places them after the agent finishes.
   - Tests: export, missing path, a path the agent also wrote.
2. **`lib/bench.js`, chain mode.**
   - `--chain` keeps one sandbox and record.
   - `syncSource` replaces the tracked tree, keeps `.eccode/` and `.claude/`, and commits.
   - Hidden checks run in a throwaway copy.
   - A per-item `setup` step.
   - A chain summary: audit, record size, command latency, metrics, lessons.
   - Tests with a three-item fake chain and the scripted fake agent.
3. **`lib/bench.js`, transcripts.** `--transcripts <dir>` copies each run's Claude session files (located by the sandbox path) to a directory outside the repository.
4. **`bench/pilot/refusals.js`.** Extracts every ECCode refusal from transcripts: command, message, actor. Tested on a fixture transcript.
5. **`bench/pilot/mealie/` Part A scripts.**
   - Scripts: `a1-index.js`, `a2-impact.js` (with `coverage-map.py`), `a3-compat.js` (with `fastapi-routes.py`), `a4-fixverify.js`, `a5-mutate.js`, `a6-bugs.js`, `a7-stack.js`, and `report.js`.
   - Each reads only the mirror and the venv and writes `results/<name>.json`.
   - Unit tests run each script's pure logic (sampling, recall and precision, label joins) on small fixtures.
6. **`bench/suites/mealie/`.**
   - `_tools/select.py`, `_tools/setup.sh` (uv venv for Python 3.12, `python-ldap` handling, node at the pin's lockfile), `_tools/prompts.json` and the ten task directories.
   - Tests:
     - no prompt contains a line of its fix;
     - every task's hidden check fails at its source commit and passes at the fix commit (live validation, gated by an environment variable as for the real-bug suite).
7. **`bench/suites/planner/`.**
   - Contents: `SPEC.md`, `fake-mealie/`, `hidden/` and the three requests.
   - A test runs the hidden suite against a reference implementation kept outside the agent's view (`reference/`, ours). This proves the suite passes for a correct service and fails for an empty one.
8. **Protocol, report, register, docs.**
   - Protocol: `bench/protocols/<registration date>-mealie-pilot.md`, dated the day it is pushed.
   - Reports: `bench/pilot/mealie/results/` and `bench/pilot-results/`.
   - Register rows for every finding; an addendum to `docs/senior-engineering.md` and `docs/final-report.md`; the evaluation page updated.

## 5. Environment

- **Python:** uv-managed Python 3.12. Packages come from the pin's `uv.lock` through the proxy.
- **`python-ldap`:** it needs `libldap2-dev` and `libsasl2-dev`. Order of preference:
  1. install the headers with apt;
  2. otherwise install a stub `ldap` module, only if every test that imports it mocks it;
  3. otherwise exclude the LDAP tests from every check.
  Whichever applies is disclosed in the protocol.
- **Node:** Node 22 with the package manager the pin's lockfile names (yarn at P).
- **Mirror:** under `ECCODE_BENCH_CACHE`. Venvs and `node_modules` caches live outside every sandbox.
- **`TMPDIR`:** short and outside any session scratchpad, so the warnings from register rows 67 and 70 stay silent.

## 6. Data flow

1. The upstream mirror and the pinned commits are exported into a sandbox. ECCode is installed, and the agent runs.
2. Hidden tests are exported from the mirror into a throwaway copy, and the checks run.
3. The run record (JSONL, with patch and usage) is written, plus transcripts outside the repository.
4. Analysis scripts read those records and the Part A JSON, and write the markdown reports that are committed.
5. Labels are written by hand as JSON with reasons, are committed, and are joined to the detections by id.

## 7. Error handling and honesty rules

- **One batch.** A run that fails for an infrastructure reason (API error, timeout, no result line) stays in the results as a failure. A sensitivity analysis without never-started sessions is reported next to the primary one.
- **A chain that dies mid-way** is not restarted. Its remaining items count as not delivered, and the cause is reported.
- **A defect found while runs are under way** is fixed after the batch, unless it invalidates every variant alike. In that case the batch stops, the protocol gets a dated amendment listing every finished run, and the batch restarts. That is the rule the real-bug batch used.
- **Part A's measured run is reported verbatim.** Fixes made after it are measured in a second, "after" run, reported next to the first. The "before" run is never replaced.
- **Labels** are written before the summary figures are computed. Every "false positive" label carries the reason.

## 8. Pre-registered criteria: "works at the scale of a real project"

| Capability | Measure | Criterion |
|---|---|---|
| Index (A1) | Intra-project imports resolved | Python ≥ 95%; TS/JS ≥ 90%; every unresolved import listed |
| Index (A1) | Wall time on P | cold ≤ 120 s; warm ≤ 10 s; one-file edit ≤ 10 s |
| Impact (A2) | Median recall against coverage over 40 modules | static ≥ 0.90; with `--trace` ≥ 0.95 |
| Impact (A2) | Median selected share of all test files | ≤ 0.5 (an answer that selects everything is useless) |
| Impact (A2) | Recall against injected faults (10 modules) | ≥ 0.90 |
| Compat (A3) | Precision of detections over W | ≥ 0.90 |
| Compat (A3) | Recall against FastAPI's route table (20 commits) | ≥ 0.90 |
| `fix verify` (A4) | Agreement with running the tests directly | 100%; every disagreement is a defect |
| `mutate` (A5) | Runs completing within the timeout | ≥ 90% |
| Bug rules (A6) | False positives per 10,000 changed lines | ≤ 1 |
| Stack (A7) | Detected checks runnable, result equal to the tool run directly | all |
| Secrets (A7) | Error-level false positives on P | ≤ 5, each labelled |
| Tracks (B) | Engine items delivered with a clean audit | ≥ 80% per chain; zero audit failures |
| Friction (B, C) | False refusals (ECCode wrong) | ≤ 1 per item on average; each one a register row |
| Long-lived record (B) | After 10 items | audit clean; `status`, `metrics` and `audit` each ≤ 2 s; at least one lesson recorded and surfaced in a later item |
| MCP (B) | Item 3 with no shell | delivered with a clean audit in ≥ 1 of 2 |
| Greenfield (C) | Gates in order; C1 to C3 delivered | every gate passes in order in both chains; C3 adds a migration without editing an old one |
| Correctness (B, C) | Hidden-check pass rate, engine against bare | reported with the stratified permutation test by item; no criterion (underpowered) |
| Cost (B, C) | Median cost per item, engine over bare, per track | reported |

## 9. Budget and stopping

- About $80–160 of Sonnet usage across the 54 agent runs (42 in Part B, 12 in Part C), and 4–6 hours of CPU for Part A.
- A hard ceiling of $250: if it is reached, the batch stops, and what ran is reported as a partial batch with the stop disclosed.
- One batch. These items are not sampled again with Sonnet in these variants.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `python-ldap` cannot build | the fallbacks in section 5, disclosed |
| The full backend suite is slow, which limits A2's fault injection | 10 faults at about one suite run each; coverage contexts run once |
| Long sessions on a large repository cost more | timeout 3,600 s; the budget ceiling |
| An item's tests are flaky | pools require pass/fail at parent and commit on two consecutive runs |
| The frontend toolchain at the pin fails to install | item 8 and frontend A2 are reported as not run, with the cause; the rest of the pilot stands |
| The model has seen Mealie's history | it affects every variant alike; the chain still tests capabilities, not recall of fixes |

## 11. Deliverables

- **Reports:** `bench/pilot/mealie/results/*.json` plus `bench/pilot-results/<registration date>-mealie-pilot.md`, the verbatim report with every criterion and its result.
- **Run records** (JSONL), with scratch paths shortened.
- **Register rows** for every finding, and fixes for the defects, each with a test.
- **Docs:** `docs/senior-engineering.md` ("On a real project") and `docs/final-report.md` addendum.
- **Evaluation page:** the "helps on real projects" item moves from "not proven" to what the pilot showed.
