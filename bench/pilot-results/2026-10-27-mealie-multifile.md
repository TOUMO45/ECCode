# The multi-file run: does the engine fix what a bare agent gets wrong on large changes?

Protocol: [bench/protocols/2026-10-27-mealie-multifile.md](../protocols/2026-10-27-mealie-multifile.md), registered at commit `e336eed` (2026-10-27T00:50:10Z) before any measured run, with amendment 1 (`4584f73`) after a container restart in stage 1. Saved runs: [2026-10-27-mealie-multifile.runs.jsonl](2026-10-27-mealie-multifile.runs.jsonl), and stage 1's registered reading in [2026-10-27-mealie-multifile.registered.jsonl](2026-10-27-mealie-multifile.registered.jsonl). Labels: [failures.json](../pilot/mealie/labels-multifile/failures.json), [failures-registered.json](../pilot/mealie/labels-multifile/failures-registered.json) and [refusals.json](../pilot/mealie/labels-multifile/refusals.json). The batch before it: [the proof run](2026-10-26-mealie-proof.md).

## In short

The proof run could not tell whether ECCode's engine improves correctness: on Mealie changes of at most 400 lines, the bare agent was almost never wrong (register row 59). This run asked again on the largest changes in Mealie's recent history: 16 items of 121 to 1,355 changed lines across 6 to 30 files. Stage 1 ran each item 3 times bare. An item was **hard** when a bare run failed a hidden check by its own mistake. Stage 2 then ran 6 bare and 6 engine runs on each hard item, and only those runs decide the comparison.

- **The bare agent did get large changes wrong.** It passed 40 of 48 stage-1 runs. Six failures were its own mistakes, on items 01, 05 and 07, which made those three items hard. The other two were gaps in item 03's request.
- **Primary: missed.** On the hard items in stage 2, the engine passed 12 of 18 runs and the bare agent 9 of 18. The stratified test gives a difference of 0.167 and p = 0.50, and the rule needs p < 0.05.
  - **Item 01:** engine 4/6, bare 1/6. Every bare run, and one engine run, named an enum's members `ALWAYS` and `FALLBACK` where the request says `always` and `fallback`.
  - **Item 05:** engine 6/6, bare 3/6. Each failing bare run left out one proxy setting the request states.
  - **Item 07:** engine 2/6, bare 5/6. Four engine runs reached the 7,200 s timeout, and a run cut by the timeout counts as a failure.
  - In the registered reading of stage 1, the container restart left only item 01 hard, so that reading has no verdict.
- **The engine fixed the mistakes it had time to fix.** Graded on a clean tree with the timeout rule set aside, 17 of the 18 engine patches pass every hidden check, against 9 of 18 bare (p = 0.004). That is post hoc, not the registered test. The one engine patch that fails there repeats item 01's naming mistake, past five reviews.
- **Delivery: missed.** 9 of 18 stage-2 engine runs delivered with a clean audit, against a rule of at least 80%. None of item 07's six delivered.
  - Four runs reached the timeout.
  - Five stopped to ask a user, and in a headless run no one answers. Four of those stopped after the benchmark's tool list refused a command they needed: a command with an environment-variable prefix (twice), `rm`, and Mealie's code generator. The fifth stopped because a test file that had to change belonged to no task, and only the user may rescope a task on the feature track.

  The proof run's 38 of 38 deliveries were on small changes. Large changes are a new open row (138).
- **Friction: met.** 3 false refusals in 18 stage-2 engine runs, 0.17 per run, among 348 refusals.
- **The engine costs more and takes much longer.** The median stage-2 engine run cost 7.7× a bare run ($3.27 against $0.43, with the four timed-out runs' cost estimated) and took 48.5 minutes against 6.3.
- **The run found six defects.**
  - Four are fixed, each with a test that failed first. Two are mitigated and stay open.
  - Two engine defects refused legitimate steps, both in one item 05 run. A subagent stopped at each, and the run still delivered:
    - a lock that timed out the moment a check ended (row 134, fixed);
    - a gate that refused an empty `__init__.py` (row 135, fixed).
  - One harness defect failed engine runs whose changes pass on a clean tree: hidden checks read a stale test database the agent's own runs had left (row 136). It is fixed for single runs and source-backed chains; in a greenfield chain, later items' checks still see earlier items' leftovers.
  - The cost of a timed-out run is unknown to the cost ceiling (row 137, mitigated).
  - One defect was in this run's own analysis: it counted a timed-out run by its hidden checks. It was fixed before any figure was reported.
  - `ps` joined the guard's read-only list (row 91's rule stands).

## What ran

- **Subject:** Mealie, over v3.20.0..`75332567`. The window spans the pilot's, the rerun's and the proof run's.
  - **The items:** every eligible large multi-file change was drawn and validated ([bench/suites/mealie4](../suites/mealie4/README.md)). A change is eligible with at least 5 files, at least 4 of them under `mealie/`, and 100 to 1,500 changed lines. Tests, docs, translations and lockfiles are not counted.
  - **Accepted:** 16 items, 12 features and 4 fixes. One candidate was skipped because no test fails on its parent, and the fallback window was not needed.
- **Requests:** issue-style, each stating every behaviour its target tests check. Agents drafted them from the commits, and the operator reviewed and approved each one before registration.
- **Model:** Sonnet in every session, through `claude -p` with the rerun's tool list ([bench/pilot/agents-rerun.sh](../pilot/agents-rerun.sh)). Engine runs used the guard profile and delivered on their item's track (fix or feature).
- **Stage 1:** 3 bare runs per item and no engine runs. Processes w1, w2 and w3 took items 01–06, 07–11 and 12–16.
  - They were launched at 00:50:25Z from a worktree pinned at the protocol commit.
  - **The container restarted at about 01:28Z.** Three runs were cut and 38 had not started.
  - Amendment 1 was committed at 01:32:04Z. The processes resumed at 01:32:25Z with `bench/pilot/resume.js runs` and ended at 03:24Z (w3), 04:19Z (w1) and 04:46Z (w2).
  - The three cut runs were run again from 04:47Z to 05:06Z.
  - The longest stage-1 run took 32 minutes.
- **Stage 2:** 6 bare and 6 engine runs on each hard item, from 05:09:13Z.
  - s2e1, s2e2 and s2e3 ran the engine on items 01, 05 and 07; s2w ran every bare run.
  - s2e2 ended at 08:27Z, s2w at 08:35Z, s2e1 at 11:37Z and s2e3 at 14:36Z.
- **Cost:**
  - Stage 1: $30.17, including $1.55 for the three replacement runs.
  - Stage 2: $50.47 by the runs' result lines (bare $7.83, engine $42.64), plus about $15.89 for the four timed-out engine runs, which print no result line (row 137).
  - The estimate prices each timed-out run's transcript tokens at $1.64 per million weighted tokens. That rate is fitted on the 32 stage-2 runs that ended, which ranged from $1.57 to $1.72.
  - Even with the estimate, each process stayed under its registered ceiling: s2e3 spent about $22 of $35.70. The batch total is about $97, against a budget of $310.
  - Two smoke runs before registration cost $7.53 and are disclosed in the protocol.

## Stage 1: every item, bare

| # | Item | Track | Lines / files | Bare passed | Failure labels | Median cost | Median minutes |
|---|---|---|---|---|---|---|---|
| 1 | `mealie4-01-feature-17398941` | feature | 596 / 6 | 0/3 | agent-error ×3 | $0.36 | 5.4 |
| 2 | `mealie4-02-feature-824265b3` | feature | 556 / 21 | 3/3 | — | $0.70 | 15.0 |
| 3 | `mealie4-03-feature-a1a49d22` | feature | 785 / 21 | 1/3 | spec-gap ×2 | $1.45 | 20.8 |
| 4 | `mealie4-04-feature-e3cf55b9` | feature | 479 / 13 | 3/3 | — | $0.34 | 2.7 |
| 5 | `mealie4-05-fix-fb221afa` | fix | 471 / 8 | 1/3 | agent-error ×2 | $0.56 | 5.5 |
| 6 | `mealie4-06-fix-30ba9a65` | fix | 213 / 10 | 3/3 | — | $0.51 | 9.5 |
| 7 | `mealie4-07-feature-b386e728` | feature | 455 / 15 | 2/3 | agent-error | $0.36 | 18.3 |
| 8 | `mealie4-08-fix-e1c228e6` | fix | 121 / 6 | 3/3 | — | $0.19 | 3.2 |
| 9 | `mealie4-09-feature-36d716a4` | feature | 751 / 24 | 3/3 | — | $1.26 | 21.0 |
| 10 | `mealie4-10-feature-97a66c19` | feature | 738 / 22 | 3/3 | — | $0.72 | 23.3 |
| 11 | `mealie4-11-feature-4a280cbd` | feature | 580 / 12 | 3/3 | — | $0.39 | 2.3 |
| 12 | `mealie4-12-fix-ec3e0305` | fix | 145 / 15 | 3/3 | — | $0.51 | 11.1 |
| 13 | `mealie4-13-feature-bf16ca15` | feature | 553 / 12 | 3/3 | — | $0.51 | 8.1 |
| 14 | `mealie4-14-feature-cd2097ee` | feature | 1355 / 30 | 3/3 | — | $1.76 | 15.8 |
| 15 | `mealie4-15-feature-c935e04f` | feature | 248 / 13 | 3/3 | — | $0.31 | 2.7 |
| 16 | `mealie4-16-feature-a2149447` | feature | 286 / 26 | 3/3 | — | $0.11 | 1.5 |

"Lines / files" counts the upstream change's non-test lines and files, as the selection rule counts them. The figures are the continued reading's (amendment 1), which chooses the hard items. In the registered reading, the cut and never-started runs are failures labelled `harness`. That reading passes 4 of 48, and only item 01 is hard.

## Labels

Every failed run was labelled from three sources: the replayed failing check's full output, the run's patch, and the request with its coverage notes. The replay ([bench/pilot/mealie/proof-replay.js](../pilot/mealie/proof-replay.js)) exports the item's parent, applies the saved patch, places the hidden tests, and runs each check on that clean tree.

**Stage 1 (committed in `16b5272` at 05:08:07Z, before stage 2 started at 05:09:13Z):**

| Item | Runs | Label | What failed |
|---|---|---|---|
| 01 | w1 runs 1–3 | `agent-error` | The request names the enum members `always` ("always") and `fallback` ("fallback"). Every run defined `ALWAYS` and `FALLBACK`, so the target file fails at import and none of its tests run. A close call: the names are stated in prose, and all three runs chose the upper-case convention. |
| 03 | w1 runs 2–3 | `spec-gap` | The backend passes, but 10 of 41 frontend tests fail with "plugin is not a function". The change rewrote the axios plugin as an object with a `setup` property, which the spec's stub cannot call. The request says only that the spec "calls the plugin setup function", which reads naturally as that property. |
| 05 | w1 runs 1, 3 | `agent-error` | Three target tests fail because the change never sets `CurlOpt.NOPROXY`. The request gives its values: `"*"` without a proxy, `""` with one, and still `""` after a pin. |
| 07 | w2 run 3 (the cut run's replacement) | `agent-error` | `test_recipe_note_step_references` fails because the change stores a step's note reference without an id (NOT NULL constraint). The request says the repository stores those references and loads them back. |

**Stage 2 (committed in `516c1a2` at 14:42:19Z, before any stage-2 figure was computed):**

| Runs | Label | What failed |
|---|---|---|
| s2w item 01, runs 2–6 | `agent-error` | As in stage 1: `ALWAYS` and `FALLBACK`. |
| s2w item 05, runs 2–4 | `agent-error` | As in stage 1: `NOPROXY` is never set. |
| s2w item 07, run 5 | `agent-error` | As in stage 1: a note reference row inserted without an id. |
| s2e1 item 01, run 6 | `agent-error` | Delivered after five reviews with the bare runs' mistake: `ALWAYS` and `FALLBACK`. |
| s2e1 item 01, run 2 | `harness` | Both checks fail on `duplicate column name: original_text`, because they ran over a stale `tests/.temp/mealie.db` the agent's own test runs had left. The agent tried to delete it, but the benchmark's tool list refuses `rm` for every variant. On a clean tree, the change passes both checks. |
| s2e3 item 07, runs 2, 4 and 5 | `harness` | Each reached the 7,200 s timeout. In the sandbox, their checks failed on the stale database or on tests it broke. On a clean tree, each change passes both checks. |
| s2e3 item 07, run 3 | `harness` | Reached the 7,200 s timeout with both hidden checks passing; a run cut by the timeout counts as a failure. Labelled later, in the commit that fixed the final review's findings: the committed labels had missed it because the first analysis read it as a pass (see The criteria). No figure changes. |

The bare failures' check output names the code error itself: an import failure, a `KeyError`, a constraint. A stale database cannot cause these.

## The criteria

**Primary: missed.** Over the stage-2 runs on the three hard items, the engine passed 12 of 18 and the bare agent 9 of 18. Stratified permutation test: difference 0.167, p = 0.4972 (3 items, 36 runs, 20,000 resamples, seed 42).

| Item | Bare passed | Engine passed | Engine delivered, clean audit | Median cost, bare / engine | Median minutes, bare / engine |
|---|---|---|---|---|---|
| 01 | 1/6 | 4/6 | 5/6 | $0.39 / $3.07 | 5 / 63 |
| 05 | 3/6 | 6/6 | 4/6 | $0.53 / $2.66 | 4 / 37 |
| 07 | 5/6 | 2/6 | 0/6 | $0.41 / $3.88 (4 of 6 estimated) | 19 / 120 |

**Delivery: missed.** 9 of 18 stage-2 engine runs on the hard items (50%) delivered with a clean audit, against a rule of at least 80%. No record failed its audit.

**Friction: met.** 3 false refusals in 18 stage-2 engine runs on the hard items, 0.17 per run, among 348 refusals. Every refusal was labelled before the figure was computed.

**The registered reading of stage 1** (amendment 1) has one hard item, item 01, so its primary has no verdict. On that item: engine 4/6, bare 1/6. Delivery is 5 of 6 and friction 0 false refusals in 6 runs; both rules are met there.

The figures come from this command, and the registered reading's from the same command with `stage1/reading-registered` and `failures-registered.json`:

```
node bench/pilot/multifile.js --stage1 <scratch>/stage1/reading-continued --stage2 <scratch>/stage2 \
  --labels bench/pilot/mealie/labels-multifile/failures.json --refusals bench/pilot/mealie/labels-multifile/refusals.json
```

**A correction before reporting.** The first computation counted s2e3's item 07 run 3 as an engine pass, giving 13 of 18 and p = 0.30. That run reached the timeout with both hidden checks passing. The protocol says "a run cut by the timeout still counts as a failure in every pass rate", but the tool judged runs by their hidden checks alone. The proof run had no timeout, so it had never mattered. The tool was fixed with a test that failed first (`multifile run: a run cut by the timeout fails, whatever its hidden checks`), and the figures above are from the fixed tool.
- **Where the fix sits:** in `bench/pilot/proof.js`'s `passed()`, which now fails a run marked `timedOut`, and in `multifile.js`, which marks runs of at least 7,200 s.
- **A departure from the plan:** the plan and spec keep `proof.js` as the proof run registered it. The change leaves every proof-run figure as it was, because no proof-run record carries `timedOut`, and its tests still pass.
- **The registered command after the final review:** it now also skips a saved file's typed lines, so a process stopped at its cost ceiling is not read as a run. The figures did not change.

### Sensitivity readings (post hoc, not registered)

| Reading | Engine | Bare | Difference | p |
|---|---|---|---|---|
| Registered: as recorded, timeouts fail | 12/18 | 9/18 | 0.167 | 0.50 |
| The fixed harness (row 136): the stale-database failure graded on a clean tree, timeouts still fail | 13/18 | 9/18 | 0.222 | 0.31 |
| Every patch on a clean tree, the timeout rule set aside | 17/18 | 9/18 | 0.444 | 0.004 |
| Without item 01 (its close-call label) | 8/12 | 8/12 | 0.000 | 1.0 |
| Without item 01, every patch on a clean tree | 12/12 | 8/12 | 0.333 | 0.09 |

How to read these:
- **Every reading that keeps the protocol's timeout rule misses.** The registered reading is the result.
- **The clean-tree reading is about the patches, not the runs.** Four of item 07's engine runs were cut at 120 minutes, mid-work and undelivered. That their patches already passed shows the engine was getting item 07 right, but slowly. It does not show the engine delivers it.
- **Without item 01, two items remain**, too few for a verdict under the protocol.
- **Item 01's label decides whether there are three hard items.** If its failures had been labelled `spec-gap`, the continued reading would have no verdict.

## Why engine runs did not deliver

| Runs | Hidden checks | Why the run stopped |
|---|---|---|
| Item 07, runs 2–5 | 1 of 4 passes both in the sandbox, 4 of 4 on a clean tree | The 7,200 s timeout. Item 07's other two engine runs took 47 and 18 minutes. |
| Item 05, runs 1 and 4 | 2/2 | The plan pinned a check of `python -c "import …"`, which needs `PRODUCTION=false` outside pytest. The benchmark's tool list refused every command with that prefix, and only the user may rescope a task on the fix track. Each run stopped and asked. |
| Item 07, run 1 | 2/2 | Three existing tests in a file no task owned needed updating. Only the user may rescope on the feature track, so the run stopped and asked. |
| Item 07, run 6 | 2/2 | The design said two files come only from Mealie's code generator, and the tool list refused the generator (`python dev/code-generation/main.py`). The run stopped and asked rather than hand-edit generated files. |
| Item 01, run 2 | 0/2 in the sandbox, 2/2 on a clean tree | Its own test runs failed on a stale test database, and the tool list refuses `rm`. The run stopped and asked. |

- **Four of the five stops came from the benchmark's tool list**, which is the same for both variants. A bare agent blocked by it can work around a refusal or leave a step out. An engine run with a pinned check, an approved plan and a record to complete stops and asks instead. That is the engine working as designed, and in a headless batch it reads as non-delivery.
- **All nine undelivered patches pass every hidden check on a clean tree.** Five passed them as recorded, one of those cut by the timeout.
- **The proof run's 38 of 38** were changes of at most 400 lines that took at most 54 minutes. On these large changes, plans pinned checks that could not run in the benchmark's environment, missed a file, or took longer than 120 minutes.

## What the engine did (reported, no criterion)

Over the 18 stage-2 engine runs and 18 stage-2 bare runs:

| | Bare | Engine |
|---|---|---|
| Runs whose patch adds or changes tests | 10 | 15 |
| Reviews recorded / reviews asking for changes / findings | — | 75 / 14 / 144 |
| Reproduction runs before the fix (`fix verify`, item 05 is the one fix) | — | 9, in 4 of 6 runs |
| Lessons recorded | — | 6, in 4 of item 05's 6 runs |
| Runs that ran mutation testing | — | 7 |
| Median cost | $0.43 | $3.27 (four estimated; $2.96 over the 14 that ended) |
| Median run time | 6.3 min | 48.5 min |

In stage 1, 34 of the 48 bare runs added or changed tests.

**Reviews caught real problems, but not item 01's.**
- **Item 05:** plan reviews asked for changes in three runs. They found plans that would break existing tests no task owned (one mocks `requests.post`), and a reproduction that could not fail honestly.
- **Item 07:** reviews asked for changes three times in run 1: the design once and the plan twice.
- **Item 01:** run 6 delivered after five reviews and 14 recorded checks, with `ALWAYS` and `FALLBACK`. The reviews did not catch the member names.

### Mealie's lint gate (post hoc, not registered)

[bench/pilot/mealie/proof-lint.js](../pilot/mealie/proof-lint.js), the proof run's tool, applies each stage-2 patch and counts what it introduces on the Python files it touches. Its results are in [results-multifile/lint.json](../pilot/mealie/results-multifile/lint.json).

| | Would pass ruff check and format on the files touched | Lint violations introduced | Runs leaving a file unformatted |
|---|---|---|---|
| Bare | 11 of 18 | 1 run: `I001` | 7 runs |
| Engine | 12 of 18 | 3 runs: `I001`, `UP042`, `E501` | 5 runs |

- **No difference here:** 0.056, p = 1.0.
- **Why the bare count is low:** all six bare runs on item 07 leave the same model file unformatted.
- **The proof run's lead does not replicate on large changes.** There, 37 of 38 engine patches passed against 30 of 38 bare.

## Refusals

Engine transcripts only, every stage-2 engine run. Each refused call is counted once. The labels are in [refusals.json](../pilot/mealie/labels-multifile/refusals.json).

| Label | Count | Classes (count) |
|---|---|---|
| `harness` | 229 | the benchmark's tool list denied the call (229) |
| `agent-error` | 60 | a review file that did not follow its schema (20); a handoff file that did not follow its schema (14); `evidence run` without its `--label` (7); an invented subcommand (`task show`, `work show`, `review`, `memory status`: 8); a missing argument or flag (3); a review in the wrong gate state (2); evidence cited that is not in the record (3); a directory as an artifact, a gate the track lacks, a mutation command that failed on unmodified code (1 each) |
| `correct` | 56 | an eccode command built with shell expansion, held for a human (19); the main session acting as a role (11); a review citing files outside the submission (5); completion without the planned check or a changed test (4); a lesson whose verification was another command's run (3); an edit outside the claimed task's files (3); a removed public name the request keeps importable (2); the CLI through a shell variable (2); a reviewer writing a probe test, a handoff written by hand, a third concurrent claim, an approval with an unresolved finding, a review citing a failed probe, a review citing a pre-fix check, an unresolvable `rm -rf $D` (1 each) |
| `false` | 3 | an evidence run refused on the record lock's 10 s wait after waiting behind two checks (row 134, fixed); a phase gate refused over an empty `__init__.py` its task added (row 135, fixed); `ls -t .eccode/evidence; ps aux | grep -c …` refused because `ps` was not on the guard's read-only list (row 91: `ps` added, the rule stands) |

## Defects found

- **Row 134, fixed (`800cbb0`).**
  - **The defect:** an evidence run that waited behind running checks was refused with `LOCK_TIMEOUT` the moment they ended. The 10 s wait for an ordinary lock had been counting the time spent behind the checks, so the checks' own brief commit of their results read as a 10 s hold.
  - **The fix:** the ordinary wait now counts from the last moment a check held the record.
- **Row 135, fixed (`800cbb0`).**
  - **The defect:** a gate refused any empty artifact. A phase gate always submits its tasks' changed files, so an empty tests-package `__init__.py` blocked the phase, and nothing could cover the file at verification either. The delivery lead stopped to report it.
  - **The fix:** an empty file is accepted beside others. A submission of nothing but empty files is still refused.
- **Row 136, mitigated (`86c9668`), harness.**
  - **The defect:** hidden checks ran in the agent's sandbox, over git-ignored files its session left behind. A test database the agent's test runs had migrated failed changes that pass on a clean tree: four engine runs here.
  - **The fix:** before the checks, the harness removes ignored files the agent left. Ignored files that were there before it started, such as setup's links, and the record stay. The final review found that an ignored nested repository crashed the cleanup and with it the batch; such a leftover is now removed whole, and one that cannot be removed is named in the run's record.
  - **What stays open:** in a greenfield chain, an item's checks still see the ignored files earlier items' agents left. Its setup runs on the shared workspace, so the harness cannot tell them from setup's own.
- **Row 137, mitigated (`86c9668`), harness.**
  - **The defect:** a run cut by the timeout carried no cost and no mark.
  - **The fix:** it is now marked `timedOut` and keeps its transcripts' token counts, counting each message once. On the 32 stage-2 runs that ended, those counts equalled the reported tokens in 28 and came within 1.4% in the other 4.
  - **What stays open:** the cost of a timed-out run remains unknown to `--max-cost`, because the transcripts hold no prices.
- **Row 91, partly addressed (`fa0dfe0`):** `ps` writes no file and is now on the guard's read-only list. The rule itself stands.
- **The analysis tool, fixed (`23e25f7`):** it counted a timed-out run by its hidden checks, against the protocol (see The criteria).
- **Row 138, named:** delivery on large changes (above).

## Disclosures

- **The restart:** the container restarted 38 minutes into stage 1. Amendment 1 was committed before stage 1 continued, and both readings are reported.
  - `bench/pilot/multifile.js` gained its readings helper at 01:33:42Z (`b86c7f6`), just after the processes resumed. It writes analysis inputs and affects no run.
- **Fixes committed during the batch.** The protocol puts fixes after the batch. The fixes for rows 134–137 and 91 were committed while item 07's last engine runs ran, in the main worktree. The batch ran from its own worktree at the protocol commit and could not see them.
- **What the operator saw before the analysis:**
  - each result line as it arrived (pass or fail, delivery, cost);
  - the replays of failed runs;
  - each undelivered run's final message;
  - the refusals, labelled in passes as runs finished, using the proof run's rules and a reading of each remaining refusal's full output.
- **One refusal rule was added in the last pass:** a review that cited a command and its result as an artifact path is labelled `agent-error`. The 289 refusals labelled before it kept their labels.
- **An engine run changed a toolkit file.** s2e3's item 07 run 4, cut by the timeout, changed a file under `.claude/`. No tool call in its transcripts writes there, and the sandbox is gone, so the cause is not known. The change is not in the measured patch.
- **Smoke runs** before registration, on item 14, are disclosed in the protocol.
- **Agent sessions carry the account's context.** Each `claude -p` session runs under the operator's Claude account. Transcripts stay outside the repository.

## What this means

- **On large changes, the bare agent does make its own mistakes.** It did on 3 of 16 items, and on two of them in more than half of 9 runs. Row 59 asked for exactly this, and these are the first such items in four batches.
- **The engine fixed those mistakes on two of the three items:** item 05 every time, and item 01 in 4 of 6 runs (5 of 6 counting the stale-database run). Its only clean-tree failure is a reviewed delivery with the bare agent's own mistake. Reviews did not check member names against the request.
- **The registered comparison still missed.** The engine ran out of time on item 07, the one hard item the bare agent mostly got right. With 3 items and 6 runs each, a difference of 4 runs in 18 is not enough for p < 0.05.
  - Whether the engine improves correctness on large changes is still not shown, and row 59 stays open.
  - What changed is the obstacle. It is no longer that the bare agent is never wrong. It is the engine's time, and its stops in a headless batch.
- **Delivery is the engine's limit on large changes (row 138).** Half of the stage-2 engine runs delivered:
  - four ran past 120 minutes;
  - five stopped and asked about a refused command, a missing owner or a generated file, as the process says they should.

  A next run would need a longer timeout or smaller phases, a benchmark tool list that allows what the project's own checks need, and a way to resolve a plan's missing owner without a human.
- **The engine took about 7.7× the cost and 7.7× the time of a bare run here.** By the analysis tool, which leaves out the four timed-out runs, the cost ratio is 6.9×.
