# Big-Project Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run every ECCode capability on Mealie (a real codebase of about 145k lines) and on a greenfield companion service. Each capability is measured against a pre-registered criterion and reported verbatim.

**Architecture:** Three parts.
- **Part A:** model-free measurement scripts read a local Mealie mirror and write JSON.
- **Part B:** the bench harness gains hidden files exported from the mirror, per-task tracks, a chain mode (one sandbox and record across work items, synced to upstream between them) and transcript capture. These run ten real changes.
- **Part C:** a new suite, fully ours, for the greenfield track.

A protocol is pushed before any measured run. Reports are generated from the saved runs.

**Tech Stack:**
- Node ≥ 18 (ECCode, `node --test`, no new dependencies);
- Python 3.12 via uv (Mealie, pytest, coverage.py);
- yarn/vitest (Mealie frontend);
- Express plus SQLite through `node:sqlite` or better-sqlite3, decided in Task 11 (planner reference only);
- `claude -p` (Sonnet).

**Spec:** `docs/specs/2026-10-24-big-project-pilot-design.md`

## Global Constraints

- **Mealie pin and window:** pin P = v3.20.0 = `dbe84cc91b9e1dfc88b783a1e31d8a8495800337`. Window W = `v3.20.0..v3.27.0` (`dedc6cc7…`), 410 commits. Development runs use v3.18.0.
- **No Mealie file is committed to this repository** (Mealie is AGPL-3.0, ECCode is MIT).
  - Tasks reference commits.
  - Hidden files are exported from the mirror at run time.
  - Reports quote names, counts and ECCode messages only.
  - Transcripts stay outside the repository.
- **Seeds:** 42 for every draw.
- **Runs:** Sonnet (`--model sonnet`), timeout 3,600 s per item, toolkit profile `guard`, subagents `inherit`.
- **Run counts:**
  - Part B: 2 engine chains of 10 items, 2 bare runs per item, 2 MCP runs of item 3 (42 runs);
  - Part C: 2 engine chains of C1 to C3 and 2 bare chains (12 runs).
- **Budget:** hard ceiling $250; when it is reached, stop and report a partial batch.
- **Criteria:** exactly as in spec section 8; reports compare against those numbers verbatim.
- **Commits:** end with the two trailer lines.
  - `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  - `Claude-Session: https://claude.ai/code/session_01LqLcGkdNUd7GVqRf7XFDsr`
  - No model identifiers in committed files; the aliases `sonnet`/`opus` in commands are fine.
- **Paths:** scratch paths appear as `<scratch>` in committed files. `TMPDIR` is short (under 60 characters) and outside any session scratchpad.
- **Tests and CI:** `npm test` stays green; new live tests are gated by environment variables (`ECCODE_MEALIE_VALIDATE=1`) as the real-bug suite's are.

## Review Focus

1. **Hidden file collides with the agent's file:** an agent writes a test at the same path as an upstream hidden test. The hidden version must win in the check copy and must never reach the next chain item. *(Task 2 test `fromSource overwrites the agent's file`, Task 4 test `hidden files never reach the next item`.)*
2. **Upstream renames or deletes a file the previous item touched:** the sync must leave exactly the upstream tree plus `.eccode/` and `.claude/`. No stale agent file may survive. *(Task 4 test `sync removes files upstream does not have`.)*
3. **Agent leaves the record mid-work-item, for example on a timeout:** the next item must still start. The harness records the stuck item as undelivered and runs `eccode recover --all` before the next sync. It never abandons the work item as the user. *(Task 4 test `a timed-out item leaves the next one runnable`.)*
4. **The upstream tree already has `.claude/` or `.eccode/`:** syncing must refuse loudly rather than overwrite the toolkit or record. *(Task 4 test `sync refuses a source tree with .claude or .eccode`.)*
5. **A Part A script hits a commit it cannot process** (a merge commit, a binary-only change, a test command that times out): the script records the commit as skipped, with the reason. It never drops it silently and never crashes the whole replay. *(Task 6 test `replay records skips with reasons`.)*

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/bench.js` (modify) | `exportPaths`; `placeHidden` reads `task.hidden.fromSource`; `enginePrompt(variant, track)`; `--transcripts`; exports for the chain module |
| `lib/chain.js` (create) | `syncSource`, `runChainItem`, `runChain`, `chainSummary`: one sandbox and record across items |
| `bin/eccode.js` (modify) | `bench --chain`, `--transcripts <dir>`, `--max-cost <usd>` |
| `bench/pilot/refusals.js` (create) | Extract ECCode refusals from Claude transcripts |
| `bench/pilot/lib.js` (create) | Shared Part A helpers: mirror tree export, commit listing, seeded sampling, recall/precision |
| `bench/pilot/mealie/a1-index.js` … `a7-stack.js`, `coverage-map.py`, `fastapi-routes.py`, `report.js` (create) | Part A measurements and report |
| `bench/pilot/mealie/labels/*.json` (create during analysis) | Hand labels with reasons |
| `bench/suites/mealie/_tools/{env.js,setup.sh,select.py,prompts.json,selection.json}` (create) | Environments, item selection, prompts |
| `bench/suites/mealie/<id>/task.json` (create, ×10) | Items: source, track, prompt, hidden fromSource, checks |
| `bench/suites/planner/{SPEC.md,fake-mealie/,hidden/,reference/,c1,c2,c3}` (create) | Greenfield suite |
| `tests/pilot.test.js` (create) | Tests for the harness additions, refusals, Part A pure logic, planner suite |
| `tests/mealie.test.js` (create) | Mealie suite structure and leak tests; live validation gated |
| `bench/protocols/<date>-mealie-pilot.md` (create) | Pre-registration |
| `bench/pilot-results/…`, `docs/limits.md`, `docs/senior-engineering.md`, `docs/final-report.md`, `NOTICE` (create or modify) | Results and documentation |

---

### Task 1: Mealie environments and mirror

**Files:**
- Create: `bench/suites/mealie/_tools/env.js`, `bench/suites/mealie/_tools/setup.sh`, `bench/suites/mealie/README.md`
- Test: `tests/mealie.test.js`

**Interfaces:**
- Produces:
  - `envKey(lockText: string) -> string`, the first 12 hex characters of sha256;
  - `pythonEnv(tree: string, { envs = process.env.ECCODE_MEALIE_ENVS } = {}) -> string`, an absolute venv path, created with `uv sync --frozen --python 3.12` and `UV_PROJECT_ENVIRONMENT` when missing;
  - `nodeModules(tree, { envs }) -> string`, the absolute path of a cached `node_modules` for `frontend/yarn.lock`, symlinked into the tree's `frontend/`;
  - `taskEnvVars(venv) -> {PATH, VIRTUAL_ENV, UV_PROJECT_ENVIRONMENT, PYTHONDONTWRITEBYTECODE: '1'}`.
- Consumes: `bench.exportSource(source, dest)` and `bench.cacheDir()`.

- [ ] **Step 1: Write the failing test.** `envKey is stable and 12 hex characters`: `envKey('a')` equals `envKey('a')`, matches `/^[0-9a-f]{12}$/` and differs from `envKey('b')`.
- [ ] **Step 2: Run** `node --test tests/mealie.test.js`. Expected: FAIL, cannot find module `env.js`.
- [ ] **Step 3: Implement `env.js`.**
  - `pythonEnv` runs `uv sync --frozen --python 3.12 --no-install-project` and then `uv pip install -e . --no-deps`, both in `tree` with `UV_PROJECT_ENVIRONMENT=<envs>/py-<key>`.
  - `setup.sh` handles `python-ldap` in the order of spec section 5:
    1. `apt-get install -y libldap2-dev libsasl2-dev`;
    2. otherwise a stub `ldap` package, used only if `git grep -l "import ldap" tests/` shows only mocked usage;
    3. otherwise deselect the LDAP tests.
  - It writes which path it took to `<envs>/ldap-mode.txt`.
- [ ] **Step 4: Run** `node --test tests/mealie.test.js`. Expected: PASS.
- [ ] **Step 5: Live check.**
  - Run `ECCODE_MEALIE_ENVS=$HOME/.cache/eccode/mealie-envs sh bench/suites/mealie/_tools/setup.sh v3.18.0`.
  - Then run `pytest -q -x tests/unit_tests` in the exported tree with that venv.
  - Expected: the venv path printed, the LDAP mode printed, and the unit tests passing (or failures listed, which become a disclosed exclusion).
- [ ] **Step 6: Commit** `bench/suites/mealie/_tools/env.js setup.sh README.md tests/mealie.test.js` as "bench: Mealie environments (uv venv per lockfile, python-ldap fallbacks)".

### Task 2: Hidden files exported from the source mirror, and task setup

**Files:**
- Modify: `lib/bench.js` (add `exportPaths` and `runSetup`, extend `placeHidden`, call `runSetup` in `runOnce`, export all three)
- Test: `tests/pilot.test.js`

**Interfaces:**
- Produces:
  - `exportPaths(source: {repo, commit}, paths: string[], dest: string) -> string[]`, the paths written, and only those. It throws `NOT_FOUND` naming any path absent at `commit`.
  - `placeHidden(task, sandbox)`: when `task.hidden && task.hidden.fromSource` is `{commit, paths}`, it writes those files **at their own paths in the sandbox**, overwriting the agent's files. It does this after the existing `_hidden` and `hidden/` copies.
  - `runSetup(task, sandbox, env) -> {ok: boolean, ms: number, tail: string}`:
    - runs `task.setup`, a shell command, in the sandbox after materialize and before the fixture commit;
    - uses the task env plus `ECCODE_BENCH_TASK_DIR=<task.dir>`, so a setup can call its suite's tools;
    - a failure records `setup: {ok: false, tail}` and skips the agent, and the run counts as a failure.
- Consumes: the private-index export pattern of `exportSource`, with `read-tree` then `checkout-index` limited to `paths`.

- [ ] **Step 1: Write the failing tests** in `tests/pilot.test.js`, using a local bare repo built in the test, with two commits:
  - `exportPaths writes only the named files at the commit`;
  - `fromSource overwrites the agent's file`: the sandbox has `tests/test_x.py` with "agent", and the source commit has "upstream". After `placeHidden` the file reads "upstream";
  - `exportPaths names a missing path`: `assert.throws(..., /tests\/nope\.py/)`;
  - `task.setup runs before the agent with ECCODE_BENCH_TASK_DIR`: the setup writes `$ECCODE_BENCH_TASK_DIR` into a file, and the fake agent reads it;
  - `a failing setup skips the agent`: `record.setup.ok === false`, and the agent's marker file is absent.
- [ ] **Step 2: Run** `node --test tests/pilot.test.js`. Expected: FAIL, `exportPaths is not a function`.
- [ ] **Step 3: Implement `exportPaths`, `runSetup` and the `placeHidden` branch in `lib/bench.js`.**
- [ ] **Step 4: Run** `node --test tests/pilot.test.js tests/bench.test.js tests/realbugs.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** as "bench: hidden files exported from the source mirror (no third-party file in the repo), task setup".

### Task 3: Per-task tracks in engine prompts

**Files:**
- Modify: `lib/bench.js` (`enginePrompt`, `runOnce`)
- Test: `tests/pilot.test.js`

**Interfaces:**
- Produces: `enginePrompt(variant = 'engine', track = null) -> string`.
  - `track` comes from `task.track` and is one of `quick | debug | fix | feature | refactor | greenfield`.
  - `quick` and `debug` keep the current texts exactly.
  - The other tracks name `.claude/commands/eccode/start.md` and the track. They tell the agent:
    - when `.eccode/` already holds a delivered work item, start the next one with `work start --track <track> --title "<title>" --actor orchestrator`;
    - for `refactor`, add `--behavior "<task.behavior>"`.
  - `runOnce` passes `task.track || ENGINE_VARIANTS[variant]`.
  - The record's `engine.track` is the track used.

- [ ] **Step 1: Write the failing tests:**
  - `enginePrompt keeps the quick and debug texts`: equality with the current strings;
  - `enginePrompt names start.md and the track for fix, feature, refactor and greenfield`, each matching `/start\.md/` and `--track <t>`;
  - `the refactor prompt names its behavior command`.
- [ ] **Step 2: Run** `node --test tests/pilot.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS (214 + new).
- [ ] **Step 5: Commit** as "bench: engine prompts for every track".

### Task 4: Chain mode

**Files:**
- Create: `lib/chain.js`, `tests/bench-reference/chain/fake-chain-agent.js`, and three fake tasks under `tests/bench-reference/chain/suite/`
- Modify: `bin/eccode.js` (`bench --chain`), `lib/bench.js` (export `git`, `TOOLING`, `PATCH_LIMIT`, `depsOf`, `engineOutcome`, `usageOf`, `commandEnv` use)
- Test: `tests/pilot.test.js`

**Interfaces:**
- Produces:
  - `syncSource(task, sandbox) -> {commit: string, removed: number, written: number}`:
    - deletes every file listed by `git ls-files` that is not under `.eccode/` or `.claude/`;
    - exports `task.source`, then copies `task.dir/fixture` if it exists;
    - commits `upstream: <sha>`.
    - It throws `INVALID_INPUT` when the source tree contains `.claude/` or `.eccode/`.
  - `runChainItem(task, sandbox, { agentCmd, variant, timeoutMs, transcripts, first }) -> record`:
    - the same record shape as `runOnce`, plus `chain: {index, sync}`;
    - hidden checks run in `fs.mkdtempSync` copy of the sandbox, which is deleted afterwards;
    - after the checks, the sandbox commits `work item: <task.id>`;
    - on `first` with an engine variant, it installs the toolkit as `runOnce` does;
    - after the sync it calls Task 2's `runSetup`;
    - on engine chains it times a warm `node .claude/eccode/bin/eccode.js onboard --json` as `chain.indexMs`, the incremental index time per item.
  - `runChain(tasks, opts) -> {records: record[], summary}`, which runs the items in the given order on one sandbox.
  - `chainSummary(sandbox) -> {auditOk, events, recordBytes, latencyMs: {status, metrics, audit}, metrics, lessons: string[]}`, read through the installed CLI.
  - CLI `eccode bench --suite <dir> --chain --variant engine --runs <n>`:
    - `--runs` counts chains;
    - the task order is `task.order`, then the directory name;
    - `--save` appends records and a `{type: 'chain-summary', chain: k, ...}` line.
  - CLI `--max-cost <usd>`, for `bench` with or without `--chain`: before each run, if the sum of `usage.costUsd` of this process's records reaches the cap, the process stops. It writes `{type: 'stopped', reason: 'max-cost', spentUsd}` to `--save` and exits non-zero.
- Consumes: Task 2's `placeHidden`, Task 3's `enginePrompt(variant, task.track)` and `exportSource`.

- [ ] **Step 1: Write the fake chain agent.** A scripted agent like `fake-debug-agent.js`:
  - item 1 runs `eccode quick`;
  - items 2 and 3 run `work start --track quick`;
  - each item edits one file, records evidence, gets one review and delivers;
  - it reads the item's id from `PROMPT.md`;
  - it prints a result line.
- [ ] **Step 2: Write the failing tests:**
  - `a chain delivers three items on one record, audit clean`: three records, each `engine.delivered === true`, and `summary.auditOk === true`;
  - `sync removes files upstream does not have`: item 1's agent adds `extra.txt`, which is absent after sync 2;
  - `hidden files never reach the next item`: item 1's hidden file is absent from the sandbox at item 2's start;
  - `sync refuses a source tree with .claude or .eccode`;
  - `a timed-out item leaves the next one runnable`: the fake agent sleeps past `timeoutMs` on item 2, which is recorded undelivered, and item 3 is delivered (the harness ran `recover --all` before syncing);
  - `the chain summary times status, metrics and audit`, all three latencies being numbers;
  - `--max-cost stops before the next run once the cap is reached`: the fake agent reports $0.2 per run, with a cap of 0.3, gives two records and a `stopped` line.
- [ ] **Step 3: Run** `node --test tests/pilot.test.js`. Expected: FAIL, cannot find module `../lib/chain`.
- [ ] **Step 4: Implement `lib/chain.js` and the CLI flag.**
  - Between items, the harness calls `node .claude/eccode/bin/eccode.js recover --all --actor orchestrator` when `status --json` shows open runs.
  - It never abandons a work item.
- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** as "bench: chain mode (one sandbox and record across work items, synced to upstream between them)".

### Task 5: Transcripts and refusal extraction

**Files:**
- Modify: `lib/bench.js` (`--transcripts` in `runOnce` and `runChainItem`)
- Create: `bench/pilot/refusals.js`, `tests/bench-reference/transcripts/refusals.jsonl` (a synthetic fixture, ours)
- Test: `tests/pilot.test.js`

**Interfaces:**
- Produces:
  - `transcriptDir(sandbox) -> string`, which is `~/.claude/projects/` plus `sandbox.replace(/[^a-zA-Z0-9]/g, '-')`;
  - `copyTranscripts(sandbox, dest, sinceMs) -> string[]`, which copies the session files modified after `sinceMs`;
  - `extractRefusals(jsonlText) -> Array<{id, command, message, code}>`:
    - one entry per tool result from `node .claude/eccode/bin/eccode.js …` with a non-zero exit, or text starting `Refused:` or holding a `[A-Z_]+:` ECCode error code;
    - `id` is `<session>:<line>`.
  - CLI: `node bench/pilot/refusals.js <dir> > refusals.json`.

- [ ] **Step 1: Write the failing tests:**
  - `transcriptDir encodes like Claude Code`: `/tmp/a.b/c` becomes `~/.claude/projects/-tmp-a-b-c`;
  - `extractRefusals finds the refusals in the fixture and nothing else`, with exact `code` values from the fixture (`TRACK_RULE`, `NOT_OWNER`) and an exact count.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** as "bench: keep transcripts outside the repo; extract ECCode refusals".

### Task 6: Part A shared helpers and A1 (index)

**Files:**
- Create: `bench/pilot/lib.js`, `bench/pilot/mealie/a1-index.js`
- Test: `tests/pilot.test.js`

**Interfaces:**
- Produces, in `bench/pilot/lib.js`:
  - `treeAt(repoUrl, commit, dest)`, a wrapper over `bench.exportSource`;
  - `commitsIn(mirror, range) -> Array<{sha, parent, subject, files: Array<{status, path}>}>`, first-parent, merges marked `merge: true`;
  - `sample(items, k, seed = 42, strata = null) -> items[]`, a seeded stratified draw using the bench's `mulberry32`;
  - `recallPrecision(predicted: Set, truth: Set) -> {recall, precision, tp, fp, fn}`, where an empty truth gives `recall: null`;
  - `replay(items, fn) -> {results, skipped: Array<{id, reason}>}`, which catches per-item errors into `skipped`;
  - `writeResult(name, obj)`, which writes `bench/pilot/mealie/results/<name>.json` with scratch paths replaced by `<scratch>`.
- Produces, in `a1-index.js`: a CLI `node bench/pilot/mealie/a1-index.js <commit>` writing `results/a1-index.json` with:
  - `{coldMs, warmMs, editMs, byLang, imports: {python: {resolved, unresolved, rate, unresolvedList}, ts: {...}}, dynamicLoaders}`;
  - intra-project imports defined exactly as in spec A1.
- Consumes: `codebase.indexProject`, `codebase.importSpecs` and `codebase.resolveSpec`.

- [ ] **Step 1: Write the failing tests:**
  - `sample is seeded and stratified`: the same seed gives the same draw, and each stratum gets ⌊k/strata⌋ or more;
  - `recallPrecision on known sets`, e.g. `{a,b,c}` against `{b,c,d}` gives recall 2/3 and precision 2/3;
  - `replay records skips with reasons`: a function throwing for one item gives one `skipped` entry with its message, and the others are in `results`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement `lib.js` and `a1-index.js`.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Then the development run: `node bench/pilot/mealie/a1-index.js <v3.18.0 sha>`. Expected: the JSON written, with resolution rates printed.
- [ ] **Step 5: Commit** the helpers and A1, without development results.

### Task 7: A2 (impact against coverage and injected faults)

**Files:**
- Create: `bench/pilot/mealie/a2-impact.js`, `bench/pilot/mealie/coverage-map.py`
- Test: `tests/pilot.test.js` (pure logic only)

**Interfaces:**
- Produces:
  - `coverage-map.py <tree> <out.json>`:
    - runs `coverage run --context=test -m pytest -q -p no:cacheprovider` in `tree`, with the venv;
    - writes `{module: [test files]}` from `coverage.CoverageData.contexts_by_lineno`.
  - `a2-impact.js <commit>` writes `results/a2-impact.json` with:
    - `{sample: [{module, stratum, truth, static: {…recallPrecision, selectedShare}, trace: {…}}], faults: [{module, failingTests, predicted, recall}], frontend: [...], excludedUncovered}`;
    - medians per measure.
  - A pure `testFilesFromContexts(contexts: string[]) -> Set<string>`, which turns `tests/x/test_y.py::test_z|run` into `tests/x/test_y.py`.
- Consumes: `codebase.impact`, `codebase.traceRun`, Task 6 helpers, Task 1 `pythonEnv` and `nodeModules`.

- [ ] **Step 1: Write the failing test.** `testFilesFromContexts strips test ids and phases`: three context strings give two files.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Strata are the spec's: `routes`, `services`, `repos`, `db/models`, `schema`, `core`, other.
  - Each fault prepends `raise RuntimeError("eccode-pilot fault")` to the module and runs the full suite with `--junitxml`. Failing test files come from the junit output, and the tree is restored after each fault.
  - Frontend: run each spec file alone under `vitest run --coverage --coverage.reporter=json` and map it to the modules it covers.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Development run at v3.18.0 with `--sample 5 --faults 1`. Expected: a JSON with non-null recall for the covered modules.
- [ ] **Step 5: Commit.**

### Task 8: A3 (compat replay and FastAPI route recall)

**Files:**
- Create: `bench/pilot/mealie/a3-compat.js`, `bench/pilot/mealie/fastapi-routes.py`
- Test: `tests/pilot.test.js`

**Interfaces:**
- Produces:
  - `detectBetween(parentDir, commitDir, files: string[]) -> found[]`: `compat.snapshot(parentDir, files)`, then `compat.detect(commitDir, base, files)`, limited to the files the commit touches. Each entry gets `id: <sha>:<kind>:<name>`.
  - `a3-compat.js <range>` writes `results/a3-compat.json`: `{commits, detections: [{id, sha, kind, name, detail}], skipped, routeRecall: {sample: [{sha, removedTruth, detected, missed}], recall}}`.
  - `fastapi-routes.py <tree>` prints sorted `"METHOD /path"` lines from `mealie.app.app.routes`, imported with the venv.
- Consumes: `compat.snapshot`, `compat.detect`, Task 6 `commitsIn`, `treeAt` and `replay`.

- [ ] **Step 1: Write the failing test.** `detectBetween finds a route moved between files as a removal from the old file`: two temporary trees, where the route `GET /a` moves from `r1.py` to `r2.py`. The test asserts one `route` detection. This pins the per-file behaviour that A3 will measure.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.** Only the changed files are exported at both sides. The route sample has 20 commits touching `mealie/routes`, drawn with seed 42.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Development run on `v3.18.0~30..v3.18.0`. Expected: a JSON with detections listed.
- [ ] **Step 5: Commit.**

### Task 9: A4 to A7 (fix verify, mutate, bug rules, stack and secrets) and the Part A report

**Files:**
- Create: `bench/pilot/mealie/a4-fixverify.js`, `a5-mutate.js`, `a6-bugs.js`, `a7-stack.js`, `report.js`
- Test: `tests/pilot.test.js`

**Interfaces:**
- Produces:
  - `fixPopulation(commits) -> commits`: `fix:` subjects that are not `fix(deps)`, touching `mealie/` and `tests/`.
  - `a4-fixverify.js <range>`. For each commit, a scratch repo is built:
    - the parent tree is committed as base, then the commit's tree is written over it;
    - `eccode quick "<subject>" --actor orchestrator --files "**" --command "<pytest of the changed test files>"` runs, then a claim;
    - the verdict comes from `eccode fix verify --base <base> --actor <owner> --json`;
    - the direct ground truth is the same pytest at the parent with the new tests, and at the commit.
    - It writes `{rows: [{sha, verdict, direct: {pre, post}, agree, ms}], agreement, skipped}`.
  - `a5-mutate.js <range>`: in the same scratch repos, `mutate.run(root, {test, base})` gives `{rows: [{sha, lines, total, killed, timeouts, ms, error}], completedShare}`.
  - `a6-bugs.js <range>`: `bugs.scan(commitDir, {base: parent})` per commit gives `{hits: [{id, sha, file, line, rule, text}], changedLines, perTenK}`.
  - `a7-stack.js <commit>`: `stack.detect`, `stack.checks`, each `stack.runCheck` result against the same tool run directly, and `stack.scanSecrets` hits.
  - `report.js` reads `results/*.json` and the `labels/*.json` files. It writes `bench/pilot-results/<date>-mealie-part-a.md`: one table row per spec criterion, with measure, criterion, result, and met or missed.
- Consumes: Task 6 helpers and `fixverify.verify` through the CLI.

- [ ] **Step 1: Write the failing tests:**
  - `fixPopulation keeps code fixes with tests and drops dependency bumps`;
  - `report marks a criterion met or missed from a results fixture`: a recall of 0.92 against a threshold of 0.90 is met, and 0.85 is missed.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement the four scripts and the report.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Development run of each script on a 30-commit range ending at v3.18.0. Expected: JSON files, and a report listing every criterion.
- [ ] **Step 5: Commit.**

### Task 10: Mealie work items (selection, prompts, tasks, refactor item)

**Files:**
- Create: `bench/suites/mealie/_tools/select.py`, `prompts.json`, `selection.json`, and ten `bench/suites/mealie/<id>/task.json`
- Modify: `tests/mealie.test.js`

**Interfaces:**
- Produces: `task.json` fields:
  - `{id, title, order, track, source: {repo, commit: <parent>}, fixCommit, behavior?, env, setup, prompt, hidden: {fromSource: {commit: <fix>, paths}}, hiddenChecks: [{id: 'target', command}, {id: 'regression', command}], measured}`;
  - `measured` records the counts that the pre-fix and fixed runs showed.
- `select.py` implements the pools of spec Part B:
  - candidates are validated live, on two consecutive runs each;
  - draws are in pool order with seed 42;
  - skips are recorded with reasons in `selection.json`.
- The refactor item (`order` by its base commit) names its duplicated code by file and function in the prompt. Its hidden checks are:
  - the full backend suite as `regression`;
  - a `target` check, ours, that the duplicated function bodies are gone. It is an AST check script in `bench/suites/mealie/_hidden/` and contains no Mealie code.
- Consumes: Task 1 env and Task 2 fromSource.

- [ ] **Step 1: Write the failing tests:**
  - `ten tasks, each with a track from the allowed set and the ten categories covered`;
  - `no prompt contains a line of its fix`: for each task, the lines added by `git diff <source> <fixCommit>` from the mirror are absent from the prompt. Gated by the mirror being present; skipped with a message otherwise;
  - `live: each target check fails at the source and passes at the fix commit`, gated by `ECCODE_MEALIE_VALIDATE=1`.
- [ ] **Step 2: Run** `node --test tests/mealie.test.js`. Expected: FAIL.
- [ ] **Step 3: Run the selection, write the prompts and tasks.** Prompts are written from the PR description and tests, in the realbugs style: symptom, example, expected behavior, test command, and known failures named.
- [ ] **Step 4: Run** `ECCODE_MEALIE_VALIDATE=1 node --test tests/mealie.test.js`. Expected: PASS.
- [ ] **Step 5: Commit**, with `selection.json` and no Mealie file.

### Task 11: The planner suite (greenfield)

**Files:**
- Create: `bench/suites/planner/SPEC.md`, `fake-mealie/server.js`, `fake-mealie/data.json` (synthetic), `hidden/acceptance.test.js`, `reference/` (ours), `c1/task.json`, `c2/task.json`, `c3/task.json`
- Test: `tests/pilot.test.js`

**Interfaces:**
- Produces:
  - `fake-mealie/server.js` exports `start({port = 0}) -> Promise<{url, close}>`. It serves `GET /api/recipes?page=&perPage=`, `GET /api/recipes/{slug}` and `GET /api/foods`, shaped like Mealie's documented responses, from `data.json`.
  - The planner contract from `SPEC.md`:
    - `POST /plans {weekStart, rules}` returns 201 with the plan;
    - `GET /plans/:id`;
    - `GET /plans/:id/shopping-list` gives units merged and converted;
    - C2 adds `rules.diet: ['vegetarian' | 'gluten-free' | ...]`;
    - C3 adds households: `POST /households`, and plans get `householdId`, through a new migration file under `migrations/`.
  - `hidden/acceptance.test.js` reads `PLANNER_URL` and `MEALIE_URL`. It has tests tagged `c1:`, `c2:` and `c3:`, so each item's check runs its own tags and the earlier ones.
  - Each item's check starts the fake API and the built service (`npm start` with `PORT=0` and the service printing its URL), then runs the acceptance tests.
- Consumes: the Task 3 track prompt (`greenfield` for C1, `feature` for C2 and C3) and Task 4 chain mode. Bare chains use chain mode with the `without` variant.

- [ ] **Step 1: Write the failing tests:**
  - `the acceptance suite passes against the reference`, with the reference started on a random port;
  - `the acceptance suite fails against an empty service`;
  - `c3's check refuses an edited old migration`: the reference with its first migration edited fails the `c3: migrations are append-only` test.
- [ ] **Step 2: Run** `node --test tests/pilot.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the fake API, the reference, the acceptance suite and the three tasks. The reference's SQLite choice is `node:sqlite` when Node ≥ 22.5 and better-sqlite3 otherwise. The reference never enters a sandbox.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 12: Pre-registration, measured runs, analysis, fixes, reporting

**Files:**
- Create:
  - `bench/protocols/<date>-mealie-pilot.md`;
  - `bench/pilot/mealie/results/*.json`, `bench/pilot/mealie/labels/*.json`;
  - `bench/pilot-results/<date>-mealie-pilot.md`;
  - `bench/pilot-results/<date>-mealie-pilot.runs.jsonl`.
- Modify: `docs/limits.md`, `docs/senior-engineering.md`, `docs/final-report.md`, `README.md`, `NOTICE` (Mealie is named as the subject, with its licence, and it is stated that no file of it is included), `tests/limits.test.js`, version bump

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the protocol.**
  - Contents: the spec's design, criteria, runs, budget, stop and honesty rules; the LDAP mode actually used; the ten selected items; the refactor item's disclosure.
  - Commit and push it **before any measured run**.
- [ ] **Step 2: Part A measured run at P.**
  - Run A1 to A7 at `dbe84cc9…` on the full range `v3.20.0..v3.27.0`.
  - Write the labels (compat detections, bug hits, secrets hits) with reasons before running `report.js`.
  - Commit results, labels and the Part A report verbatim.
- [ ] **Step 3: Launch Part B and Part C.**
  - Detached processes (`setsid nohup`) from a worktree pinned at the protocol commit, with `--save` and `--transcripts <outside the repo>`.
  - Processes:
    - `--chain --variant engine --runs 2`;
    - `--variant without --runs 2`;
    - item 3 with `--engine-profile no-shell --runs 2`;
    - the planner chains.
  - Each process gets a `--max-cost` share, and the shares sum to $250.
  - Monitor them with the Monitor tool. Disclose any stop as a dated amendment, per spec section 7.
- [ ] **Step 4: Analysis.**
  - Run `bench/pilot/refusals.js` over the transcripts and label each refusal.
  - Build the batch report with `bench report` from the saved runs, plus the chain summaries.
  - Compute the stratified test by item (engine against bare).
  - Commit everything verbatim.
- [ ] **Step 5: Findings and fixes.**
  - Each missed criterion or false refusal gets a register row.
  - Each defect gets a fix with a failing-first test.
  - Part A capabilities that changed are re-run at P as the "after" run, reported next to the "before" run.
- [ ] **Step 6: Documentation.**
  - The docs sections; a test in `tests/limits.test.js` checks the quoted figures against the results JSON, as for the real-bug figures.
  - Bump the version to 0.12.0.
  - Run `npm test`; expected: PASS.
- [ ] **Step 7: Ship.**
  - Commit, push, open the PR to `claude/keen-allen-5z33eb`, drive CI green and merge.
  - Update the evaluation page.
  - Report to the user.
