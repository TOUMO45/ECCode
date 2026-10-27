# Pre-registered protocol: does the engine fix what a bare agent gets wrong on large changes?

Committed and pushed before any measured run starts; the git commit timestamp is the registration. Where this protocol says nothing, the proof run's protocol ([2026-10-26-mealie-proof.md](2026-10-26-mealie-proof.md)) applies, and through it the rerun's and the pilot's. The design is the approved spec, [docs/specs/2026-10-26-multifile-run-design.md](../../docs/specs/2026-10-26-multifile-run-design.md).

**Why.** The proof run's primary question had no verdict. On Mealie changes of at most 400 lines in at most 12 files, the bare agent passed 36 of 38 runs, and its two failures were spec gaps. No item was hard, and stage 2 never ran (register row 59). Large changes give a bare agent more ways to go wrong:
- missing one of many stated behaviours;
- breaking a test it never ran;
- stopping short.

The engine's plan, reviews and verification exist for those. This run asks the primary question again, on the largest changes in Mealie's recent history.

**Design in one paragraph.**
- **Stage 1** screens every item with 3 bare runs, and no engine runs.
- **Hard item:** a stage-1 bare run failed a hidden check by the agent's own mistake (labelled `agent-error` before stage 2).
- **Stage 2** gives every hard item 6 fresh bare runs and 6 fresh engine runs. With more than 6 hard items, 6 are drawn with `mulberry32(42)`.
- **Only stage-2 runs decide the primary comparison.** The stage-1 runs chose the items, so counting them would bias the comparison toward the engine.

## Subject

- **Mealie,** as in the pilot, the rerun and the proof run. The mirror, environments, hidden-test export and licence rule are unchanged, and no Mealie file enters this repository.
- **Window:** v3.20.0..`753325676331cf8df48cae7c64ce634f2cb693cb`, first-parent history from 2026-06-24 to 2026-10-24. This spans the pilot's, the rerun's and the proof run's windows. The fallback window, v3.10.0..v3.20.0, was not drawn (see Items).
- Several upstream commits carry `Co-authored-by:` trailers naming an AI model. The model under test may have seen Mealie's history up to its training cutoff. This affects both variants alike.
- **Operator exposure:** the operator saw the small items of these windows while fixing ECCode, never these large ones. No engine change has been made since the pool was drawn.

## Items

**The draw:**
```
bench/suites/mealie/_tools/select.js --suite bench/suites/mealie4 \
  --range v3.20.0..753325676331cf8df48cae7c64ce634f2cb693cb --large --fallback v3.10.0..v3.20.0
```

**Eligible.** A commit qualifies when all of these hold:
- its subject starts `fix` or `feat`, and it is neither `fix(deps)` nor a bump;
- it changes `mealie/` and has backend tests;
- it is **multi-file**, counting without tests, docs, translations or lockfiles:
  - at least 5 files;
  - at least 4 of them under `mealie/`;
  - 100 to 1,500 lines;
- it is not an item of `mealie`, `mealie2` or `mealie3`.

**Excluded:**
- by the 1,500-line ceiling: `e305551b` (3,012 lines), `30284d56` (2,109) and `3d1978a8` (seed data, 789,478);
- as earlier items: `7808c944`, `5530edeb`, `04d380a5`, `6fb78ba4`, `3be8f3d8` and `8b53861e`.

**The pool:** 17 commits, taken in upstream order with no sampling. Each was validated live by the selector:
- its new or changed tests fail on its parent and pass at the commit, twice on each side;
- the regression set passes on both sides.

The rule `tests/mealie.test.js` checks is the selector's own: it recomputes the multi-file counts from the mirror for every task.

**The result:** 16 accepted and 1 skipped. The skipped commit is `ea06e210` (feat: lazy module loading and deferred pydantic build, #7316): no test fails on its parent and passes at the commit. Sixteen is at least 12, so the fallback window was not drawn. Every skip is in `bench/suites/mealie4/_tools/selection.json`.

**Tracks:** a `fix` subject runs on the fix track and a `feat` subject on the feature track, giving 12 features and 4 fixes.

**No item changes a dependency.** None of the 16 changes `uv.lock`, `pyproject.toml` or a frontend lockfile between its parent and its commit. So every task can be solved in its parent's environment, where agents can install nothing.

| Order | Item | Track | Upstream change | Source commit | Lines / files | Target | Regression |
|---|---|---|---|---|---|---|---|
| 1 | `mealie4-01-feature-17398941` | feature | feat: Improve scraper resiliency and add both proxy and FlareSolverr support (#7953, `17398941`) | `1dca53dc` | 596 / 6 | 99 | 23 |
| 2 | `mealie4-02-feature-824265b3` | feature | feat: Refine AI import page (#8067, `824265b3`) | `eae0dcbb` | 556 / 21 | 79 | 1436 |
| 3 | `mealie4-03-feature-a1a49d22` | feature | feat: add token refresh, fix remember me, and fix Safari token expiration (#8200, `a1a49d22`) | `0a825b30` | 785 / 21 | 59 | 120 |
| 4 | `mealie4-04-feature-e3cf55b9` | feature | feat: organizer improvements — recipeCount, merge endpoint, delete unused UI (#7829, `e3cf55b9`) | `378a9b07` | 479 / 13 | 9 | 18 |
| 5 | `mealie4-05-fix-fb221afa` | fix | fix: harden server-initiated HTTP against SSRF and DNS rebinding (#7914, `fb221afa`) | `cb32b624` | 471 / 8 | 161 | 138 |
| 6 | `mealie4-06-fix-30ba9a65` | fix | fix: fix missing images / keep recipes.image in sync with the images on disk (#8276, `30ba9a65`) | `0314e875` | 213 / 10 | 6 | 8 |
| 7 | `mealie4-07-feature-b386e728` | feature | feat: add recipe note linking to recipe instructions (#7591, `b386e728`) | `029419e5` | 455 / 15 | 1 | 75 |
| 8 | `mealie4-08-fix-e1c228e6` | fix | fix: localize meal plan rule summaries and notifications (#8102, `e1c228e6`) | `ba61719d` | 121 / 6 | 4 | 2 |
| 9 | `mealie4-09-feature-36d716a4` | feature | feat: structured recipe times (#8539, `36d716a4`) | `a0bdca40` | 751 / 24 | 361 | 1760 |
| 10 | `mealie4-10-feature-97a66c19` | feature | feat: organizer improvements for foods, tools, and labels (#8225, `97a66c19`) | `20faed56` | 738 / 22 | 20 | 10 |
| 11 | `mealie4-11-feature-4a280cbd` | feature | feat: reverse proxy auth (#8183, `4a280cbd`) | `ce0be528` | 580 / 12 | 13 | 108 |
| 12 | `mealie4-12-fix-ec3e0305` | fix | fix: remove aggregate recipe last made data (#7907, `ec3e0305`) | `4a280cbd` | 145 / 15 | 10 | 184 |
| 13 | `mealie4-13-feature-bf16ca15` | feature | feat: Subscribe to the meal plan as an iCal calendar feed (#8461, `bf16ca15`) | `00c2b6b4` | 553 / 12 | 11 | 284 |
| 14 | `mealie4-14-feature-cd2097ee` | feature | feat: In-app AI prompt customization (#8736, `cd2097ee`) | `fbea91cd` | 1355 / 30 | 105 | 465 |
| 15 | `mealie4-15-feature-c935e04f` | feature | feat: declare route permissions with a require() dependency (#8763, `c935e04f`) | `cd2097ee` | 248 / 13 | 6 | 51 |
| 16 | `mealie4-16-feature-a2149447` | feature | feat: enforce route permission helpers with semgrep in CI (#8769, `a2149447`) | `c701777c` | 286 / 26 | 3 | 69 |

- **Lines / files** count changed non-test lines and files, as the rule counts them.
- **Target and regression** are test counts.
- **Frontend specs:** items 03, 09 and 14 also carry frontend specs, which are in their target and regression checks.
- **Large target counts:** where a new test file fails at collection on the parent (items 09 and 14, for example), pytest stops the whole target run. Every test in the hidden files then counts as a target, including unchanged ones. The requests state those as behaviour to keep.

**Requests** (`bench/suites/mealie4/_tools/prompts.json`) follow the proof run's rules.
- Each is issue-style.
- Each names what the hidden tests pin by symbol, never by the path of a file its fix changes, and contains no line of its fix.
- **Each states every behaviour its target tests check.**
- The backend is always in scope. Frontend work is in scope only for the three items with frontend specs.
- Agents drafted them from the commits and their tests. The operator then reviewed each against its target tests:
  - every target test is named in `_tools/coverage.json`;
  - no changed file is named;
  - no fix line is copied;
  - key values were spot-checked against the test source.
- One sentence asking for unmeasured docs work was removed (item 01).
- **Import paths:** two requests give the import path of a module the fix adds, because the tests import it by that path and no symbol at the parent can point at it (items 13 and 15, as in the proof run's item 10).
- `tests/mealie.test.js` checks that no request names a changed file or contains a fix line, and that every task is the recorded draw and meets the multi-file rule.

**Live validation** of the built tasks, before registration:
- **How:** the check `tests/mealie.test.js` runs as "mealie4 live", run in three parallel shards by `validate-live.js`. For every item, the target check must fail at the source commit and pass at the fix commit, and the regression check must pass at both.
- **What it found:**
  - The builder quoted test ids for `sh` inside double quotes. A parametrised id of item 09 holds backticks, which ran as a command substitution, so its target failed at the fix commit.
  - The selector had not seen this, because it validates without a shell.
  - `build.js` now single-quotes ids, with a test that failed first. The suite was rebuilt, and item 09 was validated again.
  - Quoting only changes the meaning of ids holding `$`, a backtick, `\`, `"` or `!`. Of all 16 items, only item 09 has such ids.
- **Result:** every item passed: 15 in the first pass, and item 09 after the fix, at both its source and its fix commit.

## What runs, and where

- **ECCode under test:** the commit of this protocol, from a git worktree pinned at it (`/tmp/mp/wt4`). It is v0.14.0 plus this run's tooling:
  - the `--large` draw;
  - the builder's quoting fix;
  - whole patches in run records;
  - `bench/pilot/multifile.js`.

  No engine code has changed since v0.14.0.
- **Machine:** the proof run's container: 4 cores, 15 GB RAM, Node 22.22.0, Claude Code CLI 2.1.311 (2.1.310 in the proof run), model alias `sonnet`, uv 0.11.32, pnpm 10.28.0 and go-task 3.54.0.
- **Environments:** the shared venvs and `node_modules` under `ECCODE_MEALIE_ENVS=/root/.cache/eccode/mealie-envs`, with `pnpm_config_verify_deps_before_run=false` and `TMPDIR=/tmp/mp`.
- **Agent command:** `$AGENT_B` from `bench/pilot/agents-rerun.sh`, unchanged and the same for both variants.

## Variants and processes

Two variants, Sonnet, independent runs. Each run is a fresh sandbox at the item's source commit with a fresh record, and there are no chains.
- **`without`:** the bare request.
- **`engine`:** the toolkit installed with `--engine-profile guard --engine-agents inherit`, with the request delivered through the item's track.

**Every run has `--timeout 7200`.** The proof run's largest item took the engine 54 minutes at 148 lines.

The common function, as in the proof run, runs from `/tmp/mp/wt4`:

```
B() { node bin/eccode.js bench --suite bench/suites/mealie4 --timeout 7200 --agent "$AGENT_B" "$@"; }
```

**Stage 1:** 3 bare runs per item, no engine runs. Three processes take contiguous thirds of the items in upstream order, each with `--save <scratch>/stage1/<name>.jsonl --transcripts <scratch>/stage1/tr-<name>`:

| Process | Items | Runs | `--max-cost` |
|---|---|---|---|
| w1 | 01–06 | 18 | 20 |
| w2 | 07–11 | 15 | 20 |
| w3 | 12–16 | 15 | 20 |

```
B --tasks <items 01-06> --variant without --runs 3 --max-cost 20 ...
B --tasks <items 07-11> --variant without --runs 3 --max-cost 20 ...
B --tasks <items 12-16> --variant without --runs 3 --max-cost 20 ...
```

**Stage 2** runs after the stage-1 labels are committed and pushed, with `<scratch>/stage2` as the save directory.
- **The items:** every hard item, in upstream order. With more than 6 hard items, `chooseHard` in `bench/pilot/multifile.js` draws 6: it shuffles the hard items, in upstream order, with `mulberry32(42)`, takes the first 6 and sorts them back into upstream order. The other hard items are reported with their stage-1 labels but not run.
- **Engine runs:** three processes `s2e1`–`s2e3` take the chosen items round-robin in upstream order. Each process has `--variant engine --runs 6 --engine-profile guard --engine-agents inherit` and a `--max-cost` of $35.70 per item it runs.
- **Bare runs:** process `s2w` takes every chosen item, with `--variant without --runs 6` and a `--max-cost` of $5.95 per item.
- **Stage 2 stays under $250.**
- With fewer than 3 hard items, stage 2 still runs on the ones there are, but the primary question has no verdict.
- A process stops starting new runs at its `--max-cost`. Runs it did not start are reported as not run and never imputed.

**Budget:** $310 in all: stage 1 at most $60, stage 2 at most $250.

**Smoke runs** before registration. They are not counted and are disclosed here: one bare run and one engine run on the item with the most counted lines (item 14, 1,355 lines), from the working tree with `--timeout 7200`.

| Run | Hidden checks | Time | Cost | Engine |
|---|---|---|---|---|
| bare | target failed, regression passed | 14.7 min | $2.01 | — |
| engine | target failed, regression passed | 56.1 min | $5.52 | not delivered, audit clean, 5 reviews |

- **Both fail on the frontend part of item 14's target.**
  - The run records kept only the first 60,000 characters of each patch. The harness now keeps patches whole (`lib/bench.js`, with a test that failed first), because a failed run must be replayable for its label.
  - The frontend part was therefore replayed from the complete frontend diffs alone. With the bare run's frontend diffs, 5 of the editor spec's 6 tests pass and one assertion fails.
  - The engine run changed no frontend file.
  - Both are the agents' own failures, not the environment's. The environment, setup and hidden checks work for agent-written code.
- **The timeout holds:** the engine run took 56 minutes, under 7,200 s.

These results are known to the operator before registration.

## Labels, before any figure

The proof run's labels and rules apply.
- Each label carries a one-line reason. It is committed to `bench/pilot/mealie/labels-multifile/` before the figure that uses it is computed.
- The operator labels a failure from the replayed failing check's full output (`bench/pilot/mealie/proof-replay.js`), the run's patch, the item's request and `_tools/coverage.json`.

**`failures.json`,** keyed `<process>:<task>:<n>`, where `n` counts that process's runs of the task from 1:
- **Every failed stage-1 bare run.** These are labelled, committed and pushed before stage 2 starts, each with one of:
  - `agent-error`: the request states what the failing test checks, and the change gets it wrong;
  - `spec-gap`: the request does not state it, or states it ambiguously. Such an item is not hard, and its request is not changed during this run;
  - `harness`: the environment, setup or infrastructure, or the run's 7,200 s timeout. A bare run that hangs never makes an item hard. A run cut by the timeout still counts as a failure in every pass rate.
- **Every failed stage-2 run, of either variant.** These are reported and choose nothing.

**`refusals.json`:** every refusal in a stage-2 engine run, labelled `correct`, `false`, `agent-error` or `harness`, as in the rerun. Refused calls are counted once.

## Criteria

**Primary: correctness on the hard items.** Over the stage-2 runs, the engine passes every hidden check more often than the bare agent.
- **The test:** the stratified permutation test (`stratifiedTest`, items as strata, 20,000 resamples, seed 42, two-sided).
- **Met:** the engine's share is higher, the difference is positive and p < 0.05.
- **Missed:** otherwise.
- **No verdict:** fewer than 3 hard items. The figures are still reported.

**Secondary,** over the stage-2 engine runs (the hard items only, and the report says so):
- **delivery:** at least 80% delivered with a clean audit (row 104's rule);
- **friction:** at most 1 false refusal per engine run (row 105's rule).

**Reported, no criterion:**
- the stage-1 bare pass rate on every item;
- each failure's label;
- the median cost ratio and run times (stage 2);
- runs whose patch adds or changes tests;
- the post hoc lint check (`proof-lint.js`), labelled post hoc as in the proof run.

**Analysis:**
```
node bench/pilot/multifile.js --stage1 <scratch>/stage1 --stage2 <scratch>/stage2 \
  --labels bench/pilot/mealie/labels-multifile/failures.json --refusals bench/pilot/mealie/labels-multifile/refusals.json
```

## Infrastructure failures

As in the proof run: a run that ends with no result line because of an infrastructure failure is run once more after its stage, and both readings are reported:
- **registered:** the cut run counts as a failure;
- **continued:** the replacement counts instead.

An agent that reaches the 7,200 s timeout is not an infrastructure failure.

## Reporting

- **Report:** `bench/pilot-results/<registration date>-mealie-multifile.md`, with the saved runs beside it as `.runs.jsonl`, scratch paths shortened to `<scratch>`.
- **Completeness:** every run is reported, with no runs dropped.
- **Defects:** every defect found gets a register row, and a fix with a test that failed first, after the batch.
- **Register:** row 59 is updated by what the run shows.

## Risks

- **Spec gaps grow with the change.** Labels keep them from making items hard. If every failure is a spec gap, the run has no verdict, and the report says what the requests missed.
- **The bare agent may still pass everything.** Then the primary again has no verdict, and that is evidence too: with a full request, Sonnet rarely fails even 500-line Mealie changes.
- **Regression to the mean.** Items chosen because the bare agent failed may pass more often on fresh runs. Fresh stage-2 runs decide the primary, so this cannot favour the engine.
- **Requests that leak structure.** Some tests monkeypatch internals, so their requests must name those seams. That makes the items easier for both variants alike.
