# Pre-registered protocol: does the engine deliver large changes once their blockers are fixed?

Committed and pushed before any measured run starts; the git commit timestamp is the registration. Where this protocol says nothing, the multi-file run's protocol ([2026-10-27-mealie-multifile.md](2026-10-27-mealie-multifile.md)) applies, and through it the proof run's, the rerun's and the pilot's. The design is the approved spec, [docs/specs/2026-10-27-delivery-run-design.md](../../docs/specs/2026-10-27-delivery-run-design.md), and the plan is [docs/plans/2026-10-27-delivery-run.md](../../docs/plans/2026-10-27-delivery-run.md).

**Why.** The multi-file run missed its delivery rule (register row 138). Only 9 of its 18 stage-2 engine runs delivered with a clean audit, against a rule of at least 80%. All nine undelivered changes pass every hidden check on a clean tree: the engine was close to delivering each of them, and then stopped. The [multi-file report](../pilot-results/2026-10-27-mealie-multifile.md) traced each stop to a cause:

| Runs | What stopped them | Fix in this run |
|---|---|---|
| Item 07, runs 2–5 | The 7,200 s limit. The engineer, test engineer and reviewer each re-ran broad test directories, 5–14 minutes a run; one check hit the 10-minute evidence timeout and ran again. | Checks sized to the step, a 30-minute evidence default, a 4-hour run limit with delivery within 2 hours reported |
| Item 05, runs 1 and 4 | The plan pinned a check that needs `PRODUCTION=false` outside pytest. The tool list refused every env-prefixed command, and only the user could rescope a task of a reviewed plan. | Reviewed rescope; `PRODUCTION=false` in the task environment; variables inside the check command |
| Item 07, run 1 | Three existing tests needed updating in a file no task owned; only the user could rescope. | Reviewed rescope |
| Item 07, run 6 | The design called for Mealie's code generator, which needed `PYTHONPATH=.` | `PYTHONPATH=.` in the task environment |
| Item 01, run 2 | Its own test runs failed on a stale `tests/.temp/mealie.db`, and the tool list refused `rm`. | The tool list allows deleting `tests/.temp` |

**What it must show:** that with these blockers fixed, the engine delivers large multi-file changes under row 138's rule, at least 80% of engine runs, on items it has never run before as well as on the three that failed.

**What it does not try to show:** that the engine raises correctness where a bare agent errs (row 59). Engine and bare pass rates are reported with no criterion.

## What changed since the multi-file run

**Engine** (the changes of v0.16.0; the version is bumped with the docs after the batch, so the worktree still reads 0.15.0):
- **Reviewed rescope** (`lib/tasks.js`). On a reviewed plan, the plan's author (the delivery lead) proposes a rescope with `eccode task rescope … --actor delivery-lead`, which records `task.rescope_proposed` and changes nothing. A plan reviewer who is not the proposer (the technical reviewer) approves or rejects it with `eccode task rescope-review`. An approval applies it as `task.rescoped`, naming the proposal and the approver. The task must be pending at both steps, a task has at most one open proposal, file-ownership conflicts are checked when the change is applied, and every changed file must still be covered by an approved gate. The user's own rescope and the orchestrator's on one-task tracks are unchanged. The MCP server has the same pair (`task_rescope`, `task_rescope_review`).
- **Evidence default:** `eccode evidence run` waits 1,800 s by default, up from 600 s; `--timeout` still overrides it.
- **Guidance** (`agents/*.md`, `skills/orchestrate/SKILL.md`): engineers and test engineers run their task's planned check and the tests they changed, not whole test directories; reviewers run the narrowest check that covers a submission, and the broad suite runs once at verification; the delivery lead writes checks that run in the project's dev environment as written (`env NAME=value …`) and proposes a rescope instead of asking the user; the orchestrator sends a proposal to the technical reviewer.

**Harness, the same for both variants:**
- **The dev environment:** every mealie4 task's `env` gains `PRODUCTION=false` (Mealie's `Taskfile.yml` sets it for every dev task) and `PYTHONPATH=.` (the tree importable, as an editable install makes it). The tasks were rebuilt with `build.js`; nothing else in them changed.
- **The agent command:** `$AGENT_D` in [bench/pilot/agents-delivery.sh](../pilot/agents-delivery.sh) is `$AGENT_B` plus `Bash(rm -rf tests/.temp*)`, `Bash(rm -r tests/.temp*)` and `Bash(rm tests/.temp*)`. Everything else stays refused, as in `$AGENT_B`.
- **The run limit:** `--timeout 14400` (4 hours, up from 2).

## Items

All 16 mealie4 items, as drawn, validated and requested for the multi-file run (its protocol's Items section has the table), unchanged except for the environment above.
- **In-sample (3 items, 6 planned engine runs):** `mealie4-01-feature-17398941`, `mealie4-05-fix-fb221afa` and `mealie4-07-feature-b386e728`. Their failures shaped the fixes.
- **Out-of-sample (13 items, 26 planned engine runs):** the engine has never run on them.
- **Operator exposure:** the operator has seen 3 bare runs of every item (multi-file stage 1), 6 bare and 6 engine runs of the three in-sample items (stage 2), and the smoke run below.

**Live validation of the rebuilt tasks,** before registration:
- **How:** the multi-file run's live check (`tests/mealie.test.js`, "mealie4 live"), in three parallel shards (items 01–06, 07–11 and 12–16), each running every item's checks in the task environment above. For every item, the target check must fail at the source commit and pass at the fix commit, and the regression check must pass at both.
- **Result:** all 32 checks as required, 16 items at both commits, from 21:58 to 22:14 UTC on 2026-10-27. The environment change makes no hidden check pass at its source commit, so no item became easier to pass by it. Item 05, whose planned check was one of the runs that stopped on `PRODUCTION`, still fails its target at the source commit and passes at the fix.

## What runs, and where

- **ECCode under test:** the commit of this protocol, from a git worktree pinned at it (`/tmp/mp/wt5`).
- **Machine:** the multi-file run's container: 4 cores, 15 GB RAM, Node 22.22.0, Claude Code CLI 2.1.312 (2.1.311 in the multi-file run), model alias `sonnet`, uv 0.11.32, pnpm 10.28.0 and go-task 3.54.0.
- **Environments:** the shared venvs and `node_modules` under `ECCODE_MEALIE_ENVS=/root/.cache/eccode/mealie-envs`, with `TMPDIR=/tmp/mp`.
- **Agent command:** `$AGENT_D`, the same for both variants.

## Variants and processes

Two variants, Sonnet, independent runs. Each run is a fresh sandbox at the item's source commit with a fresh record; there are no chains and no stages.
- **`without`:** the bare request.
- **`engine`:** the toolkit installed with `--engine-profile guard --engine-agents inherit`, with the request delivered through the item's track (fix or feature).

**Every run has `--timeout 14400`.** The common function runs from `/tmp/mp/wt5`:

```
source bench/pilot/agents-delivery.sh
D() { node bin/eccode.js bench --suite bench/suites/mealie4 --timeout 14400 --agent "$AGENT_D" "$@"; }
```

Four processes, launched together. Each has `--save <scratch>/delivery/<name>.jsonl --transcripts <scratch>/delivery/tr-<name>`:

| Process | Variant | Items | Runs | `--max-cost` |
|---|---|---|---|---|
| e1 | engine | 01–06 | 12 | 60 |
| e2 | engine | 07–11 | 10 | 60 |
| e3 | engine | 12–16 | 10 | 60 |
| w | without | 01–16 | 32 | 30 |

```
D --tasks <items 01-06> --variant engine --runs 2 --engine-profile guard --engine-agents inherit --max-cost 60 ...
D --tasks <items 07-11> --variant engine --runs 2 --engine-profile guard --engine-agents inherit --max-cost 60 ...
D --tasks <items 12-16> --variant engine --runs 2 --engine-profile guard --engine-agents inherit --max-cost 60 ...
D --tasks <items 01-16> --variant without --runs 2 --max-cost 30 ...
```

- **Budget:** about $3.30 an engine run and $0.45 a bare run by the multi-file run's medians, so $180 for the engine processes and $30 for w at most: **$210 in all**, plus the smoke run.
- A process stops starting new runs at its `--max-cost`. **A planned engine run it did not start counts as not delivered.** Bare runs not started are reported as not run and never imputed.
- `--max-cost` counts only the cost an agent reports; a run cut by the timeout reports none (register row 137). The report estimates those runs' cost from their transcript tokens.

**Smoke run** before registration, not counted and disclosed here: one engine run on item 08 (`mealie4-08-fix-e1c228e6`, fix track) from the working tree, with `$AGENT_D` and `--timeout 14400`, saved under `<scratch>/delivery-smoke`.

| Run | Hidden checks | Time | Cost | Engine |
|---|---|---|---|---|
| engine, item 08 | 2/2 (target and regression passed) | 24.3 min | $1.44 | delivered, audit clean, 3 reviews |

- It ran to the end with a result line, and the toolkit was not changed.
- No rescope was proposed, and it used neither the `rm` allowance nor a variable inside a check.
- **Six refusals,** each a class earlier runs showed: three tool-list denials of commands built with shell variables or escapes, one guard hold of an eccode command built with shell expansion, one plan review the gate rules refused, and one hook refusal telling the main session to dispatch the delivery lead rather than act as it.

Item 08 is out-of-sample, and these results are known to the operator before registration.

## Labels, before any figure

The proof run's and the multi-file run's labels and rules apply. Each label carries a one-line reason and is committed to `bench/pilot/mealie/labels-delivery/` before the figure that uses it is computed.

**`failures.json`,** keyed `<process>:<task>:<n>`, where `n` counts that process's runs of the task from 1. Every failed run of either variant is replayed on a clean tree (`bench/pilot/mealie/proof-replay.js`, both checks) and labelled:
- `agent-error`: the request states what the failing test checks, and the change gets it wrong;
- `spec-gap`: the request does not state it, or states it ambiguously;
- `harness`: the environment, setup or infrastructure, or the run's 14,400 s timeout. A run cut by the timeout counts as a failure in every pass rate.

**`refusals.json`:** every refusal in an engine run, labelled `correct`, `false`, `agent-error` or `harness`, as in the rerun. Refused calls are counted once.

## Criteria

**Primary (row 138's rule): delivery.** At least 80% of the **32 planned** engine runs deliver with a clean audit within the 4-hour limit: **met at 26 or more**, missed at 25 or fewer. A planned run that a cost ceiling keeps from starting counts as not delivered. A run delivers when its work item ends `delivered` and its record's audit passes, read from the sandbox when the run ends (the harness's `engine.delivered` and `engine.auditOk`).

**Secondary (row 105's rule): friction.** At most 1 false refusal per engine run that ran.

**Reported, no criterion:**
- **delivery within 7,200 s:** delivered engine runs that also ended within 7,200 s, over the 32 planned (a run's end, not its delivery time, so this reading is conservative);
- delivery on the in-sample items (over 6 planned runs) and the out-of-sample items (over 26) separately;
- the reviewed rescopes proposed, approved and rejected, from each engine run's copied record;
- **hidden checks, engine against bare,** over the items with runs of both variants, by the stratified permutation test (`stratifiedTest`, items as strata, 20,000 resamples, seed 42, two-sided). A run cut by the timeout fails;
- median cost and run time of each variant;
- runs whose patch adds or changes tests;
- timeouts.

**Analysis:**
```
node bench/pilot/delivery.js --runs <scratch>/delivery --planned 32 \
  --labels bench/pilot/mealie/labels-delivery/failures.json --refusals bench/pilot/mealie/labels-delivery/refusals.json
```
It refuses to run while any failed run is unlabelled. Runs of at least 14,400,000 ms are marked timed out, and typed lines (a process stopped at its ceiling) are not runs.

## Infrastructure failures and restarts

As in the multi-file run: a run that ends with no result line because of an infrastructure failure is run once more after the batch, and both readings are reported (**registered:** the cut run counts as not delivered and failed; **continued:** the replacement counts instead). An agent that reaches the 14,400 s timeout is not an infrastructure failure.

**If the container restarts,** the multi-file run's amendment 1 applies: an amendment is committed first; each process continues with `bench/pilot/resume.js runs` from the pinned worktree with its own `--save`, `--transcripts` and `--max-cost` (cost already spent counts toward it), recording each cut run from its surviving sandbox and running each never-started run once; the registered reading counts cut and never-started runs as failures and not delivered. The primary verdict is reported in both readings.

## Reporting

- **Report:** `bench/pilot-results/<registration date>-mealie-delivery.md`, with the saved runs beside it as `.runs.jsonl`, scratch paths shortened to `<scratch>`.
- **Completeness:** every run is reported, with none dropped.
- **Register:** row 138 closes if the primary is met and stays open otherwise. Row 59 gains the correctness figures. Every defect found gets a register row and a fix with a test that failed first, after the batch.

## Risks

- **In-sample fixes.** The fixes were shaped by three items' failures. Their six runs are reported apart from the 26 out-of-sample runs.
- **A longer limit flatters delivery.** Delivery within 2 hours is reported beside it, so the effect of the limit alone can be seen.
- **Reviewed rescope relaxes a rule.** An approved plan no longer changes only by the user's hand. It changes only by an independent reviewer's recorded approval on a pending task, and the user's path remains. The report counts every rescope.
- **The environment change could make items easier for both variants.** The re-validation above confirms each hidden check still fails at its source commit.
- **Disk.** About 5 GB is free; old scratch sandboxes are cleared if it falls under 4 GB, never the saved runs.
- **A restart.** The procedure above applies.

## Amendment 1: the container restart during the batch

Committed before the batch continued.

**What happened.** The container restarted at about 23:34 UTC (its uptime starts at 23:34:33), 68 minutes after the batch launched at 22:26:22, and all four processes stopped. The cause is not known; free disk was 4.5 GB afterwards.
- **Finished runs, with a result line:** e1: item 01 once; e2: item 07 once; e3: item 12 once; w: items 01, 02 and 03 twice each.
- **Cut runs** (started, no result line, the agent still working: no transcripts had been copied):
  - e1: item 01's second run, from 22:49:53;
  - e2: item 07's second run, from 23:27:50;
  - e3: item 12's second run, from 22:59:05;
  - w: item 04's first run, from 23:32:56.
- **Never started:** 51 runs (e1 10, e2 8, e3 8, w 25).
- **Known to the operator at this amendment:** the three finished engine runs (all delivered with a clean audit; item 01's fails one hidden check, items 07 and 12 pass both) and the six finished bare runs (3 pass every hidden check).

**How the batch continues.** Each process continues with `bench/pilot/resume.js runs` (the rerun's and the multi-file run's amendment-1 tool) from the pinned worktree `/tmp/mp/wt5`, with its own `--save` and `--transcripts`, `--timeout 14400` (the tool's default is 3,600 s, so it is passed), `--agent "$AGENT_D"`, and the process's `--max-cost` (60 for e1–e3, 30 for w), the cost already spent counting toward it. Engine processes add `--engine-profile guard --engine-agents inherit`.
- It records the cut run from its surviving sandbox in the process's file, as a failure that did not deliver, then runs each never-started run once, in the original order.
- Its `--registered` file, `<scratch>/delivery/registered/<process>.jsonl`, is the registered reading: the process file as it stood at the restart, plus the cut run, plus every never-started run, each counted as failed and not delivered.
- `--posthoc <scratch>/delivery/posthoc.jsonl` grades a cut run whose agent had finished; none had, so it records nothing.
- **After the batch,** each cut run is run once more, as the protocol's infrastructure rule says: `D --tasks <item> --runs 1` with the process's variant and engine flags, into `<scratch>/delivery-rerun/<process>.jsonl`, with transcripts in the process's own `<scratch>/delivery/tr-<process>`, so the analysis finds them.

**The two readings,** built by `readings()` in `bench/pilot/multifile.js` from `<scratch>/delivery` and `<scratch>/delivery-rerun`:
- **Registered:** the files under `registered/`. It holds 32 planned engine runs, of which at most 3 can deliver: the 3 cut runs and the 26 that never started count as not delivered.
- **Continued:** every run that ran, meaning each process file without its cut-run record, followed by that process's replacement run.

**Both readings are reported,** with the primary verdict in each, as the protocol says. **The continued reading answers the run's question.** The registered reading can show at most 3 of 32 delivered, so it measures the restart, not the engine. This choice is made with the three finished engine runs known, as disclosed above.

**Labels.** `failures.json` is keyed `<process>:<task>:<n>` over the continued reading. The registered reading's keys differ for the cut items (its second run of item 01 in e1 is the cut run; in the continued reading it is the replacement), so its labels go in `failures-registered.json`: the continued reading's labels for runs both readings share, plus `harness` for each cut and never-started run. Refusals are labelled once, by transcript line, and both readings share them.

**If the container restarts again,** the same procedure applies, from each process's file as it then stands, and the amendment that records it is committed first.

## Amendment 2: a second container restart

Committed before the batch continued again.

**What happened.** The container restarted again at about 23:56 UTC (its uptime starts at 23:56:34), 16 minutes after amendment 1's processes started their queues (23:40:30), and all four processes stopped. The cause is again not known: the VM exposes no out-of-memory counters, and memory read normal after the restart.
- **Finished since amendment 1:** w only: item 04 once (passed) and item 05 twice (one passed, one failed a hidden check). No engine run finished.
- **Cut runs** (no result line; no agent had finished):
  - e1: item 02's first run, from 23:41:07;
  - e2: item 08's first run, from 23:41:07;
  - e3: item 13's first run, from 23:41:10;
  - w: item 06's first run, from 23:53:40.
- **Never started:** 44 runs (e1 9, e2 7, e3 7, w 21).

**The resume tool needed a change.** `resume.js runs` refused a file it had already resumed, and it would have appended the never-started runs to the registered reading a second time. It now takes `--amendment <n>`: a later amendment resumes the file again and records its cut run and new runs with that number, and it refuses `--registered`, because the registered reading is the batch as the first restart left it. The change has a test that failed first (`resume: a later amendment resumes a file an earlier one resumed…`), committed as `2571d5d`.

**Where it runs.** From a worktree pinned at this amendment's commit, `/tmp/mp/wt5b`. Its only differences from the protocol commit `67a5db4` are `bench/pilot/resume.js`, its test in `tests/pilot.test.js` and this protocol's text. The engine, the agents, the skills, the suite and `bench/pilot/agents-delivery.sh` are the protocol commit's, so the toolkit each run installs is unchanged.

**How the batch continues.** As amendment 1 says, with `--amendment 2` and no `--registered`: each process records its cut run as a failure that did not deliver, then runs each never-started run once, in the original order, with the same `--timeout 14400`, `--agent "$AGENT_D"`, transcripts and `--max-cost` (cost already spent counting toward it).
- **After the batch,** these four cut runs are also run once more, like amendment 1's: eight replacement runs in all, into `<scratch>/delivery-rerun/<process>.jsonl`.
- **The readings are unchanged in kind.** Registered: the files under `registered/`, as amendment 1 wrote them. Continued: each process file without its cut-run records (both amendments'), followed by that process's replacements. Labels follow amendment 1's rule.

**A memory log.** To see whether load comes before a restart, a logger appends the time, memory in use and the counts of agent and test processes to `/tmp/mp/memlog.txt` every 30 seconds. It is on disk, which survives a restart. It is reported, with no criterion.

**If the container restarts again,** the same procedure applies with the next amendment number, committed first.

## Amendment 3: an expired credential

Committed before the affected runs were run again.

**What happened.** From 13:04:20 to about 13:05:40 UTC on 2026-10-28, the agent CLI's credential was refused (API 401, "OAuth access token has expired"); it authenticated again by 13:06. Only e1 was running.
- **e1's second run of item 06** (from 12:19): its subagent and its orchestrator received the 401 at 13:04:20–22, and its session ended. The harness wrote a result line at 13:05:26: not delivered, both hidden checks passing.
- **e1's replacement run of item 01** (amendment 1's) started at 13:05:26 and received the 401 at its first call. The operator stopped its process at 13:06; it wrote no result line.

**How it is counted.** The protocol's infrastructure rule names a run that ends with no result line. Item 06's second run has one, but the same kind of failure stopped its agent, so the rule applies to it:
- **Registered reading:** unchanged (it is the batch as the first restart left it).
- **Continued reading:** item 06's second run is dropped and replaced by one fresh run, as a cut run is. The report also gives the continued reading with this run kept as not delivered.
- e1's replacement runs (items 01 and 02) and the new one for item 06 run from `/tmp/mp/wt5b` into `<scratch>/delivery-rerun/e1.jsonl`.

**This choice cannot change the primary verdict.** Before the new runs, the continued reading had 22 of 30 engine runs delivered with item 06's second run kept, so with every remaining run delivering it reaches at most 25 of 32, under the 26 the rule needs.
