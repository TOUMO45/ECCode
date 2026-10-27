# Multi-file run: does the engine fix what a bare agent gets wrong on large changes?

Status: design approved in conversation on 2026-10-26; this spec is for review before planning.

## 1. Why

The proof run ([report](../../bench/pilot-results/2026-10-26-mealie-proof.md)) left its primary question without a verdict. The bare agent passed 36 of 38 runs on Mealie changes of at most 400 lines in at most 12 files. Its two failures were on one item whose request does not state what the failing test checks (`spec-gap`). No item was hard, so stage 2 never ran (register row 59).

Small changes stated in full leave a bare agent little to get wrong. Large changes give it more chances:
- to miss one of many stated behaviours;
- to break an existing test it never ran;
- to stop before the change is complete.

The engine's plan, reviews and verification target exactly those. This run asks the primary question again, on the largest changes Mealie's recent history offers.

**What it must show:** whether, on items where a bare agent makes its own mistakes, the engine passes the hidden checks more often. The answer is decided by a pre-registered test (section 7).

**What it does not try to show:**
- correctness on unselected items (the proof run reported that: 36 of 38 each way);
- delivery on unselected items (38 of 38 in the proof run).

## 2. Subject

- **Mealie**, as in the pilot, the rerun and the proof run: the same mirror, environments, hidden-test export and licence rule. No Mealie file enters this repository.
- **Window:** v3.20.0..`753325676331cf8df48cae7c64ce634f2cb693cb`, the proof run's head of `mealie-next` (first-parent history, 2026-06-24 to 2026-10-24). This spans the pilot's, the rerun's and the proof run's windows.
- **Fallback window:** v3.10.0..v3.20.0, drawn only under the rule in section 3.

## 3. Items

**Eligible.** Each commit in the window must meet all of these:
- its subject starts `fix` or `feat`, and it is not `fix(deps)` or a bump (the proof run's `--all` rules);
- it changes `mealie/` and includes backend tests (`tests/**/test_*.py`);
- it is **multi-file**, which the pool counts on non-test files only (tests, docs, translations and lockfiles excluded, as in the size cap):
  - at least 5 non-test files change;
  - at least 4 of them are under `mealie/`;
  - 100 to 1,500 lines change in total;
- it is not an item of an earlier suite (`mealie`, `mealie2`, `mealie3`).

**The pool before validation:** 17 commits in the window, from 120 to 1,355 lines, taken in upstream order with no sampling.
- **Excluded by the 1,500-line ceiling:**
  - `e305551b`, the unified AI recipe page (3,012 lines);
  - `30284d56`, ingredient substitutions (2,109 lines);
  - `3d1978a8`, the food seed data (789,478 lines, nearly all data).
- **Excluded as earlier items:** `7808c944`, `5530edeb`, `04d380a5`, `6fb78ba4`, `3be8f3d8` and `8b53861e`.

**Validation.**
- Each candidate is validated live, exactly as in the proof run:
  - its new or changed tests fail on its parent and pass at the commit, twice on each side;
  - the regression set passes on both sides.
- Frontend spec files the commit adds or changes are validated and become part of the hidden checks, as in the proof run's item 19.
- Every skip is recorded with its reason.

**Fallback.** If fewer than 12 candidates are accepted, every eligible commit of the fallback window is drawn too, in upstream order. This adds 8 commits, from 141 to 737 lines. The rule is fixed before the draw.

**Tracks:** a `fix` subject runs on the fix track, a `feat` subject on the feature track.

**Suite:** `bench/suites/mealie4`, built by the existing `build.js` from its own `_tools/selection.json` and `_tools/prompts.json`.

## 4. Requests

The proof run's rules apply unchanged.
- Each request is written issue-style from the commit and its tests.
- It names what the hidden tests pin by symbol, never by the path of a file its fix changes, and contains no line of the fix.
- **It states every behaviour its target tests check:** the status codes, errors, names, limits and edge cases they assert.
- **Scope:** the backend is always in scope. Frontend work is in scope only when the commit adds or changes frontend specs. Otherwise the request does not ask for it, so neither variant spends effort that no check measures.

**Process.** Agents draft the requests from the commits. The operator reviews, corrects and approves each one before registration. `tests/mealie.test.js` checks mealie4 as it checks mealie3:
- no request names a file its fix changes or contains a line of its fix;
- every task is the recorded draw.

Large changes make long requests. A request that misses a behaviour a test checks produces `spec-gap` failures, and those never make an item hard (section 6).

## 5. Variants and stages

- **Variants:** `without` (the bare request) and `engine` (`--engine-profile guard --engine-agents inherit`, the request delivered through the item's track).
  - Both use model alias `sonnet` and `$AGENT_B` from `bench/pilot/agents-rerun.sh`.
  - Each run is an independent fresh sandbox at the item's source commit. There are no chains.
- **Timeout: 7,200 s for every run**, in both variants and both stages. The proof run's largest item took the engine 54 minutes at 148 lines, so 3,600 s would cut large items.
- **ECCode under test:** the commit of the protocol, from a git worktree pinned at it. It is v0.14.0 plus this run's tooling, with no engine change.

**Stage 1, screening:** 3 `without` runs per item, and no engine runs.
- The items are split across 3 processes in upstream order.
- Each process has `--max-cost 20` (stage 1 at most $60).

**Hard item:** an item at least one of whose stage-1 bare runs failed a hidden check and is labelled `agent-error` (section 6).

**Stage 2, the comparison:** 6 fresh `without` runs and 6 fresh `engine` runs on every hard item.
- **Processes:** the engine runs are split across 3 processes and the bare runs across 1. Each has a `--max-cost` ceiling in proportion to its share of the stage-2 budget.
- **Budget:** stage 2 has a budget of $250, at an estimated $42 per hard item ($6 per engine run, $1 per bare run).
- **More than 6 hard items:** stage 2 takes 6 of them, drawn with `mulberry32(42)` from the hard items in upstream order. The other hard items are reported, with their stage-1 labels, but not run.
- **A ceiling stops a process:** its unstarted runs are reported as not run. The primary test uses the runs that exist.

**Smoke runs, before registration:** one bare run and one engine run on the accepted item with the most changed lines. They confirm the environment, setup, hidden checks and the 7,200 s timeout on the largest change. They are not counted, and their results are disclosed in the protocol.

## 6. Labels, before any figure

The proof run's labels and rules apply. Each label carries a one-line reason and is committed to `bench/pilot/mealie/labels-multifile/` before the figure that uses it is computed.

**`failures.json`,** keyed `<process>:<task>:<n>`:
- **Every failed stage-1 bare run.** Labelled and committed before stage 2 starts. Each gets one of:
  - `agent-error`: the request states what the failing test checks, and the change gets it wrong;
  - `spec-gap`: the request does not state it, or states it ambiguously;
  - `harness`: the environment, setup or infrastructure, or the run's 7,200 s timeout (as in the proof run, so a bare run that hangs never makes an item hard).

  A run cut by the timeout still counts as a failure in every pass rate.
- **Every failed stage-2 run, of either variant.** These are reported, and are not used to choose anything.

**`refusals.json`:** every refusal in a stage-2 engine run, labelled `correct`, `false`, `agent-error` or `harness`, as in the rerun.

## 7. Criteria

**Primary: correctness on the hard items.** Over the stage-2 runs, the engine passes every hidden check more often than the bare agent.
- **The test:** the stratified permutation test (`stratifiedTest`, items as strata, 20,000 resamples, seed 42, two-sided).
- **Met:** the engine's share is higher, the per-item difference is positive and p < 0.05.
- **Missed:** otherwise.
- **No verdict:** fewer than 3 hard items. The figures are still reported.

**Secondary,** over the stage-2 engine runs (the hard items only, and said so):
- **delivery:** at least 80% delivered with a clean audit (row 104's rule);
- **friction:** at most 1 false refusal per engine run (row 105's rule).

**Reported, no criterion:**
- stage-1 bare pass rate on every item;
- each failure's label;
- the median cost ratio and run times;
- tests in the patch;
- the post hoc lint check (`proof-lint.js`), labelled post hoc as in the proof run.

**Analysis:** `bench/pilot/multifile.js`, a new script built on `bench/pilot/proof.js`'s exported functions (`readRuns`, `runKeys`, `hardItems`, `primary`, `delivery`, `friction`). It is tested and committed before registration. `proof.js` stays as the proof run registered it.

## 8. Budget and time

These are estimates from the proof run's largest items, where the engine took 50–54 minutes and $3.50, and the bare agent 2–14 minutes and $0.40.

| Stage | Runs | Estimate | Ceiling |
|---|---|---|---|
| Smoke | 2 | about $8 | not counted in the ceilings |
| 1 | about 45 bare | about $45, 4–6 h | $60 |
| 2 | 12 per hard item | about $42 per hard item, 10–14 h for 6 items | $250 |

The total ceiling is $310 plus the smoke runs. Building and validating the suite, including the new environments for older lockfiles, comes before stage 1.

**Power:** with 6 hard items at 6 runs each, a bare pass rate of 60% against an engine at 95% (22/36 against 34/36) is detected comfortably. A gain of 75% against 60% would likely be missed. Missed is then the honest result.

## 9. Reporting

- **Protocol:** `bench/protocols/<registration date>-mealie-multifile.md`, committed and pushed before any measured run. Its commit timestamp is the registration.
- **Report:** `bench/pilot-results/<registration date>-mealie-multifile.md`, with the saved runs beside it as `.runs.jsonl` and scratch paths shortened to `<scratch>`.
- **Completeness:** every run is reported, with no runs dropped. Infrastructure cuts are run once more and both readings reported, as in the proof run.
- **Defects found:** each gets a register row, and a fix with a test that failed first, after the batch.
- **Register:** row 59 is updated by what the run shows.
- **Docs:** the README, `docs/final-report.md` and the evaluation doc get the result, labels before figures.

## 10. Risks, disclosed in the protocol

- **Spec gaps grow with the change.** Labels keep them from making items hard. If every failure is `spec-gap`, the run has no verdict, and the report says what the requests missed.
- **The bare agent may still pass everything.** Then the primary has no verdict again. That is itself evidence: Sonnet with a full request rarely fails even 500-line Mealie changes.
- **Training data.** The model may have seen these July–October commits. Both variants are affected alike.
- **Operator exposure.** The operator saw the small items of the same windows while fixing ECCode, never these large ones. No engine change is made after the pool is drawn.
- **Regression to the mean.** Items chosen because the bare agent failed may pass more often on fresh runs. Stage 2's fresh runs, not the screening runs, decide the primary, which keeps this from favouring the engine.
- **Cost overrun.** The ceilings stop processes. Runs not started are reported as not run, never imputed.
