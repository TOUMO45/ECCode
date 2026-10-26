# The Mealie rerun: the fixed engine on fresh items

Protocol: [bench/protocols/2026-10-25-mealie-rerun.md](../protocols/2026-10-25-mealie-rerun.md), registered at commit `8662f5e` before any measured run, with two amendments written during the batch, before any summary figure. Saved runs: [2026-10-25-mealie-rerun.runs.jsonl](2026-10-25-mealie-rerun.runs.jsonl) (the batch files) and [2026-10-25-mealie-rerun.registered.jsonl](2026-10-25-mealie-rerun.registered.jsonl) (the registered reading of the four processes the restart cut). Part A as measured: [2026-10-25-mealie-rerun-part-a.md](2026-10-25-mealie-rerun-part-a.md). The pilot it reruns: [2026-10-24-mealie-pilot.md](2026-10-24-mealie-pilot.md).

## In short

The pilot ran ECCode on Mealie and missed every engine criterion but one. After it:
- its defects were fixed;
- a fix or debug item now has to record a lesson;
- the benchmark's tool list gained read-only shell commands.

This rerun asks the same questions of the fixed engine, on ten fresh Mealie changes (v3.27.0..v3.29.0) and a new three-request greenfield service. The criteria are the pilot's, unchanged.

- **A container restart cut the batch** at about 01:30Z. Four runs lost their result lines, and eleven had not started.
  - **The registered reading stays primary:** cut runs are failures, and a dead chain's remaining items count as not delivered.
  - **The continued reading is reported next to it (amendment 1):** each chain continued on its surviving sandbox, and each unstarted run ran once. No run was sampled twice.
- **Engine criteria (registered reading).** Six of nine are met; the pilot met one.

  | Criterion | Rule | Pilot | Rerun, registered | Rerun, continued |
  |---|---|---|---|---|
  | No record fails its audit | 0 | met | **met** | met |
  | False refusals per engine item run | ≤ 1 | 1.79, missed | **0.64, met** | 0.71, met |
  | Long-lived record, chain b1 (audit, latency, a lesson surfaced later) | all three | missed | **met** | met |
  | Long-lived record, chain b2 | all three | missed | **met** | met |
  | The no-shell quick item delivered | ≥ 1 of 2 | 0 of 2 | **2 of 2** | 2 of 2 |
  | Delivered with a clean audit, chain b1 | ≥ 80% | 3/10 | **3/10, missed** | 5/10 |
  | Delivered with a clean audit, chain b2 | ≥ 80% | 3/10 | **4/10, missed** | 6/10 |
  | Greenfield chain 1 | gates in order, 3 delivered, a new migration | missed | **missed** (all met but one: the patch was too long to show no migration was edited) | missed |
  | Greenfield chain 2 | the same | missed | **missed** (1/3: the restart cut c2) | missed (2/3) |

- **Delivery is still the gap.** Of the seven Mealie items that finished undelivered:
  - three stopped on ECCode defects, fixed since with tests that failed first;
  - two stopped on the benchmark's environment: pnpm refused the linked `node_modules`, and `go-task` was missing;
  - one stopped on a plan problem;
  - one stopped on an engine limit now named: a dependency deadlock during rework.
- **Correctness (reported, no criterion).** Engine against bare on Mealie:
  - **Registered reading:** 11 of 20 runs passed every hidden check, against 16 of 20 (stratified permutation test, p = 0.03). All of that gap is runs the restart cut or never started.
  - **Continued reading:** 17 of 20 against 19 of 20 (p = 0.58).
  - **Runs that finished:** the engine missed one hidden check in 18 runs, the bare agent none in 19.
- **What the batch found.** 16 register rows (109–124):
  - 11 closed with fixes and tests: a gate dead end, the refactor baseline checked too late, an evidence timeout that left the tests running, six guard misreads, and an identity gap no run used;
  - 5 named as open.

  16 of the 20 false refusals fall in classes the fixes remove.
- **What is not shown.**
  - That the engine catches mistakes the bare agent makes: here the bare agent made almost none.
  - That the fixes made after this batch raise the delivery rate: that needs another pre-registered run.
  - That the recorded lessons help: they were shown to later items, but no agent checked or cited one.

## What ran

- **Subject:** Mealie at P2 = v3.27.0 (`dedc6cc7`), over the window W2 = v3.27.0..v3.29.0, history the pilot never used. Ten items were drawn under the pilot's rules ([bench/suites/mealie2](../suites/mealie2/README.md)). The greenfield service is [bench/suites/pantry](../suites/pantry/SPEC.md).
- **Model:** Sonnet in every session, through `claude -p` with `--setting-sources project,local`. Each process used its registered tool list ([bench/pilot/agents-rerun.sh](../pilot/agents-rerun.sh)).
- **Processes:** six, launched at 2026-10-25T23:37:36Z from a worktree pinned at the protocol commit.
  - b1, b2: the Mealie engine chains, ten items each, guard profile;
  - b3: Mealie bare, two runs per item;
  - b4: the quick item under the no-shell profile, two runs;
  - c1: two greenfield engine chains;
  - c2: the same two chains bare.
- **Cost:** $48.57 by the runs' result lines, against a $145 ceiling: b1 $11.02, b2 $12.46, b3 $2.83, b4 $1.79, c1 $18.54, c2 $1.93. The four cut runs' costs were lost with their result lines. Smoke runs before registration cost $0.54. One operator check that the agent CLI still worked after the restart cost $0.07. Part A uses no model.
- **Time:**
  - the restart at about 01:30Z;
  - resumed at 01:44:30Z, after amendment 1 was committed and pushed;
  - b3 ended at 01:49Z, c1 at 02:07Z, b1 at 02:11Z and b2 at 02:16Z.

## The restart and the two readings

At about 2026-10-26T01:30Z the container restarted, and every process still running was killed. Amendment 1 records what had finished, what was cut and what had not started:

| Process | Finished before | Cut (no result line) | Never started |
|---|---|---|---|
| b1 | items 1–6 | item 7: its agent had exited, and the record showed the item delivered; the hidden checks were running | items 8–10 |
| b2 | items 1–6 | item 7: the agent was working | items 8–10 |
| b3 | items 01–08, two runs each | 09-debug run 1: its agent had exited | 09-debug run 2; 10-security runs 1 and 2 |
| b4, c2 | complete | — | — |
| c1 | chain 1; chain 2's c1 | chain 2's c2: the agent was working | chain 2's c3 |

**How the resume worked.** [bench/pilot/resume.js](../pilot/resume.js), run from the pinned worktree:
- wrote each cut run as a failure;
- closed each cut chain item by the harness's registered operator policy (recover, then abandon as the user, with the registered reason);
- continued each chain on its own sandbox with the harness's `runChainItem`;
- ran each unstarted b3 run once with `runOnce`;
- wrote the registered reading beside the batch files.

[bench/pilot/readings.js](../pilot/readings.js) turns both into the directories the analysis reads. The two cut runs whose agents had finished were graded once afterwards, on a copy of the sandbox. b1 item 7 passed 2/2, and b3's 09-debug run 1 passed 2/2. That is a note only and counts in neither reading.

**Amendment 2** came from labelling. This version of Claude Code writes `api-request-blob` events that repeat earlier tool results, so 4 of the first 142 refusals were counted twice. A refused tool call now counts once.

## Parts B and C: the criteria in three readings

Computed by [bench/pilot/analyse.js](../pilot/analyse.js) from the saved runs and the labels:
- **Registered:** the primary reading.
- **Sensitivity:** the registered reading without runs that have no result line, the pilot's rule.
- **Continued:** amendment 1.

| Capability | Measure | Criterion | Registered | Sensitivity | Continued |
|---|---|---|---|---|---|
| Tracks (B) | chain b1: items delivered with a clean audit | ≥ 80% | 3/10, missed | 3/6, missed | 5/10, missed |
| Tracks (B) | chain b2: items delivered with a clean audit | ≥ 80% | 4/10, missed | 4/6, missed | 6/10, missed |
| Tracks (B) | engine runs whose record fails its audit | 0 | 0, met | 0, met | 0, met |
| Friction (B, C) | false refusals per engine item run | ≤ 1 | 0.643 (241 refusals in 28 runs; 18 false), met | 0.889 (208 in 18; 16 false), met | 0.714 (290 in 28; 20 false), met |
| Long-lived record (B) | chain b1: audit, latency of status/metrics/audit, a lesson surfaced later | clean; each ≤ 2 s; ≥ 1 | clean; 55/63/401 ms; 2 lessons, 2 surfaced later; met | the same | clean; 58/81/757 ms; 4 lessons, 3 surfaced later; met |
| Long-lived record (B) | chain b2 | the same | clean; 60/72/500 ms; 2 lessons, 1 surfaced later; met | the same | clean; 56/62/682 ms; 4 lessons, 2 surfaced later; met |
| MCP (B) | the quick item with no shell, delivered with a clean audit | ≥ 1 of 2 | 2 of 2, met | 2 of 2, met | 2 of 2, met |
| Greenfield (C) | engine chain 1: gates in order; c1–c3 delivered; c3 adds a migration and edits none | all | gates architecture → design → plan → phase:core → phase:api-and-docs → verification; 3/3 delivered; c3 migrations +1 ~0 -0, but the patch was truncated; missed | the same | the same |
| Greenfield (C) | engine chain 2 | all | gates architecture → design → plan → phase:implementation → verification; 1/3 delivered; missed | the same | 2/3 delivered; c3 migrations +1 ~0 -0; missed |
| Correctness (B, C) | Mealie: runs passing every hidden check, engine vs bare | reported | 11/20 vs 16/20; Δ −0.250, p 0.0255 (10 items) | 11/12 vs 16/16; p 1.0 (6 items) | 17/20 vs 19/20; Δ −0.100, p 0.5792 |
| Correctness (B, C) | pantry: the same | reported | 4/6 vs 5/6; p 1.0 | 4/4 vs 5/6; p 1.0 | 5/6 vs 5/6; p 1.0 |
| Cost (B, C) | median cost per item, engine vs bare, per track | reported | refactor $0.78 vs $0.17 (×4.6); fix $1.11 vs $0.08 (×13.6); feature $2.11 vs $0.16 (×13.0); quick $0.60 vs $0.12 (×4.8); greenfield $5.00 vs $0.42 (×12.0); pantry feature $2.94 vs $0.26 (×11.2) | — | refactor ×4.6; fix $1.26 vs $0.08 (×14.9); feature $1.68 vs $0.16 (×10.3); quick ×4.8; debug $0.51 vs $0.14 (×3.8); greenfield ×12.0; pantry feature $2.67 vs $0.26 (×10.1) |

How to read the table:
- **"Long-lived record" in the registered reading** is measured on the record as the restart left it, after item 7. The registered criterion says "after item 10", which only the continued reading reaches. Both meet it.
- **Greenfield chain 1** met every condition except one. The harness keeps at most 60,000 characters of a run's patch, and c3's was longer. So the analysis, as registered, cannot see that no earlier migration was edited, and it counts the condition as missed.

  Two things outside the analysis point the other way. The c3 transcripts show one migration written (`migrations/002_pantry_lots.sql`) and no edit to `001`. And the hidden c3 check passed; its append-only test fails on an edited first migration (`tests/pilot.test.js`). Both are a note; the verdict stands.

**Time.** The median wall time per run was 8.9 minutes for the engine on Mealie and 0.9 minutes bare. On the greenfield service it was 25.8 against 2.0. The engine's Mealie runs used about 11 times the tokens of the bare runs (56.9M against 5.2M).

### Why items stopped

Each engine item that ended undelivered, from its record and its session's last answer (continued reading):

| Cause | Items | Register |
|---|---|---|
| The restart cut it | b1 item 7 (its record shows it delivered; graded afterwards 2/2), b2 item 7, c1 chain 2's c2 | amendment 1 |
| The refactor baseline rule was checked only at verification, where it could no longer be met | b1 item 1 | row 110, fixed |
| A submitted report changed; the review was refused ("resubmit") and so was the resubmission | b1 item 2 | row 109, fixed |
| The full suite outlived the 600 s evidence timeout, which killed only the shell. The tests ran on and left a half-migrated test database, and the guard refused deleting that ignored scratch directory | b2 item 1 | rows 111 and 114, fixed |
| The plan named two test files `test_branding.py` in sibling directories without `__init__.py`, so pytest could not collect both; the rename fell outside the engineer's ownership | b1 item 8 | row 94 (plans), mitigated |
| A dependency deadlock in rework: the reworked task's planned command included tests a dependent task owned, and that task could not be claimed until the reworked task was done | b2 item 3 | row 120, named |
| The benchmark environment: `pnpm --dir frontend test:ci` refused the linked `node_modules` (`ERR_PNPM_UNSAFE_MODULES_DIR`); `go-task` is not installed, so a plan's `task ui:check` could not run | b1 item 3, b2 item 8 | row 101 |

The bare agent ran with the same tool list and environment. It never planned a frontend check. Where a check could not run, the engine's sessions stopped to ask the user, as the playbooks tell them to.

### Every run

Hidden checks passed, engine outcome, cost and minutes, per run (continued reading; "cut" marks a run the restart cut, "amend. 1" a run it left unstarted, run under amendment 1):

| Process | Item | Track | Hidden | Engine | $ | Min | Note |
|---|---|---|---|---|---|---|---|
| b1 | 01-refactor | refactor | 2/2 | not delivered | 0.91 | 29.1 | |
| b1 | 02-fix | fix | 2/2 | not delivered | 0.90 | 8.6 | |
| b1 | 03-feature | feature | 2/2 | not delivered | 2.53 | 15.8 | |
| b1 | 04-fullstack | feature | 2/2 | delivered | 1.65 | 12.5 | |
| b1 | 05-frontend | fix | 2/2 | delivered | 1.22 | 6.1 | |
| b1 | 06-quick | quick | 2/2 | delivered | 0.62 | 3.4 | |
| b1 | 07-migration | feature | 0/2 | not delivered | — | — | cut (agent had finished) |
| b1 | 08-routes | feature | 2/2 | not delivered | 1.29 | 7.0 | amend. 1 |
| b1 | 09-debug | debug | 2/2 | delivered | 0.52 | 7.5 | amend. 1 |
| b1 | 10-security | fix | 2/2 | delivered | 1.37 | 7.7 | amend. 1 |
| b2 | 01-refactor | refactor | 2/2 | not delivered | 0.66 | 21.3 | |
| b2 | 02-fix | fix | 2/2 | delivered | 0.99 | 9.1 | |
| b2 | 03-feature | feature | 1/2 | not delivered | 3.83 | 39.3 | |
| b2 | 04-fullstack | feature | 2/2 | delivered | 1.70 | 9.9 | |
| b2 | 05-frontend | fix | 2/2 | delivered | 1.30 | 7.1 | |
| b2 | 06-quick | quick | 2/2 | delivered | 0.58 | 3.2 | |
| b2 | 07-migration | feature | 0/2 | not delivered | — | — | cut |
| b2 | 08-routes | feature | 2/2 | not delivered | 1.61 | 10.2 | amend. 1 |
| b2 | 09-debug | debug | 2/2 | delivered | 0.50 | 6.6 | amend. 1 |
| b2 | 10-security | fix | 2/2 | delivered | 1.29 | 11.8 | amend. 1 |
| b4 | 06-quick (no shell) | quick | 2/2 | delivered | 0.93 | 13.0 | |
| b4 | 06-quick (no shell) | quick | 2/2 | delivered | 0.86 | 3.8 | |
| c1 chain 1 | c1 | greenfield | 1/1 | delivered | 5.21 | 29.0 | |
| c1 chain 1 | c2 | feature | 2/2 | delivered | 2.41 | 18.5 | |
| c1 chain 1 | c3 | feature | 2/2 | delivered | 3.47 | 25.8 | |
| c1 chain 2 | c1 | greenfield | 1/1 | delivered | 4.79 | 30.2 | |
| c1 chain 2 | c2 | feature | 0/2 | not delivered | — | — | cut |
| c1 chain 2 | c3 | feature | 2/2 | delivered | 2.67 | 21.9 | amend. 1 |

Every engine record passed its audit. The bare runs:
- **b3:** every run passed 2/2 except 09-debug run 1, which was cut; graded afterwards, it passed 2/2. Run 2 and both 10-security runs ran under amendment 1. The costs were $0.07–$0.47 per run.
- **c2:** chain 1 passed 1/1, 2/2 and 2/2. Chain 2 passed 1/1, 2/2 and 1/2: c3 failed its target check.

### Refusals

The engine runs met 290 refusals (amendment 2's count). Each was labelled before any figure, with its reason ([labels-rerun/refusals.json](../pilot/mealie/labels-rerun/refusals.json)):
- 151 harness: the benchmark's own tool list;
- 81 correct;
- 38 agent errors;
- 20 false.

b4 met none. The pilot had 360 refusals, 50 of them false.

The 20 false refusals, by class:
- **Guard misreads of shell text, 9** (rows 112, 113):
  - a quoted parenthesis taken for a subshell, so a `cd` to a scratch directory was dropped (4);
  - `2>&1` taken for a cp destination (2);
  - a `$D` mktemp directory taken for a project path (2);
  - an escaped `\$` taken for expansion (1).
- **The record rule fired on a grep pattern or a read-only `env`/`xargs`, 3** (row 113).
- **Deleting a git-ignored artifact (`tests/.temp`, `.nuxt`, a dev database) refused by ownership, 3** (row 114).
- **The gate dead end, 1** (row 109).
- **Interpreters reading a record path, 1** (row 91, an existing limit).
- **The identity rule reading the whole line:** eccode named in a pgrep pattern; `$PWD` in another command. 2 (row 117).
- **mv into a directory taken as a write to the directory, 1** (row 118).

16 fall in classes fixed after the batch, each with a test built from the batch's command. Replaying two of those commands against the old and new guard: the old one refuses both, the new one allows both.

**The 151 harness refusals** are the tool list's. The largest groups are:
- `uv run …` (13): the lists allow `python` and `pytest`, not `uv`;
- `ls` or `grep` into `frontend/node_modules`, which resolves outside the sandbox (it links to the shared environment);
- `ps` and `pkill`;
- commands built from shell variables.

The bare variant had the same lists.

### Lessons and the long-lived record

The step-1 rule worked as designed. Every fix and debug item that reached its last gate recorded a debugging lesson, four per chain:
- the label 404 fix;
- the stale-dialog fix;
- the NLP parser bug;
- the LDAP filter fix.

In each chain the reviewer verified the label and dialog lessons in their own items (`memory.reviewed`). Later items were shown the lessons when they started or claimed a task:
- the label lesson in three later items of b1 and five of b2;
- the dialog lesson in three later items of each chain;
- the parser lesson in b1's item 10.

**What the criterion does not show.** No later agent ran `memory check` on a lesson or cited one with `memory cite`. And the listing matches on any shared word, so it put the label lesson in front of an image-upload feature. The memory was shown, not used (row 119).

Both records stayed audit-clean over ten items: 415 and 443 events. `status`, `metrics` and `audit` each answered in under 0.8 s.

## Part A: model-free measurements at P2 over W2

See [the Part A report](2026-10-25-mealie-rerun-part-a.md). It was measured with ECCode at the protocol commit, after Parts B and C, as registered.

## Defects found while the batch ran

Each was fixed after the batch, with a test that failed first, and has a register row. An independent review of the fixes then found:
- that the first evidence fix let a check outlive a killed eccode process;
- that its timeout test could not fail;
- two places to keep the guard's relaxations narrower;
- the `sort -o` hole.

Those were fixed the same way.

| Row | Defect | Fix |
|---|---|---|
| 109 | A gate whose submitted artifact changed could be neither reviewed nor resubmitted | The author replaces a stale submission (`gate submit` on a submitted gate whose artifacts changed); the refusal names the command |
| 110 | The refactor track's baseline rule was checked only at verification | The first claim is refused until the behaviour command has passed in this work item, with the command to run |
| 111 | An evidence run's timeout killed only the shell; the tests under it kept writing, and nothing said how to allow more time | The command runs in its own process group, stopped when it ends or times out, and by a watchdog if the eccode process dies first; the output names `--timeout`, now in the help |
| 112 | Guard misreads: `2>&1` as a cp destination; quoted parentheses as a subshell; `$D` from mktemp as a project path; escaped or single-quoted `$` in a direct eccode call | Each fixed, with the forms that must stay refused tested beside it |
| 113 | The record rule fired when `.eccode` was only an inverted grep pattern; `env` alone and `xargs <read-only command>` counted as writers | An inverted grep pattern is data; both read |
| 114 | Ownership refused deleting git-ignored artifacts, which no review sees | An engineer may delete an ignored path no tracked file lives under (never `.git`, `.claude` or `.eccode`, a glob, or a secret or key file); writing one still needs ownership |
| 115 | The main session could act as any role by setting `ECCODE_ACTOR` inside the command (no batch run did) | Treated as `--actor`: refused for a role outside sequential mode, asked when built by expansion |
| 116 | A designer's refused write was told to use the reviewers' draft area | The message names the role's own areas |
| 122 | `api-request-blob` events made the refusal count repeat 4 refusals | Amendment 2 |
| 123 | The harness could not continue a chain an infrastructure failure cut | bench/pilot/resume.js (amendment 1) |
| 124 | `sort -o FILE` and `uniq IN OUT` were on the guard's read-only list, though they write (older than this batch) | Both are write targets, and `xargs` is judged by the program it runs |

## Environment and harness disclosures

- **The restart** (amendment 1): four cut runs, eleven unstarted, both readings reported. The cut runs' costs were lost.
- **Late discovery of a counting defect** (amendment 2): before any figure.
- **The frontend environment:** `node_modules` is a link to a shared environment, which `pnpm --dir frontend test:ci` refuses. `go-task` is not installed. Both affect a plan that pins those commands; the bare agent never did (row 101).
- **What the operator saw before the analysis:** to establish which runs had finished, the hidden-check counts of the finished runs and the tables b4 and c2 printed. The labels were then completed and committed (`672ed69`) before `analyse.js` ran.
- **Agent sessions carry the account's context.** Each `claude -p` session runs under the operator's Claude account. Its transcripts are kept outside the repository and none is committed.

## What this means

- **Friction is solved at this scale.** The pilot's false-refusal rate came from defects. With them fixed, the rerun met the rule in all three readings, and most of what remains is fixed now.
- **Memory works mechanically, not yet usefully.** Lessons are recorded, verified and surfaced. No agent used one yet.
- **The no-shell profile works end to end** on a real project.
- **Delivery is still the gap:** at most 6 of 10 per chain in any reading, against the 80% rule.
  - Three of the stops were ECCode defects, now fixed.
  - Two were the benchmark's environment.
  - Two were plans or rework the engine could not unwind on its own (rows 94 and 120).
- **Correctness:** the bare agent was almost never wrong on these items, so the engine had little to catch. That question needs items where bare agents fail.
