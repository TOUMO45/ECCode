# Pre-registered protocol: the Mealie rerun — the fixed engine on fresh real work

Committed and pushed before any measured run of the rerun starts; the git commit timestamp is the registration. It repeats the Mealie pilot ([protocol](2026-10-24-mealie-pilot.md), [report](../pilot-results/2026-10-24-mealie-pilot.md)) with the engine as the pilot left it, on items no session has seen. Where this protocol says nothing, the pilot's protocol is what runs.

**Why.** The pilot missed every engine criterion but a clean audit. It found and fixed 37 defects (register rows 72–108), but whether the fixed engine meets the criteria was never measured. Rows 104–108 stay open until a new pre-registered run measures it.

**Why fresh items.** The pilot's protocol does not sample its items or its planner suite again with the same model in the same variants. Its fixes were also built from failures on those items, so a rerun on them would mostly show that those failures are gone. This rerun draws ten new Mealie items under the pilot's rules from a later window, and Part C asks for a different greenfield service.

## Subject

- **Mealie**, as in the pilot. **Pin P2 = v3.27.0** = `dedc6cc75f2bd8e89108ad998970e7bdf6d4444f`. **Window W2 = v3.27.0..v3.29.0** (first-parent history): 215 commits, from 2026-09-17 to 2026-10-17, none of them in the pilot's window. 113 subjects start `fix`, 20 start `feat`.
- In W2 Mealie moved from Python 3.12 to 3.14 (#8521). Each tree's venv is built with the Python its `pyproject.toml` requires (`pythonVersionFor` in `bench/suites/mealie/_tools/env.js`; the pilot's builder always asked for 3.12, which failed every candidate after the move).
- Licence and the rule that no Mealie file enters this repository: as in the pilot.
- Several commits in W2 carry `Co-authored-by:` trailers naming an AI model, as in W. The model under test may have seen Mealie's history; this affects every variant alike.

## What runs, and where

- **ECCode under test:** the commit of this protocol, from a git worktree pinned at it. It holds every fix the pilot made (register rows 72–108; the rows that stay open are named limits) and three changes made for this rerun (below).
- **Machine:** the pilot's container: 4 cores, 15 GB RAM, Node 22.22.0, Claude Code CLI 2.1.310, model alias `sonnet`; Python 3.12.3 and 3.14.6 managed by uv 0.11.32.
- **Environments:** as in the pilot (`bench/suites/mealie/_tools/setup.sh`, `env.js`), under `ECCODE_MEALIE_ENVS`, shared and read-only to agents.
- `TMPDIR=/tmp/mp`.
- **Baseline at P2:** the full backend suite passes: 2,939 tests, 0 failures, 18 skipped by Mealie's own markers, 7 min 45 s (with the item selector running beside it).
- **Order:** Parts B and C run first, in parallel. Part A runs after they end, with no agent running (A1's timings need an idle machine). Part B and C runs use this protocol's commit whatever Part A finds.

### Changes made for the rerun, before registration

- **Lessons (row 106).** A fix or debug work item records a debugging lesson before its last gate is submitted; `memory draft` fills it from the record and `memory add` refuses a TODO left in. `work start`, `quick`, `debug` and `task claim` list the lessons from earlier work that share a word with the request, as evidence to check. The playbooks carry the step (commit `9796b57`).
- **Shared lessons stay in the sandbox.** `eccode bench` points `ECCODE_SHARED_MEMORY` into each sandbox, so no run or chain reads another's promoted lessons (the default is the operator's `~/.eccode/memory`).
- **The agents' tool lists (row 101).** `bench/pilot/agents-rerun.sh`, the same for every variant: the pilot's lists, plus read-only shell (`ls`, `cat`, `head`, `tail`, `wc`, `grep`), the sandbox by its absolute path (`cd`, `git -C` and the CLI under `$PWD`), `git show` and reverting files (`git checkout -- <paths>`, `git restore`), and for the pantry suite `curl`, `kill <pid>` and `sleep`. Still refused: installs, `uv`, `find`, `rm`, `pkill`, the network tools. These come from the pilot's 177 refusals labelled harness.

## Part B: ten fresh changes as work items

Drawn by `bench/suites/mealie/_tools/select.js --suite bench/suites/mealie2 --range v3.27.0..v3.29.0` under the pilot's rules, unchanged: the same pools and size cap, seed 42, the same order of categories, the same live validation (each item's new or changed tests fail on its parent and pass at the commit, twice; the regression set passes at both). Every skip is in `bench/suites/mealie2/_tools/selection.json`. A first draw with the 3.12-only builder was stopped and thrown away before any item was used: its environment failures had skipped valid candidates.

The ten items, in chain order (by the date of each source commit; the refactor at P2's date). Each item's hidden tests are the upstream fix's own; its request is in `bench/suites/mealie2/_tools/prompts.json`.

| Order | Item | Track | Upstream change | Source commit | Target | Regression |
|---|---|---|---|---|---|---|
| 1 | `mealie2-01-refactor` | refactor | One home for the query-filter validation of meal-plan rules and cookbooks (written for the rerun) | `dedc6cc7` | duplicate-body check | full backend suite |
| 2 | `mealie2-02-fix` | fix | fix: labels get-by-id returns 404 instead of 500 for missing id (#8227, `b377b394`) | `54de7e8a` | 1 test | 9 tests |
| 3 | `mealie2-03-feature` | feature | feat: support drag-and-drop images from web (#8493, `04d380a5`) | `ec9d05ab` | 74 tests | 1,628 tests |
| 4 | `mealie2-04-fullstack` | feature | feat: use partitioned cookies to support embedded auth (#8522, `59e3e14e`) | `e1d0ffdc` | 5 tests + 1 spec file | 3 tests + 41 spec files |
| 5 | `mealie2-05-frontend` | fix | fix: prevent stale AI provider fetch from clobbering the edit form (#8452, `ed4fd9ff`) | `4bc9734b` | 1 spec file | 47 spec files |
| 6 | `mealie2-06-quick` | quick | feat: support public (secretless) native OIDC clients for Google and Microsoft (#8653, `0601d2bc`) | `10fa95e2` | 12 tests | 63 tests |
| 7 | `mealie2-07-migration` | feature | fix: delete orphaned legacy cookbook/plan-rule join table rows (#8350, `0254fd7d`) | `342ba4c8` | 2 tests | 2 tests |
| 8 | `mealie2-08-routes` | feature | feat: support customizing app icon, favicon, banner title, and HTML title (#8078, `6fb78ba4`) | `ec3e0305` | 15 tests | 31 tests |
| 9 | `mealie2-09-debug` | debug | fix: don't treat unnamed measurement as ingredient substitution (#8502, `5c1f789d`) | `c794a53c` | 4 tests | 15 tests |
| 10 | `mealie2-10-security` | fix | fix: evaluate LDAP_ADMIN_FILTER as the query account, not the logging-in user (#8678, `aef77875`) | `9bb350ee` | 1 test | 18 tests |

The first candidate of every pool validated: the draw skipped nothing (`selection.json`, `skipped`).

**Item 1, the refactor**, is again the one item not taken from history. The pilot's rule picks it: the largest set of duplicated methods two classes of one layer share, by a normalized-AST scan of `mealie/` at the base commit (`bench/suites/mealie/_hidden/dup_check.py --scan`, committed for this rerun). At P2 that is still the pilot's pair (`RepositoryGroup` and `RepositoryHousehold`), so the pilot's item is excluded and the next set by the same rule is taken: `validate_query_filter_string` and `validate_query_filter`, duplicated between the meal-plan rule schemas (`PlanRulesCreate`, `PlanRulesOut`) and the cookbook schemas (`CreateCookBook`, `ReadCookBook`), 19 lines. Its target check holds only hashes of the normalized duplicated bodies; its regression check, and its behaviour command, is the full backend suite, which passes at P2.

**Requests** (`bench/suites/mealie2/_tools/prompts.json`): written from each PR and its tests, issue-style, under the pilot's rules: each names what the hidden tests pin, by symbol, never by the path of a file its fix changes. A module the fix creates and a hidden test imports is named by its dotted name: it is an interface the tests pin, and no path of the existing code it gives away. `tests/mealie.test.js` checks both suites: no request names a file its fix changes or contains a line of its fix; no rerun item is a pilot commit, and the refactor removes a different duplication.

**Target counts include existing tests** where an item's hidden test files shared one pytest session with a file that cannot be collected on the parent (it imports what the fix creates). Collection stops, so the other files' tests count as failing on the parent. They pass on both sides and are graded like the rest: an item passes only when both of its checks pass. The pilot's selector, the same code, did the same.

**Live validation** before this registration: `ECCODE_MEALIE_VALIDATE=1 node --test --test-name-pattern "mealie2 live" tests/mealie.test.js` passed: for each of the nine historical items, the target check fails at the source commit and passes at the fix commit, and the regression check passes at both. The refactor's target check fails at P2 (both hashed bodies appear twice) and its regression check is the baseline above.

**Chain mode**, the operator abandon policy and the per-item record copies: as in the pilot.

## Part C: a fresh greenfield chain, `mealie-pantry`

`bench/suites/pantry` ([SPEC.md](../suites/pantry/SPEC.md)), ours, MIT. `c1` (greenfield track: a pantry whose amounts add up by kind of unit, the recipes it can cook and what each lacks, cooking), `c2` (feature track: a labelled shopping list against the pantry, a tag filter) and `c3` (feature track: expiry dates as lots, through a new migration), against the pilot's fake Mealie and synthetic data. 9, 4 and 5 black-box acceptance tests, run by `_hidden/check.js`; c2's regression check is c1's tests, c3's is c1's and c2's. The reference implementation passes every test; an empty service, a client that reads one page of recipes and an edited first migration fail them (`tests/pilot.test.js`).

## Variants and processes

Six `eccode bench` processes, started detached at the same time from the pinned worktree, each with `--timeout 3600 --save <scratch>/<name>.jsonl --transcripts <scratch>/tr-<name>` and its share of a $145 ceiling:

| Process | Suite and options | Runs | `--max-cost` |
|---|---|---|---|
| b1 | mealie2, `--chain --variant engine --runs 1 --engine-profile guard --engine-agents inherit` | 10 | 40 |
| b2 | the same, the second chain | 10 | 40 |
| b3 | mealie2, `--variant without --runs 2` | 20 | 15 |
| b4 | mealie2, `--tasks mealie2-06-quick --variant engine --engine-profile no-shell --engine-agents inherit --runs 2` | 2 | 10 |
| c1 | pantry, `--chain --variant engine --runs 2 --engine-profile guard --engine-agents inherit` | 6 | 35 |
| c2 | pantry, `--chain --variant without --runs 2` | 6 | 5 |

Exactly, with `source bench/pilot/agents-rerun.sh` first:

```sh
B() { node bin/eccode.js bench --suite bench/suites/mealie2 --timeout 3600 --agent "$AGENT_B" "$@"; }
C() { node bin/eccode.js bench --suite bench/suites/pantry --timeout 3600 --agent "$AGENT_C" "$@"; }
B --chain --variant engine --runs 1 --engine-profile guard --engine-agents inherit --max-cost 40 --save <scratch>/b1.jsonl --transcripts <scratch>/tr-b1
B --chain --variant engine --runs 1 --engine-profile guard --engine-agents inherit --max-cost 40 --save <scratch>/b2.jsonl --transcripts <scratch>/tr-b2
B --variant without --runs 2 --max-cost 15 --save <scratch>/b3.jsonl --transcripts <scratch>/tr-b3
B --tasks mealie2-06-quick --variant engine --engine-profile no-shell --engine-agents inherit --runs 2 --max-cost 10 --save <scratch>/b4.jsonl --transcripts <scratch>/tr-b4
C --chain --variant engine --runs 2 --engine-profile guard --engine-agents inherit --max-cost 35 --save <scratch>/c1.jsonl --transcripts <scratch>/tr-c1
C --chain --variant without --runs 2 --max-cost 5 --save <scratch>/c2.jsonl --transcripts <scratch>/tr-c2
```

Each line runs detached (`setsid nohup`) from the pinned worktree, with `TMPDIR=/tmp/mp` and `ECCODE_MEALIE_ENVS` set. The launching session's Claude Code identity and settings no longer reach the agents (`agentEnv`, pilot amendment 1).

## Part A: model-free measurements at P2 over W2

The pilot's scripts (`bench/pilot/mealie/`, run from that directory in the pinned worktree), measures, labels and criteria, unchanged, with P2 and W2 in place of P and W, results in `bench/pilot/mealie/results-rerun/` (`ECCODE_PILOT_RESULTS`), labels in `bench/pilot/mealie/labels-rerun/`, report `bench/pilot-results/2026-10-25-mealie-rerun-part-a.md`. In the pilot, Part A's after-fix run was measured on the window its fixes were built from; this run measures them on history none of them saw.

```sh
node a1-index.js dedc6cc75f2bd8e89108ad998970e7bdf6d4444f
node a2-impact.js dedc6cc75f2bd8e89108ad998970e7bdf6d4444f --sample 40 --faults 10 --jobs 3 --frontend 10
node a3-compat.js v3.27.0..v3.29.0 --route-sample 20
node a6-bugs.js v3.27.0..v3.29.0
node a5-mutate.js v3.27.0..v3.29.0
node a4-fixverify.js v3.27.0..v3.29.0
node a7-stack.js dedc6cc75f2bd8e89108ad998970e7bdf6d4444f
```

## Outcomes and criteria

The pilot's criteria (its protocol, "Outcomes and criteria", and spec section 8), unchanged, over these processes and items:

| Capability | Measure | Criterion |
|---|---|---|
| Tracks (B) | engine items delivered with a clean audit | ≥ 80% per chain; zero audit failures |
| Friction (B, C) | false refusals (ECCode wrong), over every engine-variant item run of b1, b2, b4 and c1 | ≤ 1 per item run on average; each one a register row |
| Long-lived record (B) | per chain, after item 10 | `eccode audit` clean; `status`, `metrics` and `audit` each ≤ 2 s; at least one lesson recorded in one item and surfaced in a later one |
| MCP (B) | the quick item with no shell | delivered with a clean audit in ≥ 1 of 2 |
| Greenfield (C) | gates in order; c1 to c3 delivered | in both engine chains: c1's gates approved in the order architecture, design, plan, phases, verification; c1, c2 and c3 delivered; c3 adds a migration file and edits or deletes no earlier one |
| Correctness (B, C) | runs passing every hidden check, engine against bare | reported with the permutation test stratified by item (20,000 seeded resamples, two-sided); no criterion (underpowered) |
| Cost (B, C) | median cost per item, engine over bare, per track | reported |
| Part A | each of the pilot's 17 measures | the pilot's criterion for it |

Operational definitions, the refusal labels (`correct`, `false`, `agent-error`, `harness`, each with a reason, in `bench/pilot/mealie/labels-rerun/refusals.json`, before any summary figure is computed) and the per-item measures: as in the pilot, including its amendment 1 (each chain item counts only its own transcript lines). A lesson is surfaced when its id or title appears in a tool result of a later item of the same chain; the listing at `work start`, `quick`, `debug` and `task claim` counts, as any other tool result does. Analysis: `node bench/pilot/analyse.js --runs <scratch> --labels bench/pilot/mealie/labels-rerun --greenfield pantry`.

**Comparison with the pilot** is descriptive: the items differ, and so do the tool lists. The rerun's own criteria decide rows 104–108.

## Honesty rules

The pilot's, unchanged: one batch; a chain that dies is not restarted; a defect found while runs are under way is fixed after the batch unless it invalidates every variant alike (then the batch stops, this protocol gets a dated amendment, and the batch restarts); the budget stops a process before its next run once its share is spent; labels before figures. These items and the pantry suite are not sampled again with `sonnet` in these variants.

**Reporting:** `bench/pilot-results/2026-10-25-mealie-rerun.md`, with the saved runs as `2026-10-25-mealie-rerun.runs.jsonl` (scratch paths shortened to `<scratch>`) and the Part A report next to it. Rows 104–108 are updated or closed by what it shows; every new finding gets a register row; each defect gets a fix with a failing-first test, after the batch.

## Smoke runs before this registration

Two smoke sessions ran before this registration, with the Mealie agent command of `bench/pilot/agents-rerun.sh`, the debug track and the guard profile. Both are excluded from every result; they cost $0.54 together.
- `followup/py-median` ($0.20). It is a feature request, not a bug, so `fix verify` judged the proof inconclusive (the test needs a function that did not exist), and the orchestrator stopped before delivery, as it should. It showed the command and the profile loading.
- A synthetic bug written for the smoke and kept outside the repository: an order of exactly 10 items is priced without its bulk discount (JavaScript, `npm test`), $0.34. It was delivered with a clean audit, the fix proven by `fix verify`, one review and a mutation run, and the lesson was recorded before the phase was submitted. Its two `npm test` refusals came from the Mealie tool list, which has no `npm`. A third was Claude Code refusing a command that put the CLI in a shell variable.

## Amendment 1 (2026-10-26T01:45Z, during the batch, before any summary figure)

**What happened.** The batch started at 2026-10-25T23:37:36Z. At about 2026-10-26T01:30Z the container restarted and every process still running was killed. The last writes were at 01:29:15Z. It was an infrastructure event; no defect in the engine, the harness or a variant caused it.

**Runs finished at the restart**, each with its result line:
- b1 and b2: items 1–6;
- b3: items 01–08, two runs each (16 runs);
- b4: both runs (complete);
- c1: chain 1, items c1–c3 and its summary; chain 2, item c1;
- c2: both chains (complete).

They had spent $39.00 by their result lines: b1 $7.83, b2 $9.05, b3 $2.52, b4 $1.79, c1 $15.88, c2 $1.93.

**Cut off** (no result line):
- b1 item 7 (`07-migration`): its agent had exited, since the harness had copied its transcripts at 01:29:15Z; the hidden checks were running.
- b2 item 7 (`07-migration`): its agent was still working (it started at 01:23:41Z).
- b3 run 17 (`09-debug`, run 1): its agent had exited (transcripts copied at 01:29:07Z); the hidden checks were running.
- c1 chain 2, item `pantry-c2`: its agent was still working (it started at 01:21:21Z).

Their costs were lost with their result lines. No spend figure or budget share counts them.

**Never started:**
- b1 and b2: items 8–10;
- b3: `09-debug` run 2, and `10-security` runs 1 and 2;
- c1 chain 2: `pantry-c3`.

**What the operator had seen** before writing this, to establish which runs had finished: the hidden-check counts and delivery flags of the finished runs, and the report tables that b4 and c2 printed when they ended. No refusal labels existed beyond the 76 rule-based ones committed at 82ac5de, and no summary figure had been computed: no criterion, no rate, no test.

**The registered reading stays primary.** The rules apply as registered:
- the cut runs have no result line, so they are failures;
- a chain that dies is not restarted, and its remaining items count as not delivered, with the cause;
- the runs that never started count as failures.

The criteria are decided on this reading. One criterion is defined "after item 10" (the long-lived record): in this reading it is not evaluable for b1 and b2, and the report says so. As the pilot's rules require, a sensitivity analysis without the runs that have no result line is reported next to the primary reading.

**This amendment adds a continued reading**, reported next to the primary one, criterion by criterion.

Why add it:
- The restart was independent of the variants, but it fell almost entirely on the engine side. The engine side lost ten item runs, the bare side three runs and one cut run.
- On the registered reading, the engine chains' last four items carry no information about the engine. That includes the debug item, the first place where a lesson recorded at the fix item could surface in a later item.

The chains can continue without sampling any item twice:
- their sandboxes and records survived, because the processes were killed and the harness never ran its cleanup;
- the cut items stay failures in this reading too;
- each remaining item gets its one run.

**Procedure.** `bench/pilot/resume.js` was written for this amendment and is committed with it, with tests in `tests/pilot.test.js`. It is copied into the worktree pinned at 8662f5e and run from there, so the engine and the harness are the ones registered. The commands are listed below.
- **For a cut chain item**, it:
  - copies the item's transcripts (since the item's own commit);
  - reads the record's outcome;
  - closes the item by the harness's registered operator policy (`closeStuckItem`: recover the open runs, then abandon as the user, with the registered reason);
  - copies the record;
  - saves a failure record: `agentExit` 1, hidden 0, `engine.delivered` false, `usage` null, and `infrastructure` with the cause, whether the agent had exited and whether the record showed the item delivered, plus `amendment: 1`.
  
  The remaining items then run through the harness's own `runChainItem`, on the same sandbox and record. The chain summary comes last.
- **For b3**: the cut run's failure record, then each run that never started, once, through `runOnce`.
- **Budget:** each process keeps its registered share, measured against the spend of its result lines.
- **The registered reading** is written beside the batch files (`registered/<process>.jsonl`). It holds the same failure records for the cut runs, a failure for each run that never started (`infrastructure.neverStarted`) and, for each chain, the summary of its record as the restart left it (`at: "restart"`).
- **The two cut runs whose agents had exited** (b1 item 7 and b3 run 17) also have their hidden checks run once, on a copy of the sandbox as it was left, before anything else touches it. The result is reported as a note and enters neither reading.

No item, variant, criterion, label rule or budget share changes.

```sh
R=<scratch>; S=$R/registered
node bench/pilot/resume.js chain --suite bench/suites/mealie2 --sandbox <b1 sandbox> --chain-run 1 --interrupted mealie2-07-migration --variant engine --engine-profile guard --engine-agents inherit --timeout 3600 --max-cost 40 --save $R/b1.jsonl --registered $S/b1.jsonl --transcripts $R/tr-b1 --posthoc $R/posthoc.jsonl --cause "container restart, 2026-10-26T01:30Z" --agent "$AGENT_B"
node bench/pilot/resume.js chain ... b2 (same, its own sandbox, files and share)
node bench/pilot/resume.js runs --suite bench/suites/mealie2 --sandbox <b3 sandbox> --interrupted mealie2-09-debug --variant without --then mealie2-09-debug:1,mealie2-10-security:2 --timeout 3600 --max-cost 15 --save $R/b3.jsonl --registered $S/b3.jsonl --transcripts $R/tr-b3 --posthoc $R/posthoc.jsonl --cause "container restart, 2026-10-26T01:30Z" --agent "$AGENT_B"
node bench/pilot/resume.js chain --suite bench/suites/pantry --sandbox <c1 chain 2 sandbox> --chain-run 2 --interrupted pantry-c2 --variant engine --engine-profile guard --engine-agents inherit --timeout 3600 --max-cost 35 --save $R/c1.jsonl --registered $S/c1.jsonl --transcripts $R/tr-c1 --cause "container restart, 2026-10-26T01:30Z" --agent "$AGENT_C"
```

## Amendment 2 (2026-10-26T01:52Z, during the batch, before any summary figure)

**What was found.** This happened while the refusals were being labelled. Claude Code (2.1.310, the version every agent of this batch ran) writes `api-request-blob` events, and these repeat tool results already in the transcript. The extractor (`extractRefusals` in `bench/pilot/refusals.js`) read every event, so a refusal repeated in such an event counted twice.

**Size so far.** Of the 142 refusals extracted from the items finished before the restart, 4 were repeats. Each repeats the same tool call (the same `tool_use_id`) that a `user` event a few lines earlier already holds.

**The amendment.** A refused tool call counts once, where it first appears: the extractor skips a tool result whose `tool_use_id` it has already seen. The test is in `tests/pilot.test.js`. Nothing else changes: no run, criterion or label rule. The four repeats were never labelled.
