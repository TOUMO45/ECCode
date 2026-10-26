# Multi-file Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer, with a pre-registered test, whether the engine passes Mealie's hidden checks more often than a bare agent on large multi-file changes where the bare agent makes its own mistakes.

**Architecture:** The pilot's selector gains a `--large` draw, which builds a fourth Mealie suite (`mealie4`) with the existing builder and environments. A new analysis script reuses the proof run's tested functions.
- **Stage 1:** bare-only screening.
- **Labels.**
- **Stage 2:** 6 + 6 runs on at most 6 hard items.

The protocol is pushed before any measured run.

**Tech Stack:** Node ≥ 18 (`node --test`, no new dependencies), the existing `eccode bench` harness, Mealie environments under `/root/.cache/eccode/mealie-envs` (uv venvs, pnpm or yarn `node_modules`), and `claude -p --model sonnet` through `$AGENT_B`.

**Spec:** `docs/specs/2026-10-26-multifile-run-design.md`

## Global Constraints

- **No Mealie file is committed.**
  - Tasks name commits.
  - Hidden tests are exported from the mirror at run time.
  - Transcripts stay in `/tmp/mp/r4/`.
  - Committed reports write scratch paths as `<scratch>`.
- **Window:** `v3.20.0..753325676331cf8df48cae7c64ce634f2cb693cb`. **Fallback window:** `v3.10.0..v3.20.0`, drawn only if fewer than 12 candidates are accepted from the window.
- **Multi-file rule.** Counted files exclude tests, docs, translations and lockfiles; the selector's `NOT_COUNTED` applies.
  - at least 5 counted files;
  - at least 4 counted files under `mealie/`;
  - 100 to 1,500 counted lines;
  - a `fix`/`feat` subject, not `fix(deps)` and not a bump;
  - backend tests;
  - not an item of `mealie`, `mealie2` or `mealie3`.
- **Variants:** `without`, and `engine` with `--engine-profile guard --engine-agents inherit`. Model alias `sonnet`, `$AGENT_B` from `bench/pilot/agents-rerun.sh`, `--timeout 7200` for every run.
- **Stage 1:**
  - `--variant without --runs 3`, no engine runs;
  - processes `w1`–`w3` take contiguous thirds of the items in upstream order;
  - `--max-cost 20` each.
- **Hard item:** a stage-1 bare run failed and its failure is labelled `agent-error`. A timeout is labelled `harness`.
- **Stage 2:**
  - every hard item, or 6 drawn with `mulberry32(42)` when there are more than 6;
  - `--runs 6` per variant;
  - engine processes `s2e1`–`s2e3` take the chosen items round-robin in upstream order (`$35.70` ceiling per item each process runs);
  - bare process `s2w` takes all chosen items (`$5.95` per item);
  - stage 2 stays at or under $250.
- **Primary test:** `stratifiedTest` (items as strata, 20,000 resamples, seed 42, two-sided).
  - **Met:** the engine's share is higher, the difference is positive and p < 0.05.
  - **No verdict:** fewer than 3 hard items.
- **Secondary checks,** over stage-2 engine runs:
  - delivery at least 80% with a clean audit;
  - at most 1 false refusal per run.
- **Environment:** `TMPDIR=/tmp/mp`, `ECCODE_MEALIE_ENVS=/root/.cache/eccode/mealie-envs`. Runs go from a worktree `/tmp/mp/wt4` pinned at the protocol commit.
- **Engine:** no change after the pool is drawn. `bench/pilot/proof.js` stays unchanged.
- **Commits:** every commit message ends with the session's two trailer lines. Never force-push. Name no model identifier in commits or files.

## Review Focus

1. **A stage-2 ceiling stops a process mid-item,** leaving an item with runs of one variant only. The analysis must still compute the test over the items that have both, and report the rest as not run (Task 2 test).
2. **The stage-1 directory contains an engine row,** for example a wrong directory was passed. The analysis must refuse it, because stage 1 is bare-only by protocol (Task 2 test).
3. **More than 6 hard items.** The choice of 6 must be deterministic, a subset of the hard items, and in upstream order (Task 2 test).
4. **Binary files in numstat (`-\t-\t<path>`).** They count as a file with 0 lines, never as NaN (Task 1 test).
5. **An earlier suite's item shows up again** (mealie3 included) and must be excluded (Task 1 test).

---

### Task 1: The `--large` draw in the selector

**Files:**
- Modify: `bench/suites/mealie/_tools/select.js`
  - usage comment (line 15);
  - after `ALL_POOL` (line 52): add `LARGE_RULE`, `largeCounts`, `LARGE_POOL`, `earlierItems`;
  - `main` (line 174): the `--large` branch;
  - after `drawAll`: add `drawLarge`;
  - exports.
- Test: `tests/mealie.test.js`

**Interfaces:**
- Produces:
  - `LARGE_RULE = { files: 5, mealieFiles: 4, minLines: 100, maxLines: 1500 }`;
  - `largeCounts(c) -> { files, mealieFiles, lines }`, over `c.numstat` minus `NOT_COUNTED`;
  - `LARGE_POOL(c, used: Set<sha>) -> boolean`;
  - `earlierItems(suitesDir) -> Set<sha>`, the full shas accepted in `mealie`, `mealie2` and `mealie3` `_tools/selection.json`;
  - `drawLarge(commits, fallbackCommits, OUT, range, fallbackRange)`.

  The selection records:
  - `mode: 'large'`;
  - `rule: LARGE_RULE`;
  - `pool`, plus `fallbackPool` when the fallback is used;
  - `fallbackUsed`;
  - `accepted`, keyed by `allKey`;
  - `skipped`.

  The CLI is `select.js --suite <dir> --range <a..b> --large [--fallback <c..d>]`.

- [ ] **Step 1: Write the failing test** `mealie select --large: multi-file fixes and features with backend tests, 100–1,500 counted lines, no earlier item`.
  - It builds commits as the `--all` test does, with numstat lines spread over the files.
  - It asserts that `LARGE_POOL` is:
    - `true` for 4 `mealie/` files plus 1 `frontend/` file, 120 lines, and a backend test;
    - `true` at exactly 100 lines and at exactly 1,500 lines;
    - `false` for 4 counted files, for 5 files with only 3 under `mealie/`, for 99 lines and for 1,501 lines;
    - `false` when the 5th file is under `tests/`, `docs/`, `frontend/lang/` or is `uv.lock`, because those are not counted;
    - `false` for `fix(deps): …`, for `fix: bump x`, for `chore: …`, and with no backend test;
    - `false` when the sha is in `used`.
  - It asserts that a numstat row with `lines: NaN` or a binary marker counts as a file with 0 lines.
  - It asserts that `earlierItems(path.join(__dirname, '..', 'bench', 'suites'))` contains `3be8f3d8…` (mealie3) and `7808c944…` (mealie), and that every entry is 40 hex characters long.
- [ ] **Step 2: Run it.**
  - Run: `node --test --test-name-pattern "select --large" tests/mealie.test.js`
  - Expected: FAIL, because `LARGE_POOL is not a function`.
- [ ] **Step 3: Implement it.**
  - **Binary rows:** the numstat parser in `main` already maps `-` to 0 with `Number(a) || 0`. `largeCounts` also treats a non-finite count as 0.
  - **The fallback:** `drawLarge` validates the window's eligible commits in upstream order, exactly as `drawAll` does: `trees`, `validateBackend`, and `validateFrontend` when frontend specs exist. When fewer than 12 are accepted, it then validates every eligible commit of the fallback range and sets `fallbackUsed: true`.
- [ ] **Step 4: Run the tests.**
  - Run: `node --test tests/mealie.test.js`
  - Expected: PASS. The live tests are skipped without `ECCODE_MEALIE_VALIDATE`.
- [ ] **Step 5: Commit.** "Selector: the multi-file run's --large draw".

### Task 2: The analysis, `bench/pilot/multifile.js`

**Files:**
- Create: `bench/pilot/multifile.js`
- Test: `tests/pilot.test.js`

**Interfaces:**
- Consumes, from `bench/pilot/proof.js`: `readRuns(dir)`, `passed(row)`, `runKeys(rows)`, `hardItems(stage1, labels)`, `primary(stage2, hard)`, `delivery(rows)`, `friction(dir, rows, labels)`. It also uses `bench.mulberry32` and `bench/pilot/lib.js` `shuffle(items, rand)`.
- Produces:
  - `chooseHard(hard: string[], order: (id) => number, max = 6) -> string[]`. It returns all of them in upstream order when there are at most `max`. Otherwise it shuffles them, in upstream order, with `mulberry32(42)`, takes the first `max`, and re-sorts them in upstream order.
  - `withTests(rows) -> { runs, n }`: the runs whose `patch` adds or changes `tests/**` or a frontend `*.spec.ts` / `*.test.ts`.
  - `report({ stage1, stage2, labels, friction, order }) -> markdown`.
  - CLI: `node bench/pilot/multifile.js --stage1 <dir> --labels <file> [--stage2 <dir>] [--refusals <file>] [--out <file.md>]`. The order comes from the task ids' `NN` prefix after the suite name.

- [ ] **Step 1: Write the failing tests.**
  - **`multifile run: stage 1 is bare-only; hard items by agent error; at most 6 go to stage 2, drawn deterministically in upstream order`.**
    - `report` throws `/stage 1 is bare-only/` when stage 1 has an engine row.
    - `chooseHard(['a','b','c'], o)` returns `['a','b','c']`.
    - For 8 hard items it returns 6 distinct members, in increasing `order`, identical on a second call.
  - **`multifile run: the report's primary verdict, secondary criteria over stage-2 engine runs, and an item a ceiling cut to one variant`.**
    - Stage 1 has `w1` rows on a, b and c, each failing once with `agent-error`.
    - Stage 2 has 6 `s2w` and 6 `s2e1` runs on a and b, the engine passing all and the bare agent passing 2 of 6 each. Item c has only 6 bare runs, all failing.
    - The markdown matches:
      - `/Hard items[^\n]*: a, b, c/`;
      - `/Primary:\*\* met: engine 12\/12, bare 4\/18/` (all stage-2 runs on the chosen items count);
      - `/Delivery[^\n]*stage-2 engine runs on the hard items/`;
      - `/c: no engine run/` in the stage-2 table;
      - `/Stratified permutation test[^\n]*\(2 items/` (c has no runs of both variants).
    - With 2 hard items it matches `/Primary:\*\* no verdict[^\n]*fewer than 3 hard items/`.
    - With no `--stage2` and 3 hard items it matches `/pending/`.
  - **`multifile run: tests in the patch counts tests/ and frontend spec files only`.**
    - A patch touching `+++ b/tests/unit/test_x.py` counts.
    - One touching only `+++ b/mealie/x.py` does not.
    - One touching `+++ b/frontend/a.spec.ts` counts.
- [ ] **Step 2: Run them.**
  - Run: `node --test --test-name-pattern "multifile run" tests/pilot.test.js`
  - Expected: FAIL, with `Cannot find module '../bench/pilot/multifile'`.
- [ ] **Step 3: Implement `bench/pilot/multifile.js`.** The report's sections, in order:
  - **Stage 1** (item | bare passed/runs | failure labels);
  - **Hard items**, and the chosen ones when drawn;
  - **Stage 2** (item | bare | engine, "no engine run" / "no bare run");
  - **Criteria** (Primary, Delivery, Friction);
  - **Reported, no criterion:** the median cost ratio and run times over stage-2 runs, tests in the patch per variant, and the stage-1 bare pass rate.

  The verdict wording and conditions copy `proof.js`'s `report`, with "stage-2 engine runs on the hard items" in place of "stage-1 engine runs".
- [ ] **Step 4: Run the tests.**
  - Run: `node --test tests/pilot.test.js`
  - Expected: PASS, the proof run's tests included.
- [ ] **Step 5: Commit.** "Multi-file run analysis: bare screening, hard items, stage-2 verdicts".

### Task 3: Draw the suite

**Files:**
- Create:
  - `bench/suites/mealie4/_tools/selection.json` (generated);
  - `bench/suites/mealie4/_tools/env.js` (the mealie3 shim, comment updated);
  - `bench/suites/mealie4/README.md`, in mealie3's README shape: what the suite is, the exact draw command, the multi-file rule and the request rules.
- Modify: `tests/mealie.test.js`:
  - add `MEALIE4` to the no-leak and live loops;
  - add a structural test.

**Interfaces:**
- Consumes: Task 1's CLI.
- Produces: `selection.json` with `mode: 'large'`, and accepted keys `fix-<sha8>` / `feature-<sha8>`.

- [ ] **Step 1: Check the disk.** `df -h /` must show at least 6 GB available. If it doesn't, remove only scratch sandboxes no report needs:
  - stale `/tmp/mp/mealie-validate-*`, `/tmp/mp/eccode-bench-*`, `/tmp/mp/proof-lint-*`;
  - the proof run's worktree `/tmp/mp/wt3`, after `git worktree remove`.
- [ ] **Step 2: Run the draw** in the background, logging to `/tmp/mp/r4/select.log`:
  ```
  ECCODE_MEALIE_ENVS=/root/.cache/eccode/mealie-envs TMPDIR=/tmp/mp node bench/suites/mealie/_tools/select.js --suite bench/suites/mealie4 --range v3.20.0..753325676331cf8df48cae7c64ce634f2cb693cb --large --fallback v3.10.0..v3.20.0
  ```
  - Expected: a line `<n> accepted, <m> skipped`, with n + m = 17 (or 25 when the fallback ran).
  - The selector builds any missing environment. If a build fails, fix the environment, never the rule, and record the cause.
- [ ] **Step 3: Write the structural test** `mealie4: one task per accepted multi-file change, fix or feature track by its subject, none used before`. It mirrors the mealie3 test, plus:
  - `selection.mode === 'large'`;
  - ids match `/^mealie4-\d\d-(fix|feature)-[0-9a-f]{8}$/`;
  - no `fixCommit` is in `earlierItems`;
  - with the mirror present, each `fixCommit` satisfies `LARGE_POOL` on its recomputed numstat.

  It skips while the suite is not built.
- [ ] **Step 4: Commit** the selection, shim, README and test. "mealie4: the multi-file draw (<n> accepted, <m> skipped)".

### Task 4: Requests and the built suite

**Files:**
- Create: `bench/suites/mealie4/_tools/prompts.json` and `bench/suites/mealie4/_tools/coverage.json` (mealie3's shapes).
- Generated: `bench/suites/mealie4/NN-<kind>-<sha8>/task.json`.

- [ ] **Step 1: Draft the requests.** Four general-purpose agents draft them in parallel, each taking a quarter of the accepted items. Each agent gets:
  - the commit (`git --git-dir <mirror> show <sha>`) and its hidden test files;
  - the proof run's request rules (spec section 4);
  - `bench/suites/mealie3/_tools/prompts.json` as the style reference.

  Each returns, per item, the request text and its coverage entry (`covers`: one line per target test with what it asserts, and `note`) as JSON text. Agents write no files.
- [ ] **Step 2: Review every request yourself** against its target tests. Each asserted status, error, name, limit and edge case must be stated. No file the fix changes is named, and no fix line is copied. Correct each request in place, then write `prompts.json` and `coverage.json`.
- [ ] **Step 3: Build the suite.**
  - Run: `node bench/suites/mealie/_tools/build.js --suite bench/suites/mealie4`
  - Expected: one line per item, `NN-<kind>-<sha8>: <track>, <subject>`.
- [ ] **Step 4: Run the tests.**
  - Run: `node --test tests/mealie.test.js`
  - Expected: PASS, including `mealie4: no prompt contains a line of its fix or names a file it changes` and the mealie4 structural test.
- [ ] **Step 5: Commit.** "mealie4: requests and tasks".

### Task 5: Live validation, smoke runs and registration

**Files:**
- Create: `bench/protocols/<today>-mealie-multifile.md`.
- Create (scratch, not committed): `/tmp/mp/r4/stage1.sh` and `/tmp/mp/r4/stage2.sh`, from the proof run's scripts. Change these:
  - suite `mealie4`;
  - `--timeout 7200`;
  - the stage-1 processes and ceilings from Global Constraints;
  - stage 2 takes the chosen ids and builds `s2e1`–`s2e3` round-robin with `$35.70` × items each, and `s2w` with `$5.95` × items;
  - output in `/tmp/mp/r4/stage{1,2}`;
  - `cd /tmp/mp/wt4`.

- [ ] **Step 1: Validate live,** in three shards of the built tasks. Use `node <scratch>/validate-live.js bench/suites/mealie4 <ids>`, each shard in the background, logging to `/tmp/mp/r4/live/shardN.log`.
  - Expected: every line `OK`: the target fails at the source, passes at the fix, and the regression set passes at both.
  - A `FAIL` means the task is wrong. Diagnose it from the log. Never edit a request to make validation pass.
- [ ] **Step 2: Smoke runs** on the accepted item with the most counted lines, from the working tree, saved under `/tmp/mp/r4/smoke`: one `--variant without --runs 1` and one `--variant engine --runs 1 --engine-profile guard --engine-agents inherit`, both with `--timeout 7200`.
  - Expected: each produces a result line. Record pass/fail, minutes and cost for the protocol.
  - If the engine run reaches 7,200 s, rule in the ledger to raise every run's timeout to 10,800 s, and disclose this in the protocol.
- [ ] **Step 3: Write the protocol,** in the proof protocol's structure:
  - **Why;** the design in one paragraph;
  - **Subject;** **Items**, with the full table: order, item, track, upstream change, source, target and regression counts;
  - **Live validation;** **What runs, and where;**
  - **Variants and processes,** with the exact commands and ceilings;
  - **Stage 2** rules (the draw of 6);
  - **Budget;** **Smoke runs** with their results;
  - **Labels;** **Criteria;** **Infrastructure failures;** **Reporting;** **Risks.**

  Every value comes from the spec and the Global Constraints.
- [ ] **Step 4: Run the whole suite.**
  - Run: `npm test > /tmp/mp/r4/npmtest.log 2>&1; tail -5 /tmp/mp/r4/npmtest.log`
  - Expected: `# fail 0`.
- [ ] **Step 5: Register.**
  - Commit the protocol: "Register the multi-file run".
  - Push.
  - Then `git worktree add /tmp/mp/wt4 <that commit>`.

### Task 6: Stage 1 and its labels

**Files:**
- Create: `bench/pilot/mealie/labels-multifile/failures.json`.

- [ ] **Step 1: Launch stage 1.**
  - Run: `bash /tmp/mp/r4/stage1.sh`, in the background, detached.
  - Watch `/tmp/mp/r4/stage1/timeline.txt` until "stage 1 done", with a Monitor until-loop.
  - Expected: about 45 result lines across `w1`–`w3`.
- [ ] **Step 2: Label every failed bare run** (`<process>:<task>:<n>`), from:
  - the replay: `node bench/pilot/mealie/proof-replay.js bench/suites/mealie4 /tmp/mp/r4/stage1/<p>.jsonl <task> <n> /tmp/mp/r4/label/<key> [--split]`;
  - the run's patch;
  - the request and `coverage.json`.

  Each label is `agent-error`, `spec-gap` or `harness`, with a one-line reason. A timeout is `harness`.
- [ ] **Step 3: Check, commit and push the labels before stage 2.**
  - Run: `node bench/pilot/multifile.js --stage1 /tmp/mp/r4/stage1 --labels bench/pilot/mealie/labels-multifile/failures.json`
  - Expected: no "unlabelled" error. The hard items are listed.
  - Commit "Multi-file run: label the failed stage-1 bare runs" and push.

### Task 7: Stage 2 and its labels

**Files:**
- Modify: `bench/pilot/mealie/labels-multifile/failures.json`.
- Create: `bench/pilot/mealie/labels-multifile/refusals.json`.

- [ ] **Step 1: Choose the stage-2 items** with `chooseHard`, through the report's "chosen" line.
  - With fewer than 3 hard items, stage 2 still runs on the ones there are.
  - With 0 hard items, skip to Task 8.
- [ ] **Step 2: Launch stage 2.**
  - Run: `bash /tmp/mp/r4/stage2.sh <chosen ids>`, in the background.
  - Watch the timeline until "stage 2 done".
  - Arm a `send_later` check-in every 4 hours while it runs.
- [ ] **Step 3: Infrastructure cuts.** A run with no result line from an infrastructure failure is run once more after the batch, in `/tmp/mp/r4/stage2-rerun`. Both readings are reported.
- [ ] **Step 4: Label.**
  - Every failed stage-2 run of either variant, in `failures.json`.
  - Every refusal in stage-2 engine runs, in `refusals.json`, as `correct`, `false`, `agent-error` or `harness`. The extractor is the one `friction()` uses, and ids match it.
- [ ] **Step 5: Commit and push the labels** before computing any figure: "Multi-file run: label stage-2 failures and refusals".

### Task 8: Analyse, report and ship

**Files:**
- Create:
  - `bench/pilot-results/<registration date>-mealie-multifile.md`;
  - `bench/pilot-results/<registration date>-mealie-multifile.runs.jsonl`, with all stage-1 and stage-2 rows, scratch paths shortened;
  - `bench/pilot/mealie/results-multifile/lint.json`.
- Modify:
  - `docs/limits.md` (row 59, plus new rows for defects);
  - `README.md`, `docs/final-report.md`, `docs/senior-engineering.md` (the run's section).

- [ ] **Step 1: Analyse.**
  - Run: `node bench/pilot/multifile.js --stage1 /tmp/mp/r4/stage1 --stage2 /tmp/mp/r4/stage2 --labels bench/pilot/mealie/labels-multifile/failures.json --refusals bench/pilot/mealie/labels-multifile/refusals.json --out /tmp/mp/r4/analysis.md`
  - Expected: a Primary line of met, missed or no verdict, and Delivery and Friction lines.
- [ ] **Step 2: Post hoc lint.**
  - Run: `node bench/pilot/mealie/proof-lint.js /tmp/mp/r4/stage2 bench/suites/mealie4 bench/pilot/mealie/results-multifile/lint.json`
  - Label it post hoc in the report.
- [ ] **Step 3: Write the report,** labels before figures. Disclose every deviation, cut run and defect.
- [ ] **Step 4: Fix each defect** the run exposes in ECCode, with a test that failed first. Add a register row each, and bump the version only if engine code changed.
- [ ] **Step 5: Get a final whole-branch review** from a fresh reviewer, then do the fix pass. Then run `npm test` (expected `# fail 0`), commit, and push.
- [ ] **Step 6: Open the PR** to `claude/keen-allen-5z33eb` and drive CI to green. Merge it as with TOUMO45/ECCode#23. Update the evaluation doc.
