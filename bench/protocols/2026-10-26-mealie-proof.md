# Pre-registered protocol: does the engine catch the mistakes a bare agent makes?

**DRAFT, not yet registered.** The item and process tables are filled in when the draw is complete; registration is the commit that removes this line.

Committed and pushed before any measured run starts; the git commit timestamp is the registration. Where this protocol says nothing, the rerun's protocol ([2026-10-25-mealie-rerun.md](2026-10-25-mealie-rerun.md)) and, through it, the pilot's are what run.

**Why.** Three batches could not show whether ECCode's engine improves correctness: the engine benchmark, twenty real bugs and the Mealie pilot and rerun. In each, the bare agent passed almost every hidden check, so the engine had nothing to catch (register row 59). The rerun also left delivery short: 7 of 20 work items with a clean audit, against a rule of 80% (row 104). Most of what stopped delivery has been fixed since (rows 109–130).

This run asks both questions again: delivery on fresh items, and correctness on items where the bare agent actually makes mistakes.

**Design in one paragraph.** Every eligible change in a fresh window of Mealie's history becomes an item.
- **Stage 1:** each item gets 2 bare runs and 2 engine runs. These measure delivery and screen the items.
- **Hard items:** an item is hard when a stage-1 bare run failed a hidden check by its own mistake. Every failed bare run is labelled before stage 2, and only failures labelled `agent-error` count, never `spec-gap` or `harness`.
- **Stage 2:** each hard item gets 4 fresh bare runs and 4 fresh engine runs. The primary comparison uses only these stage-2 runs. The stage-1 bare runs chose the items, so counting them would bias the comparison toward the engine.

## Subject

- **Mealie**, as before. **Window W3 = v3.29.0..`753325676331cf8df48cae7c64ce634f2cb693cb`**, the head of `mealie-next` on 2026-10-24 (first-parent history).
  - 68 commits from 2026-10-17 to 2026-10-24.
  - None is in the pilot's window (v3.20.0..v3.27.0) or the rerun's (v3.27.0..v3.29.0).
  - Every fix ECCode has made was built before this window existed in the mirror.
- Licence and the rule that no Mealie file enters this repository: as before.
- Several upstream commits carry `Co-authored-by:` trailers naming an AI model. The model under test may have seen Mealie's history; this affects every variant alike.

## Items

**The draw:** `bench/suites/mealie/_tools/select.js --suite bench/suites/mealie3 --range v3.29.0..753325676331cf8df48cae7c64ce634f2cb693cb --all`.
- Every commit whose subject starts `fix` or `feat` is a candidate, except a dependency update (`fix(deps)`) or a bump.
- It must change `mealie/` and include backend tests, within the pilot's size cap (at most 400 changed non-test lines in at most 12 non-test files).
- Candidates are taken in upstream order, with no categories and no sampling. Each is validated live, as before: its new or changed tests fail on its parent and pass at the commit, twice on each side, and the regression set passes on both sides.
- Every skip and its reason is in `bench/suites/mealie3/_tools/selection.json`.

**Tracks:** a `fix` subject runs on the fix track, a `feat` subject on the feature track.

**Requests** (`bench/suites/mealie3/_tools/prompts.json`) are written from each commit and its tests, issue-style, under the pilot's rules. Each names what the hidden tests pin by symbol, never by the path of a file its fix changes. One rule is new: **a request states every behaviour its target tests check** (the status codes, errors, names, limits and edge cases they assert). Drafts were written by four agents from the commits and reviewed, corrected and approved by the operator before registration. `tests/mealie.test.js` checks that no request names a file its fix changes or contains a line of its fix, and that every task is the recorded draw.

ITEM_TABLE

**Live validation** before this registration: `ECCODE_MEALIE_VALIDATE=1 node --test --test-name-pattern "mealie3 live" tests/mealie.test.js` passed. For every item, the target check fails at the source commit and passes at the fix commit, and the regression check passes at both.

## What runs, and where

- **ECCode under test:** the commit of this protocol, from a git worktree pinned at it. It holds every fix through v0.13.0 and the changes below.
- **Machine:** the rerun's container: 4 cores, 15 GB RAM, Node 22.22.0, Claude Code CLI 2.1.310, model alias `sonnet`, Python managed by uv 0.11.32, pnpm 10.28.0.
- **Environments:** the shared venvs and `node_modules` under `ECCODE_MEALIE_ENVS`, as before. Two differences from the rerun, the same for every variant:
  - every task sets `pnpm_config_verify_deps_before_run=false`, so pnpm runs on the linked `node_modules` (row 101);
  - go-task 3.54.0 is installed, so a plan may use Mealie's own `task` commands (the rerun's b2 item 8 stopped on its absence).
- `TMPDIR=/tmp/mp`.
- **Agent command:** `$AGENT_B` from `bench/pilot/agents-rerun.sh`, unchanged, the same for both variants.

### Changes since the rerun, before registration

Everything in v0.13.0 ([report](../pilot-results/2026-10-25-mealie-rerun.md), register rows 109–130):
- the gate resubmission;
- the refactor baseline checked at the first claim;
- grouped, watched and reported timeouts for evidence runs, `stack run` and `mutate`;
- the guard's misreads;
- the identity gap;
- compat's script and router fixes.

In this run's tooling: the `--all` draw and `bench/pilot/proof.js`, the analysis.

## Variants and processes

Two variants, Sonnet, independent runs: each run is a fresh sandbox at the item's source commit and a fresh record. There are no chains.
- **`without`:** the bare request.
- **`engine`:** the toolkit installed with `--engine-profile guard --engine-agents inherit`, and the request delivered through the item's own track.

`eccode bench` processes are started detached from the pinned worktree, each with `--suite bench/suites/mealie3 --timeout 3600 --agent "$AGENT_B" --save <scratch>/<name>.jsonl --transcripts <scratch>/tr-<name>`.

**Stage 1**, all at once:

PROCESS_TABLE

**Stage 2** runs after the labels are committed. Two processes each take every hard item:
- `w2`: `--variant without --runs 4`;
- `e2`: `--variant engine --runs 4 --engine-profile guard --engine-agents inherit`.

Each has a ceiling of $10 per hard item for `e2` and $2.50 per hard item for `w2`.

If fewer than 3 items are hard, stage 2 still runs on the ones there are, but the primary question has no verdict (below).

**Budget:** $250 in all. A process stops starting new runs at its `--max-cost`.

**Smoke runs** before registration, not counted and disclosed: one bare run and one engine run on one item, to confirm the environment, setup and hidden checks end to end.

## Labels, before any figure

Every label carries a one-line reason. They are committed to `bench/pilot/mealie/labels-proof/` before the figure that uses them is computed.

- **Failed stage-1 bare runs** (`failures.json`, keyed `<process>:<task>:<n>`; `n` counts that process's runs of the task from 1). Committed before stage 2 starts. Each gets one of three labels:
  - `agent-error`: the request states what the failing test checks, and the agent's change gets it wrong.
  - `spec-gap`: the request does not state it, or states it ambiguously. An item with only spec-gap failures is not hard. Its request is not changed during this run, and the gap is reported.
  - `harness`: the environment, setup, a timeout or the infrastructure.
- **Failed engine runs**, stage 1 and 2 (same file), with the same labels. They are reported but do not choose items.
- **Refusals** in engine runs (`refusals.json`), labelled `correct`, `false`, `agent-error` or `harness`, as in the rerun. Refused calls are counted once (rerun amendment 2).

## Criteria

**Primary: correctness on the hard items.** Over the stage-2 runs on the hard items, the engine passes every hidden check more often than the bare agent. The test is the stratified permutation test (`stratifiedTest`, items as strata, 20,000 resamples, seed 42, two-sided).
- **Met:** the engine's share is higher and p < 0.05.
- **Missed:** otherwise.
- **No verdict:** fewer than 3 hard items. The figures are still reported.

**Secondary criteria:**
- **Delivery (row 104):** at least 80% of stage-1 engine runs delivered with a clean audit. These cover every item, unselected.
- **Friction (row 105):** at most 1 false refusal per stage-1 engine run.

**Reported, no criterion:**
- correctness on all items in stage 1 (engine against bare, the same test);
- the median cost ratio, engine over bare;
- each failure's label;
- run times.

**Analysis:** `node bench/pilot/proof.js --stage1 <scratch>/stage1 --stage2 <scratch>/stage2 --labels bench/pilot/mealie/labels-proof/failures.json`, plus the refusal extractor as in the rerun.

## Infrastructure failures

A run that ends with no result line because of an infrastructure failure (a container restart, a harness crash) is run once more after the batch. Both readings are reported:
- **registered:** the cut run counts as a failure;
- **continued:** the run that replaced it counts instead.

An agent that reaches the 3600 s timeout is not an infrastructure failure: it counts as a failure in both readings.

## Reporting

`bench/pilot-results/2026-10-26-mealie-proof.md`, with the saved runs as `2026-10-26-mealie-proof.runs.jsonl` (scratch paths shortened to `<scratch>`).
- Every run is reported, with no runs dropped.
- Every defect found gets a register row, and a fix with a test that failed first, after the batch.
- Rows 59, 104 and 105 are updated by what the run shows. Row 119, lessons shown but not used, is not tested: independent runs carry no earlier lessons.
