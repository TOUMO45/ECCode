# Delivery run: does the engine deliver large changes once their blockers are fixed?

Status: approach A approved in conversation on 2026-10-27; this spec is for review before planning.

## 1. Why

The multi-file run ([report](../../bench/pilot-results/2026-10-27-mealie-multifile.md)) missed its delivery rule. Only 9 of its 18 stage-2 engine runs delivered with a clean audit, against a rule of at least 80% (register row 138). All nine undelivered changes pass every hidden check on a clean tree, so the engine was close to delivering each of them, and then stopped.

**What it must show:** that with the blockers fixed, the engine delivers large multi-file changes under row 138's rule, at least 80% of engine runs, on items it has never run before as well as on the three that failed.

**What it does not try to show:** that the engine raises correctness where a bare agent errs (row 59). Engine and bare pass rates are reported with no criterion.

## 2. What stopped the nine runs, and what fixes each

| Runs | What stopped them | Fix |
|---|---|---|
| Item 07, runs 2–5 | The 7,200 s limit. The engineer, test engineer and reviewer each re-ran broad test directories, 5–14 minutes a run; one check hit the 10-minute evidence timeout and ran again. | Narrower checks (3.3), a 30-minute evidence default (3.2), a 4-hour run limit with delivery within 2 hours reported (4.3) |
| Item 05, runs 1 and 4 | The plan pinned `python -c "import …"`, which needs `PRODUCTION=false` outside pytest. The tool list refused every env-prefixed command, and only the user may rescope a task of a reviewed plan. | Reviewed rescope (3.1); the task environment sets `PRODUCTION=false`, as Mealie's own `Taskfile.yml` does (4.1); variables inside the check command (3.3) |
| Item 07, run 1 | Three existing tests needed updating in a file no task owned; only the user may rescope. | Reviewed rescope (3.1) |
| Item 07, run 6 | The design called for Mealie's code generator, and the tool list refused the command, which needed `PYTHONPATH=.` | The task environment makes the sandbox importable, as an editable install does (4.1) |
| Item 01, run 2 | Its own test runs failed on a stale `tests/.temp/mealie.db`, and the tool list refuses `rm`. | The tool list allows deleting Mealie's test temp directory (4.2) |

## 3. Engine changes

### 3.1 Reviewed rescope

Today a task of a reviewed plan can be rescoped only by the user (`lib/tasks.js` `rescope`). In a headless run nobody answers, and the item stops. The new path keeps an independent approval, with a reviewer in the user's place:

- **Propose:** the plan's author (`roles.plan.authors`, the delivery lead) runs `eccode task rescope <id> --files … | --command … --reason … --actor delivery-lead`. On a reviewed-plan track this records `task.rescope_proposed`. It does not change the task.
- **Review:** a plan reviewer (`roles.plan.reviewers`, the technical reviewer) who is not the proposer runs `eccode task rescope-review <id> --decision approve|reject --reason … --actor technical-reviewer`.
  - An approval applies the change as `task.rescoped`, naming the proposal and the approver.
  - A rejection closes the proposal.
- **Rules:**
  - The task must be pending at both the proposal and the approval. A claimed task is released first, as today.
  - A task has at most one open proposal.
  - File-ownership conflicts are checked when the change is applied.
  - The reason is at least 10 characters.
- **Unchanged:**
  - the user's direct rescope;
  - the orchestrator's rescope on one-task tracks;
  - verification coverage, since every changed file must still be covered by an approved gate.
- **MCP:** the delivery lead's `task_rescope` proposes on reviewed plans. The technical reviewer gets `task_rescope_review`.
- **Guidance:** `agents/delivery-lead.md` and the orchestrate skill change. When a planned check cannot run, or a file that must change belongs to no task, the delivery lead proposes a rescope and the technical reviewer reviews it. The user is no longer asked.

### 3.2 A longer evidence default

`eccode evidence run` defaults to a 1,800 s timeout instead of 600 s. `--timeout` still overrides it. The MCP call limit (3,600 s) already covers it.

### 3.3 Checks sized to the step

The role prompts change:
- **Engineers and test engineers** run their task's planned check and the tests they touched, not whole test directories.
- **Reviewers** run the narrowest check that covers the submission. The broad suite runs once, at verification.
- **The delivery lead** writes a check that runs in the project's dev environment as written. Needed variables go inside the command (`env NAME=value …`).

**Version:** these are engine changes, so 0.16.0.

## 4. Harness changes, the same for both variants

### 4.1 The project's dev environment

The Mealie suites' task environment gains `PRODUCTION=false` (Mealie's `Taskfile.yml` sets it for every dev task). It also gains `PYTHONPATH=.`, so `mealie` imports from the sandbox as an editable install would make it. The mealie4 tasks are rebuilt with `build.js`, and every item is validated live again: its target check must fail at the source commit and pass at the fix, and its regression check must pass at both.

### 4.2 The tool list

A new agent command, `$AGENT_D` in `bench/pilot/agents-delivery.sh`, is `$AGENT_B` plus deleting Mealie's test temp directory (`rm` of `tests/.temp`). Everything else stays refused, as in `$AGENT_B`.

### 4.3 The run limit

Every run has `--timeout 14400` (4 hours, up from 2). Delivery within 7,200 s is reported beside the registered figure.

## 5. Items and runs

- **Items:** all 16 mealie4 items, unchanged except for the rebuilt environment.
  - The engine has run on 3 of them (01, 05 and 07: in-sample) and never on the other 13 (out-of-sample).
  - The operator has seen 3 bare runs of every item.
- **Engine:** 2 runs per item, 32 in all, on the guard profile with `--engine-agents inherit`. Three processes take contiguous thirds of the items in upstream order.
- **Bare:** 2 runs per item, 32 in all, in a fourth process, for the reported correctness comparison.
- **Smoke run:** before registration, one engine run on item 08, from the working tree. It is not counted, and it is disclosed.
- **Infrastructure failures:** as in the multi-file run's amendment 1. A cut run is resumed or run again, and both readings are reported.

## 6. Labels, before any figure

The proof run's rules apply:
- Every failed run of either variant is labelled after a clean-tree replay: `agent-error`, `spec-gap` or `harness`.
- Every refusal in an engine run is labelled `correct`, `false`, `agent-error` or `harness`.
- The labels are committed before the figures that use them.

## 7. Criteria

- **Primary (row 138's rule): delivery.** At least 80% of the 32 planned engine runs deliver with a clean audit within the 4-hour limit. A run that a cost ceiling keeps from starting counts as not delivered.
- **Secondary (row 105's rule): friction.** At most 1 false refusal per engine run.
- **Reported, no criterion:**
  - delivery within 7,200 s;
  - delivery on the in-sample and out-of-sample items separately;
  - the rescopes proposed, approved and rejected;
  - hidden checks, engine against bare over the 16 items, by the stratified permutation test (a run cut by the timeout fails);
  - median cost and run time;
  - runs that add tests;
  - timeouts.
- **The register:** row 138 closes if the primary is met and stays open otherwise. Row 59 gains the correctness figures. Every defect found gets a row and a fix with a test that failed first, after the batch.

## 8. Budget and time

- **Engine:** about $3.30 a run by the multi-file run's median. Each engine process gets a `--max-cost` of $60, for $180 in all.
- **Bare:** about $0.45 a run. Its process gets $30.
- **Total ceiling:** $210, plus the smoke run.
- **The timed-out runs' cost** is unknown to `--max-cost` (row 137). The report estimates it from their transcript tokens.
- **Wall time:** about 10–14 hours, longer if runs reach the 4-hour limit.

## 9. Reporting

- **Report:** `bench/pilot-results/<registration date>-mealie-delivery.md`, with the runs beside it, scratch paths shortened to `<scratch>`.
- **Docs:** the register, README, final report and senior-engineering are updated, and so is the evaluation doc.
- **Shipping:** a PR to `claude/keen-allen-5z33eb`, CI, and the merge.

## 10. Risks, disclosed in the protocol

- **In-sample fixes.** The fixes were shaped by three items' failures. Those six runs are reported apart from the 26 out-of-sample runs.
- **A longer limit flatters delivery.** Delivery within 2 hours is reported beside it, so the effect of the limit alone can be seen.
- **Reviewed rescope relaxes a rule.** An approved plan no longer changes only by the user's hand. It changes only by an independent reviewer's recorded approval, on a pending task, and the user's path remains. The report counts every rescope.
- **The environment change could make items easier for both variants.** The re-validation confirms each hidden check still fails at its parent.
- **Disk.** About 5 GB is free. Old scratch sandboxes are cleared before the batch.
- **A restart.** The multi-file run's amendment-1 procedure applies.
