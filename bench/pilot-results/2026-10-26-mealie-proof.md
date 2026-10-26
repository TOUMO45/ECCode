# The proof run: does the engine catch the mistakes a bare agent makes?

Protocol: [bench/protocols/2026-10-26-mealie-proof.md](../protocols/2026-10-26-mealie-proof.md), registered at commit `f5ef59b` (2026-10-26T12:46:33Z) before any measured run. Saved runs: [2026-10-26-mealie-proof.runs.jsonl](2026-10-26-mealie-proof.runs.jsonl). Labels: [failures.json](../pilot/mealie/labels-proof/failures.json) and [refusals.json](../pilot/mealie/labels-proof/refusals.json). The batches before it: [the pilot](2026-10-24-mealie-pilot.md) and [the rerun](2026-10-25-mealie-rerun.md).

## In short

Three batches could not show whether ECCode's engine improves correctness, because the bare agent passed almost every hidden check (register row 59). This run was built to find out. It took every eligible change of a fresh Mealie window, newer than any fix ECCode has made: 19 items, each run twice bare and twice through the engine. An item would be **hard** if a bare run failed a hidden check by its own mistake. Stage 2 would then run four more of each on the hard items alone, and compare.

- **The primary question has no verdict: no item was hard.**
  - The bare agent passed every hidden check in 36 of 38 runs.
  - Both failures are on item 19, and both fail one frontend test that the request does not pin down:
    - The test sends the minus key as a DOM `keypress` event.
    - Every agent, bare or engine, blocked the minus on `keydown` instead, which also stops it being typed in a browser.
    - The request says "a minus-sign keypress is prevented" and names no event, so both failures are labelled `spec-gap`.
  - Labelled the other way, item 19 would be the only hard item, still short of the 3 the protocol needs. The verdict does not turn on that label.
  - Stage 2 had nothing to run, so none of its $117 was spent.
- **The engine passed every hidden check in 36 of 38 runs too.** Its two failures are the two engine runs on item 19, for the same reason. Across all items the stratified test finds no difference (p = 1.0).
- **Both secondary criteria are met:**

  | Criterion | Rule | Result |
  |---|---|---|
  | Delivered with a clean audit (row 104) | at least 80% of stage-1 engine runs | **38/38, met** |
  | False refusals (row 105) | at most 1 per stage-1 engine run | **3 in 38 runs (0.08 per run), met** |

  In the rerun's registered reading, delivery was 7 of 20. Here every engine run delivered. These were single items rather than ten-item chains, and the defects that stopped the rerun's items have been fixed since.
- **What the engine changed is the evidence for the change, not the hidden-check result.** Reported with no criterion:
  - Every engine run added or changed tests (38 of 38), against 13 of 38 bare runs.
  - `fix verify` proved 35 regression tests fail before the fix and pass after it, covering all 30 fix-track runs, and each of those runs recorded a lesson.
  - 131 reviews recorded 168 findings. Four reviews asked for changes, and each was resubmitted and approved. Among them: a planned rename that would have broken how the app finds its permission checks, and a lint error the change introduced.
  - Checked after the fact, not registered: 37 of 38 engine patches and 30 of 38 bare patches would pass Mealie's own lint and format CI step on the Python files they touch (below).
  - The cost: the median engine run cost 10.8× a bare run and took 15.7 minutes against 0.9.
- **The run found three ECCode defects, each now fixed with a test that failed first** (rows 131–133):
  - Claude Code refuses a subagent's write of a Markdown file named like a report, and ECCode told the delivery lead to write `report.md`. That caused 64 refused writes, at least one in every engine run.
  - The lesson draft did not show the shape of a failed attempt, so agents wrote strings and `memory add` refused the lesson (8 times).
  - `fix verify` called a reproduction inconclusive because some tests needed new API, though others had failed on the bug. A review citing it was refused (2 of the 3 false refusals).

  The third false refusal comes from a named limit, kept on purpose (row 91).

## What ran

- **Subject:** Mealie, over the window W3 = v3.29.0..`75332567` (the head of `mealie-next` on 2026-10-24).
  - Every eligible change was drawn and validated ([bench/suites/mealie3](../suites/mealie3/README.md)): 19 items, 15 fixes and 4 features.
  - One candidate was skipped because no test fails on its parent.
- **Requests:** issue-style, each stating every behaviour its target tests check. Four agents drafted them from the commits, and the operator reviewed them before registration. Each request's coverage notes are in `_tools/coverage.json`.
- **Model:** Sonnet in every session, through `claude -p` with the rerun's tool list ([bench/pilot/agents-rerun.sh](../pilot/agents-rerun.sh)).
  - Engine runs used the guard profile.
  - Each delivered on its item's track (fix or feature), with role agents dispatched by the main session.
- **Processes:** five, launched at 2026-10-26T12:47:09Z from a worktree pinned at the protocol commit. Each ran two runs per item:
  - e1, e2 and e3 ran the engine on items 1–6, 7–13 and 14–19;
  - w1 and w2 ran bare on items 1–10 and 11–19.
- **Time:** w2 ended at 13:50Z, w1 at 14:00Z, e1 at 16:23Z, e3 at 16:32Z and e2 at 17:54Z.
  - The longest run took 54 minutes, under the 3600 s timeout.
  - No infrastructure failure cut a run.
- **Cost:** $61.30 by the runs' result lines (bare $6.39, engine $54.91), against $133 for stage 1.
  - Stage 2 spent nothing.
  - Two smoke runs before registration cost $1.05 and are disclosed in the protocol.

## Every item

| # | Item | Track | Bare passed | Engine passed | Engine delivered, clean audit | Median cost, bare / engine | Median minutes, bare / engine |
|---|---|---|---|---|---|---|---|
| 1 | `mealie3-01-fix-3be8f3d8` | fix | 2/2 | 2/2 | 2/2 | $0.35 / $1.94 | 3 / 23 |
| 2 | `mealie3-02-fix-4d074185` | fix | 2/2 | 2/2 | 2/2 | $0.11 / $0.97 | 1 / 7 |
| 3 | `mealie3-03-fix-f4b4f87e` | fix | 2/2 | 2/2 | 2/2 | $0.36 / $1.30 | 15 / 19 |
| 4 | `mealie3-04-fix-28522f18` | fix | 2/2 | 2/2 | 2/2 | $0.11 / $1.33 | 1 / 13 |
| 5 | `mealie3-05-fix-173eb922` | fix | 2/2 | 2/2 | 2/2 | $0.20 / $1.45 | 3 / 28 |
| 6 | `mealie3-06-fix-4b32e54b` | fix | 2/2 | 2/2 | 2/2 | $0.12 / $1.23 | 1 / 15 |
| 7 | `mealie3-07-fix-cdae185e` | fix | 2/2 | 2/2 | 2/2 | $0.09 / $1.04 | 1 / 10 |
| 8 | `mealie3-08-fix-77a07886` | fix | 2/2 | 2/2 | 2/2 | $0.09 / $1.05 | 0 / 18 |
| 9 | `mealie3-09-fix-e4d70fb7` | fix | 2/2 | 2/2 | 2/2 | $0.11 / $1.33 | 1 / 18 |
| 10 | `mealie3-10-feature-8b53861e` | feature | 2/2 | 2/2 | 2/2 | $0.39 / $3.45 | 3 / 52 |
| 11 | `mealie3-11-fix-2c46e40d` | fix | 2/2 | 2/2 | 2/2 | $0.14 / $1.53 | 1 / 23 |
| 12 | `mealie3-12-fix-4a8e710f` | fix | 2/2 | 2/2 | 2/2 | $0.08 / $1.07 | 0 / 16 |
| 13 | `mealie3-13-fix-dedda0d1` | fix | 2/2 | 2/2 | 2/2 | $0.13 / $1.01 | 1 / 11 |
| 14 | `mealie3-14-fix-fb05f2da` | fix | 2/2 | 2/2 | 2/2 | $0.09 / $1.06 | 1 / 11 |
| 15 | `mealie3-15-fix-9ca95fbb` | fix | 2/2 | 2/2 | 2/2 | $0.11 / $1.07 | 1 / 12 |
| 16 | `mealie3-16-fix-4ab0d730` | fix | 2/2 | 2/2 | 2/2 | $0.15 / $1.39 | 2 / 22 |
| 17 | `mealie3-17-feature-0c71c2a2` | feature | 2/2 | 2/2 | 2/2 | $0.09 / $1.10 | 1 / 11 |
| 18 | `mealie3-18-feature-c9bf6f1c` | feature | 2/2 | 2/2 | 2/2 | $0.13 / $1.41 | 1 / 16 |
| 19 | `mealie3-19-feature-8d6783bc` | feature | 0/2 | 0/2 | 2/2 | $0.38 / $2.74 | 14 / 35 |

## Labels

Every failed run was labelled from three sources: the failing test's output, the run's patch, and the request with its coverage notes. A saved result keeps only the last lines of a check's output, so each failed run was replayed with [bench/pilot/mealie/proof-replay.js](../pilot/mealie/proof-replay.js):
1. export the source tree at the item's parent;
2. apply the saved patch;
3. place the hidden tests;
4. run the target check's backend and frontend parts one at a time.

| Run | Backend target | Frontend spec | Label |
|---|---|---|---|
| w2, item 19, run 1 | passes | 14 of 15 | `spec-gap` |
| w2, item 19, run 2 | passes | 14 of 15 | `spec-gap` |
| e3, item 19, run 1 | passes | 14 of 15 | `spec-gap` |
| e3, item 19, run 2 | passes | 14 of 15 | `spec-gap` |

In all four, the one failing test is "blocks typing a minus sign".
- **What the test does:** it dispatches a DOM `keypress` event and expects it to be prevented. Upstream's component listens on `@keypress`.
- **What each agent did:** it prevented `-` on `keydown`. In a browser, a prevented `keydown` suppresses the `keypress` too, so each agent's input does block the minus a user types. The test fires `keypress` directly, so it does not see that.
- **Why `spec-gap`:** the request says "A minus-sign keypress is prevented" without naming the event. The protocol's rule labels that `spec-gap`: "the request does not state it, or states it ambiguously". The request is not changed during the run, and the gap is reported here.

**When the labels were written:**
- Each bare failure was labelled in scratch when it appeared, at 13:53Z. Every bare run had finished by 14:00Z.
- The bare labels were committed (`e30191d`) before stage 2, while the last engine process was still running. The hard-item set was computed from the committed file; it was also computed once, a moment before the commit, from the same file.
- The engine failures and all 299 refusals were labelled as runs finished, and committed (`4fbd5d3`) before any stage-1 engine figure was computed.

## The criteria

- **Primary: no verdict.** No item was hard, against the 3 needed. Stage 2 ran no runs.
- **Delivery: met.** 38 of 38 stage-1 engine runs delivered with a clean audit. No record failed its audit.
- **Friction: met.** 3 false refusals in 38 stage-1 engine runs, 0.08 per run, among 299 refusals. Every refusal was labelled before the figure was computed.
- **Correctness on every item (reported):** engine 36/38, bare 36/38. Stratified permutation test: difference 0.000, p = 1.0 (19 items, 76 runs).

The figures above come from this command:

```
node bench/pilot/proof.js --stage1 <scratch>/stage1 --labels bench/pilot/mealie/labels-proof/failures.json --refusals bench/pilot/mealie/labels-proof/refusals.json
```

Its friction step was added after registration (commit `1b14ade`), with a test, as the protocol's "refusal extractor as in the rerun". At the same time, the delivery figure was restricted to stage-1 engine runs, as the protocol states it. The labels were complete before the command ran.

## What the engine did (reported, no criterion)

These are from the engine runs' records and the saved patches, over all 38 engine runs and 38 bare runs:

| | Bare | Engine |
|---|---|---|
| Runs that added or changed tests | 13 | 38 |
| Regression tests `fix verify` proved (fail before, pass after) | — | 35, in all 30 fix-track runs |
| Lessons recorded | — | 30, one in each fix-track run |
| Reviews / findings / reviews asking for changes | — | 131 / 168 / 4 |
| Median cost | $0.12 | $1.26 |
| Median run time | 0.9 min | 15.7 min |

The four reviews that asked for changes were each resubmitted and approved:
- **Item 06, plan:** renaming the permission dependency's `__call__` would break how the app finds its permission checks. A test reads `dependency.call` on FastAPI's route dependencies.
- **Item 09, verification:** the change added `getattr` calls with literal names, which ruff's B009 rejects, and Mealie's pre-commit hook and CI would refuse the change. The resubmission kept the calls with `# noqa: B009`.
- **Item 10, verification:** a message file was edited after its phase was approved, so no review covered the delivered bytes.
- **Item 19, plan:** the plan named a locale path that does not exist.

None of them changes a hidden-check result: the bare runs of those items passed too.

### Mealie's own lint gate (post hoc, not registered)

This was decided after the registered result was known. It is reported as a lead, not a result.
- **The gate:** Mealie's backend CI runs `pre-commit run --all-files` in its step "Lint and Format (pre-commit)". Its ruff hooks are `ruff check --fix` and `ruff format` at v0.17.0, the version each item's environment has. The step fails if a hook changes a file or finds a violation it cannot fix.
- **The check:** [bench/pilot/mealie/proof-lint.js](../pilot/mealie/proof-lint.js) applies each saved patch to its item's source tree; its result per run is [results-proof/lint.json](../pilot/mealie/results-proof/lint.json). On the Python files the patch touches, it counts only what the patch introduces: violations beyond the same file's count before the patch, and files that are no longer formatted.
- **Not covered:** the other pre-commit hooks, mypy, Semgrep and frontend lint.

| | Would pass the step on the files touched | Lint violations introduced | Files left unformatted |
|---|---|---|---|
| Bare | 30 of 38 | 5 runs: `I001` (unsorted imports, 3), `B904`, `E501` | 6 runs |
| Engine | 37 of 38 | none | 1 run |

- **Findings checked by hand:** the `B904` is real. A bare patch for item 11 raises `HTTPException` inside an `except` block without `from`. One bare run on item 05 left a scratch test file in the project (`test_tmp_chk.py`), the file ruff would reformat.
- **The difference:** 0.18 (about 7 runs in 38), p = 0.024 by the same stratified test.
- **How to read it:** it is one post hoc measure, chosen after the primary result was known. It would need its own registered run to count. It fits what the records show: engine runs ran ruff and the project's checks as evidence before delivery.
- **How it was checked:** the first version of the script could not see formatting, because ruff 0.17 words its output differently. This was caught on a test file and fixed by reading the exit code of a per-file `ruff format --check`. The comparison was then rerun from scratch, and the committed tool reproduces it.

## Refusals

Engine transcripts only. Each refused call is counted once. Labels are in [refusals.json](../pilot/mealie/labels-proof/refusals.json).

| Label | Count | Classes (count) |
|---|---|---|
| `correct` | 109 | an eccode command built with shell expansion, held for a human (50); the main session acting as a role instead of dispatching it (39); a review citing files outside the submission (8); a review citing a pre-fix run that failed to import new API, which `fix verify` had recorded as inconclusive (4); an artifact changed after submission (2); an edit outside the claimed task's files (2); a reviewer writing a project file, delivery while a run was open, completion without the planned check, verification without a reproduction pair (1 each) |
| `harness` | 129 | the benchmark's tool list denied the call (125); a submit that found no report after Claude Code refused its write (4, row 131) |
| `agent-error` | 58 | a review file that did not follow its schema (22); a missing flag or an invented subcommand (18); a lesson whose failed attempts were strings (8, row 132); a handoff file that did not follow its schema (7); a reproduction recorded as a check, a behaviour change declared as a detected break, `fix verify` before any source change (1 each) |
| `false` | 3 | two reviews citing a reproduction `fix verify` had wrongly called inconclusive (row 133, fixed); one guard refusal of a line that ran `python -c` and named `.eccode` only as a grep path (row 91, named) |

The guard's rule in row 91 stays as it is. Judging the line segment by segment would let `cd .eccode`, a variable or a pipe carry a record path to an interpreter, and it would save one refusal in 38 runs.

**Not counted:** Claude Code's refusal of a subagent's report-named write is a tool error, not a permission denial, so the extractor does not count it. There were 64 such refused writes, at least one in every engine run. They are friction that the figure above leaves out.

## Defects found

- **Row 131, fixed (`698a6db`).**
  - **The defect:** Claude Code refuses a subagent's Write of a Markdown file whose name matches `^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$` (case-insensitive), as its own code shows. The delivery lead was told to write `.eccode/artifacts/verification/report.md`.
  - **The effect:** every engine run hit it. The delivery leads always got the report written another way, but four submits sent in the same batch found no file.
  - **History:** it was already in the rerun's transcripts and went unnoticed there.
  - **The fix:** the file is now `verification-report.md`, and a test scans every file shipped to agents, and the strings the CLI and hooks print, for a path that rule refuses.
- **Row 132, fixed (`e3e15f8`).**
  - **The defect:** `memory draft` left `failedAttempts` as `[]`, with nothing to show that an entry is `{approach, whyFailed}`. Agents wrote strings, and `memory add` refused the lesson on its schema (8 refusals).
  - **The fix:** the draft now holds one entry with TODO placeholders, to fill in or delete.
- **Row 133, fixed (`cde1a39`).**
  - **The defect:** `fix verify` called a whole pre-fix run inconclusive when any test failed on a name the fix adds.
  - **The case:** on item 05, 16 tests failed importing a helper the fix adds, and 6 failed assertions through API that existed before it, so the run did show the bug. Recorded as a check, it could not support a review, and two reviewers were refused.
  - **The fix:** a run is no longer inconclusive on new API when another test's report, in pytest's FAILURES section, shows an assertion failure that does not name it. Other output keeps the stricter rule.
  - **Corrected after review:** the independent review of the first version of this fix found two holes. The last report ran on into pytest's short test summary, whose truncated `FAILED ... AssertionError` line could make a run of new-API tests read as proven; and an error at setup counted as a test. Both are fixed with tests, and the rule was checked against real pytest 9.1.1 output.
- **Row 91, named:** one false refusal (see Refusals).

## Disclosures

- **Fixes committed during the batch.** The protocol puts fixes after the batch. The three fixes and the analysis change were committed while e2 ran its last items, in the main worktree. The batch ran from its own worktree at the protocol commit and could not see them.
- **What the operator saw before the analysis:**
  - each result line as it arrived (pass or fail, delivery, cost);
  - the replays of the failed runs;
  - the refusals, labelled in passes as runs finished, using the rerun's rules and a reading of each remaining refusal's full output, command and record.
- **An independent review** of the branch's code found, besides the two `fix verify` holes above, that the lint tool would have read a ruff that did not run as clean, and several smaller gaps in the tools and the analysis's edge cases. Each was fixed with a test. The lint figures were recomputed with the corrected tool and did not change.
- **One labelling error, corrected before the labels were committed.** A rule written for one ownership refusal (a scratch test file) gave its reason to another (an edit of `mealie/pkgs/img/minify.py`). The label, `correct`, did not change. Each rule whose reason describes one case is now pinned to the run it was checked on, and ownership refusals name the file.
- **Smoke runs** before registration: one bare and one engine run on item 2, both passing, disclosed in the protocol.
- **Environment:**
  - `go-task` was installed before registration; the rerun lacked it.
  - `pnpm` runs with dependency verification off, as the protocol records.
- **Agent sessions carry the account's context.** Each `claude -p` session runs under the operator's Claude account. Transcripts stay outside the repository.

## What this means

- **This is the fourth batch in which the bare agent was rarely wrong**, now on 19 real changes newer than anything ECCode was fixed against. Its only failures came from a gap in the request, which no process could have caught. Whether the engine improves correctness where a bare agent errs is still unmeasured, and row 59 stays open.
- **The engine now delivers on a real project.** 38 of 38 runs delivered with a clean audit, and false refusals stayed well under the rule. Row 104 closes under its pre-registered rule for single items; ten-item chains are not re-measured here.
- **What the engine adds is the evidence for a change, at a price.** Every engine run left tests. Every fix-track run left a proven regression test and a lesson. Reviews caught a few real problems, and engine patches passed the project's lint gate more often (post hoc). It cost about 11× a bare run and took about 17× as long.
- **Finding where the engine helps correctness needs items a bare agent gets wrong.** On this evidence, those are not the typical change of a well-tested project. A next run would have to look for them on purpose:
  - a weaker or cheaper model as the bare agent;
  - larger multi-file features;
  - changes whose tests a request cannot state in full.
