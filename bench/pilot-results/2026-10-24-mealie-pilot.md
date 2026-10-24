# The Mealie pilot: every ECCode capability on a real project

Protocol: [bench/protocols/2026-10-24-mealie-pilot.md](../protocols/2026-10-24-mealie-pilot.md), registered at commit `c506d6e` before any measured run. Spec: [docs/specs/2026-10-24-big-project-pilot-design.md](../../docs/specs/2026-10-24-big-project-pilot-design.md). Saved runs: [2026-10-24-mealie-pilot.runs.jsonl](2026-10-24-mealie-pilot.runs.jsonl). Part A as measured: [2026-10-24-mealie-part-a.md](2026-10-24-mealie-part-a.md).

## In short

ECCode ran on Mealie, a real FastAPI and Nuxt project ECCode's authors did not write. Mealie was pinned at v3.20.0, and the window ran over the 410 commits to v3.27.0. Every answer was checked by something other than the agent: the project's own tests and history, a coverage run, or FastAPI's route table.

- **Model-free capabilities (Part A).**
  - **Measured run:** 10 criteria met, 6 missed, 1 with no verdict.
  - **After-fix run:** the misses in TS/JS import resolution, breaking-change precision and bug-rule false positives are closed.
  - **New miss:** impact's share-of-suite criterion now fails. That verdict turns on which modules a sample draws (row 74).
  - **Not yet in:** {A-after-pending}
- **The engine on real work (Parts B and C), at the protocol commit.** It missed every pre-registered engine criterion except "no record fails its audit":
  - 6 of 20 Mealie work items were delivered with a clean audit (3 of 10 per chain, rule ≥ 80%);
  - agents met 1.79 false refusals per item run (rule ≤ 1);
  - no lesson was recorded in either chain;
  - the no-shell profile delivered 0 of 2 MCP runs;
  - neither greenfield chain delivered all three requests.
- **Correctness (reported, no criterion).** The bare agent passed every hidden check in 17 of 20 Mealie runs. The engine did so in 13 of 20 (stratified permutation test, p = 0.12, 10 items). In a clean recheck it was 14 of 20. Most engine misses were items it abandoned part-way, not wrong fixes it delivered.
- **What the pilot found.** 37 register rows (72–108). Every false refusal maps to a row. 47 of the 50 trace to defects fixed since, each with a test that failed first. 3 trace to a named limit (row 91). Of the 14 undelivered Mealie items:
  - 4 stopped on defects fixed since;
  - 6 stopped on plan or dispatch problems the playbooks now address;
  - 4 stopped on the benchmark's own tool list or environment.
- **What is not shown.** That the fixes raise the delivery rate. These figures come from ECCode at the protocol commit. Whether the fixed version meets the criteria needs a new pre-registered run.

## What ran

- **Subject:** Mealie at P = v3.20.0 (`dbe84cc9`). The window W is v3.20.0..v3.27.0. Environments are shared and read-only to agents (`ECCODE_MEALIE_ENVS`).
- **Model:** Sonnet, every session. Agents ran through `claude -p` with `--setting-sources project,local` and the registered tool lists (protocol, "Agent commands").
- **Processes:** six, launched at 15:28:55 UTC from a worktree pinned at the protocol commit.
  - b1, b2: Mealie engine chains, ten items each, guard profile, one sandbox and one record per chain.
  - b3: Mealie bare, two runs per item.
  - b4: the quick item under the no-shell profile, two runs.
  - c1: two greenfield planner chains under the engine.
  - c2: the same two chains bare.
- **Cost:** $62.97 for the batch, against a $250 ceiling: b1 $13.66, b2 $18.21, b3 $5.23, b4 $0.61, c1 $23.30, c2 $1.97. The after-fix checks of the MCP item cost $2.38 more (below). Part A uses no model.
- **No process stopped early, and no session failed to start.** Every run has a result line and at least one turn. The registered sensitivity analysis without never-started sessions is therefore identical to the primary one.

## Part A: model-free measurements

Measured at P with ECCode at the protocol commit (verbatim, [part A report](2026-10-24-mealie-part-a.md)). Then measured again at P with ECCode at the fixes, in an after-fix run (worktree at `2be2f16`, results in the same format).

| Capability | Measure | Criterion | Measured | After the fixes |
|---|---|---|---|---|
| Index (A1) | Python intra-project imports resolved | ≥ 95% | 1.000 (2,141 of 2,142) | 1.000 (2,217 of 2,217) |
| Index (A1) | TS/JS intra-project imports resolved | ≥ 90% | **0.376** (183 of 487; 201 `.vue` files not indexed) | 0.998 (1,193 of 1,195; `.vue` indexed) |
| Index (A1) | onboard cold / warm / after a one-file edit, ms | ≤ 120,000 / 10,000 / 10,000 | 400 / 256 / 317 | 573 / 643 / 457 |
| Impact (A2) | median recall against coverage, static / with `--trace` | ≥ 0.90 / ≥ 0.95 | 1 / 1 | 1 / 1 |
| Impact (A2) | median share of all test files selected | ≤ 0.5 | 0.459 | **0.817** |
| Impact (A2) | recall against injected faults, pooled | ≥ 0.90 | 0.938 | 1 |
| Compat (A3) | precision of detections over W | ≥ 0.90 | **0.087** (2 true of 23) | 1 (2 true of 2) |
| Compat (A3) | recall against FastAPI's route table | ≥ 0.90 | no verdict: no removal in the sample | no verdict: no removal in the sample |
| fix verify (A4) | agreement with running the tests directly | 100% | **0.974** (4 disagreements labelled) | {A4} |
| mutate (A5) | runs completing | ≥ 90% | 0.976 | {A5} |
| Bug rules (A6) | false positives per 10,000 changed lines | ≤ 1 | **4.506** (92 hits) | 0 (1 hit, the one labelled real) |
| Stack (A7) | stacks detected at the pin | Python and Node | **python** | {A7-detect} |
| Stack (A7) | detected checks runnable, result equal to the tool run directly | all | **1/2** | {A7-checks} |
| Secrets (A7) | error-level false positives at the pin | ≤ 5 | 0 | {A7-secrets} |

Reading the after-fix column:
- **A2's share.** The after-fix sample differs from the measured one by five modules. The A4 fix stopped counting `mealie/services/migrations/` as generated code, so the population the seeded sample is drawn from grew from 282 to 296 modules. On the 35 modules both samples share, the median share was 0.807 before the fixes and 0.817 after. The HTTP-reach fix barely moved it, and recall stayed 1.0. The share is bimodal. A module the app imports selects 80–90% of the test files, because every integration test loads the app; a leaf module selects a handful. The measured 0.459 sat in the gap between the two, so the verdict turns on the draw (row 74).
- **A2's route modules.** The six sampled route modules had no predicted test before the HTTP-reach fix. After it, recall is 1.0 on four of them, and 0.5 and 0.45 on the other two (row 73).
- **A3.** Two detections after the fixes, both already labelled true, so precision is 1 on a sample of 2 (row 75). The five migrations added in W drop nothing in `upgrade()`, so the destructive-migration rule had nothing to find.
- **A6.** The changed-line count grew by 44 lines (26,631 to 26,675) for the same A4 reason.

## Parts B and C: the engine on real work

The pre-registered criteria, computed by `bench/pilot/analyse.js` (with amendment 1's per-item transcript lines) from the saved runs and the labels:

| Capability | Measure | Criterion | Result | Met |
|---|---|---|---|---|
| Tracks (B) | chain b1: items delivered with a clean audit | ≥ 80% | 3/10 | missed |
| Tracks (B) | chain b2: items delivered with a clean audit | ≥ 80% | 3/10 | missed |
| Tracks (B) | engine runs whose record fails its audit | 0 | 0 | met |
| Friction (B, C) | false refusals per engine item run | ≤ 1 | 1.786 (360 refusals in 28 runs; 0 unlabelled; 50 false) | missed |
| Long-lived record (B) | chain b1: audit, latency of status/metrics/audit, a lesson surfaced later | clean; each ≤ 2 s; ≥ 1 | audit clean; 81/79/928 ms; 0 lessons, 0 surfaced later | missed |
| Long-lived record (B) | chain b2: audit, latency of status/metrics/audit, a lesson surfaced later | clean; each ≤ 2 s; ≥ 1 | audit clean; 78/108/1306 ms; 0 lessons, 0 surfaced later | missed |
| MCP (B) | the quick item with no shell, delivered with a clean audit | ≥ 1 of 2 | 0 of 2 | missed |
| Greenfield (C) | engine chain 1 | gates in order; c1–c3 delivered; c3 adds a migration, edits none | gates architecture → design → plan → phase:core-modules → phase:server-e2e-docs → verification; 2/3 delivered; c3 migrations +1 ~0 -0 | missed |
| Greenfield (C) | engine chain 2 | gates in order; c1–c3 delivered; c3 adds a migration, edits none | gates architecture → design → plan → phase:foundation; 0/3 delivered; c3 migrations +1 ~0 -0 | missed |
| Correctness (B, C) | Mealie: runs passing every hidden check, engine vs bare | reported (no criterion) | engine 13/20, bare 17/20; Δ -0.200, p 0.1236 (10 items) | — |
| Correctness (B, C) | planner: runs passing every hidden check, engine vs bare | reported (no criterion) | engine 5/6, bare 6/6; Δ -0.167, p 1.0000 (3 items) | — |
| Cost (B, C) | median cost per item, engine vs bare, per track | reported (no criterion) | refactor: $0.69 vs $0.14 (×4.9); fix: $1.23 vs $0.21 (×6.0); feature: $2.15 vs $0.34 (×6.4); quick: $0.59 vs $0.09 (×6.6); debug: $0.43 vs $0.11 (×3.9); greenfield: $6.12 vs $0.43 (×14.3); feature: $2.50 vs $0.24 (×10.3) | — |

The cost row lists "feature" twice: first the Mealie feature items, then the planner's c2 and c3. Median wall time per run was 13.7 minutes for the engine on Mealie against 3.2 bare, and 20.5 against 1.7 on the planner.

### Why items stopped

Each undelivered engine item, from its record and its session's last answer:

| Cause | Mealie items | Planner items | Register |
|---|---|---|---|
| `init --track refactor` took no behaviour command | b1 and b2 item 1 | — | row 85, fixed |
| Rework of an approved phase stranded the item | b2 item 3 | — | row 95, fixed |
| The first reviewer's approval closed a gate a second reviewer was still reviewing (a demonstrated SSRF bypass was refused) | b2 item 6 | — | row 103, fixed |
| A guard misread refused the planned check | — | c1 chain 2, c1 | row 89, fixed |
| The plan pinned a check that could not pass yet, or a file no task owned | b1 and b2 item 2, b2 item 9 | c1 chain 1, c3; chain 2, c3 | row 94, mitigated |
| The orchestrator ended its turn while background agents worked | b1 items 5 and 9, b2 item 4 | — | row 96, mitigated |
| The benchmark's tool list or shared environment (no `uv run`, `rm` or `git checkout`; a generator missing from `node_modules`; `node_modules` invisible to Glob) | b1 items 3, 6 and 10, b2 item 10 | c1 chain 2, c2 | row 101 and the registered tool list |

The bare variant ran with the same tool lists. The engine's sessions stopped to ask the user where a bare agent finds another route, and the playbooks tell them to stop.

### Rechecks of the failed Mealie runs (sensitivity, model-free)

Each failed run's saved patch was applied in a fresh sandbox built by the pinned harness, and its hidden checks were run again. The registered result stands; this is reported beside it.

| Run | Recorded | Recheck |
|---|---|---|
| b1 item 4 (feature) | 1/2 | 1/2 |
| b1 item 5 (frontend) | 0/2 | **2/2**: the batch's failure came from processes the agent left running (row 100) |
| b1 item 6 (migration) | 1/2 | 1/2 |
| b1 item 10 (routes) | 1/2 | 1/2 |
| b2 item 6 (migration) | 0/2 | **1/2**: the regression check passes in a clean tree |
| b2 item 9 (security) | 1/2 | 1/2 |
| b2 item 10 (routes) | 1/2 | 1/2 |
| b3 item 6 (migration), both runs | 1/2 | 1/2 |
| b3 item 10 (routes), run 2 | 1/2 | not replayable: its change touched a binary test image, which saved patches leave out |
| b4, both runs | 1/2 | not rechecked: no change was made |

With the rechecks, the engine passed every Mealie hidden check in 14 of 20 runs, against 17 of 20 bare.

### Every run

| Process | Item | Variant | Hidden checks | Delivered, clean audit | Abandoned by the operator | Cost $ | Minutes |
|---|---|---|---|---|---|---|---|
| b1 | mealie-01-refactor | engine | 2/2 | no | yes | 0.32 | 1 |
| b1 | mealie-02-fix | engine | 2/2 | no | yes | 0.69 | 5 |
| b1 | mealie-03-fullstack | engine | 2/2 | no | yes | 1.22 | 10 |
| b1 | mealie-04-feature | engine | 1/2 | yes | no | 3.68 | 30 |
| b1 | mealie-05-frontend | engine | 0/2 | no | yes | 1.20 | 16 |
| b1 | mealie-06-migration | engine | 1/2 | no | yes | 1.93 | 13 |
| b1 | mealie-07-quick | engine | 2/2 | yes | no | 0.57 | 14 |
| b1 | mealie-08-debug | engine | 2/2 | yes | no | 0.40 | 6 |
| b1 | mealie-09-security | engine | 2/2 | no | yes | 1.81 | 27 |
| b1 | mealie-10-routes | engine | 1/2 | no | yes | 1.85 | 8 |
| b2 | mealie-01-refactor | engine | 2/2 | no | yes | 1.06 | 48 |
| b2 | mealie-02-fix | engine | 2/2 | no | yes | 0.63 | 4 |
| b2 | mealie-03-fullstack | engine | 2/2 | no | yes | 3.75 | 47 |
| b2 | mealie-04-feature | engine | 2/2 | no | yes | 2.38 | 28 |
| b2 | mealie-05-frontend | engine | 2/2 | yes | no | 2.20 | 29 |
| b2 | mealie-06-migration | engine | 0/2 | no | yes | 4.03 | 26 |
| b2 | mealie-07-quick | engine | 2/2 | yes | no | 0.60 | 21 |
| b2 | mealie-08-debug | engine | 2/2 | yes | no | 0.45 | 7 |
| b2 | mealie-09-security | engine | 1/2 | no | yes | 1.27 | 5 |
| b2 | mealie-10-routes | engine | 1/2 | no | yes | 1.83 | 9 |
| b3 | mealie-01-refactor | without | 2/2 | — | — | 0.15 | 28 |
| b3 | mealie-01-refactor | without | 2/2 | — | — | 0.13 | 5 |
| b3 | mealie-02-fix | without | 2/2 | — | — | 0.19 | 2 |
| b3 | mealie-02-fix | without | 2/2 | — | — | 0.27 | 3 |
| b3 | mealie-03-fullstack | without | 2/2 | — | — | 0.35 | 2 |
| b3 | mealie-03-fullstack | without | 2/2 | — | — | 0.37 | 3 |
| b3 | mealie-04-feature | without | 2/2 | — | — | 0.26 | 5 |
| b3 | mealie-04-feature | without | 2/2 | — | — | 0.17 | 3 |
| b3 | mealie-05-frontend | without | 2/2 | — | — | 0.14 | 1 |
| b3 | mealie-05-frontend | without | 2/2 | — | — | 0.19 | 1 |
| b3 | mealie-06-migration | without | 1/2 | — | — | 0.33 | 2 |
| b3 | mealie-06-migration | without | 1/2 | — | — | 0.29 | 3 |
| b3 | mealie-07-quick | without | 2/2 | — | — | 0.09 | 0 |
| b3 | mealie-07-quick | without | 2/2 | — | — | 0.09 | 0 |
| b3 | mealie-08-debug | without | 2/2 | — | — | 0.13 | 11 |
| b3 | mealie-08-debug | without | 2/2 | — | — | 0.09 | 3 |
| b3 | mealie-09-security | without | 2/2 | — | — | 0.22 | 7 |
| b3 | mealie-09-security | without | 2/2 | — | — | 0.25 | 5 |
| b3 | mealie-10-routes | without | 2/2 | — | — | 0.71 | 6 |
| b3 | mealie-10-routes | without | 1/2 | — | — | 0.81 | 8 |
| b4 | mealie-07-quick | engine | 1/2 | no | — | 0.34 | 1 |
| b4 | mealie-07-quick | engine | 1/2 | no | — | 0.26 | 1 |
| c1 | planner-c1 (chain 1) | engine | 1/1 | yes | no | 8.30 | 45 |
| c1 | planner-c2 (chain 1) | engine | 2/2 | yes | no | 4.56 | 33 |
| c1 | planner-c3 (chain 1) | engine | 2/2 | no | yes | 1.50 | 8 |
| c1 | planner-c1 (chain 2) | engine | 0/1 | no | yes | 3.95 | 21 |
| c1 | planner-c2 (chain 2) | engine | 2/2 | no | yes | 3.49 | 20 |
| c1 | planner-c3 (chain 2) | engine | 2/2 | no | yes | 1.50 | 7 |
| c2 | planner-c1 (chain 1) | without | 1/1 | — | no | 0.47 | 3 |
| c2 | planner-c2 (chain 1) | without | 2/2 | — | no | 0.41 | 2 |
| c2 | planner-c3 (chain 1) | without | 2/2 | — | no | 0.22 | 1 |
| c2 | planner-c1 (chain 2) | without | 1/1 | — | no | 0.39 | 2 |
| c2 | planner-c2 (chain 2) | without | 2/2 | — | no | 0.23 | 1 |
| c2 | planner-c3 (chain 2) | without | 2/2 | — | no | 0.25 | 1 |

### Refusals

360 refusals were extracted from the engine runs' transcripts (each chain item's own lines, amendment 1). Each was labelled before any summary figure was computed ([labels](../pilot/mealie/labels/refusals.json)):
- 177 harness: the benchmark's own `--allowedTools` list, and session-end cancellations of a background agent's pending call;
- 81 correct;
- 52 agent errors;
- 50 false (ECCode wrong).

Labels were corrected twice before any figure, and both corrections are in the labels' commits:
- 24 refusals were first labelled harness and then corrected to correct. They were ECCode guard "asks" that Claude Code records as configuration denials in a headless run.
- One label went from false to correct. The run its reviewer cited had failed on its own merits, not only on the integrity window.

The 50 false refusals by cause:

| Cause | False refusals | Register |
|---|---|---|
| Reviews could not cite what an earlier gate approved | 15 | row 92 |
| Guard misreads (escaped quotes, `find`, `git stash`, a `cd`, "eccode" inside a path) | 12 | rows 89, 90 |
| The integrity window erased or failed other agents' evidence | 10 | rows 86, 88 |
| Rework of an approved phase stranded | 3 | row 95 |
| A program and a record path in one command | 3 | row 91 (open) |
| Role agents without their MCP tools | 2 | row 82 |
| A failed reproduction refused as evidence | 2 | row 93 |
| A refactor without a behaviour command | 1 | row 85 |
| A test function taken for public API | 1 | row 75 |
| A gate closed by its first reviewer | 1 | row 103 |

By process: b1 4, b2 21, b4 2, c1 23.

### Review findings

The engine runs' reviews recorded 168 findings: 1 blocking, 20 major, 90 minor and 57 info.
- **The 21 blocking and major findings:** each was read against the artifact it cites ([verdicts](../pilot/mealie/labels/findings.json)), and all 21 describe a real gap. Four were confirmed by running a command:
  - repository-wide ruff failed outside the change (A7 measured the same at P);
  - `node --test tests/` fails on Node 22;
  - a ruff I001 on a changed file;
  - a planned frontend lint command that could not pass.
  Most were design and plan gaps caught before any code: an error path that returned 500, a check that did not run the new tests, and a producer task verified by tests a later task writes.
- **The 147 minor and info findings** are counted, not checked one by one. This is a deviation from the protocol's "each checked real or not", made for time and disclosed here.
- **One blocking finding never reached the record.** In b2 item 6 the security reviewer showed an SSRF bypass in the new avatar download against a local server: `urlsplit` and urllib3 read different hosts. The record refused it because the technical approval had already closed the gate (row 103). Its evidence logs are in the item's record copy. The finding was not independently re-verified.

### The long-lived record

| Chain | Events after ten items | Record size | `status` / `metrics` / `audit` at the end | Incremental index per item |
|---|---|---|---|---|
| b1 | 395 | 474 KB | 81 / 79 / 928 ms | 408–559 ms |
| b2 | 527 | 583 KB | 78 / 108 / 1,306 ms | 330–541 ms |

Both records stayed audit-clean across ten work items, three of them abandoned by the operator policy, but no item recorded a lesson (row 106).

- **Tests written:** engine Mealie runs changed a test file in 13 of 20 runs, bare runs in 12 of 20.
- **Planner patches:** in c1 chain 2, item c1, the patch includes 21 files under `node_modules`. The agent installed a dependency and did not ignore it, so that run's file and test counts include them.

## Defects found while the batch ran

Each was fixed in the main tree with a test that failed first, while the batch ran unchanged from the pinned worktree. Amendment 1 of the protocol lists each one as it was found, and the register rows give the evidence:
- **Role agents and MCP:**
  - role agents had no MCP tools (row 82);
  - MCP calls timed out at 60 s (row 83);
  - MCP could not narrow a check or deliver (row 84).
- **The engine:**
  - a refactor without a behaviour command (row 85);
  - the integrity window erasing other agents' events (row 86), and blaming a teammate's edits on a check (row 88);
  - guard misreads (row 89), and the holes and regressions the final review found in their fixes (row 90);
  - approved artifacts not citable (row 92);
  - a failed reproduction refused (row 93), and a gate closed by its first reviewer (row 103);
  - rework stranded (row 95);
  - sub-project checks pinned to the wrong project (row 97), and task-runner arguments read from comments (row 98).
- **The harness:**
  - inherited launcher settings (row 99);
  - leftover processes (row 100).

A fresh reviewer then reviewed the whole branch. Its six Important findings were fixed the same way. The minors it raised are listed as deferred in the branch's final notes.

## After-fix checks of the MCP item (outside the batch)

The registered MCP item (b4) stopped before any edit in both runs (row 82). Six single runs of the same item, with the no-shell profile, checked the fixes end to end as they landed. They are not batch results.

| Check | What it found or showed | Hidden checks | Delivered | Cost |
|---|---|---|---|---|
| 1 | Claude Code's 60-second MCP call timeout cut off `evidence_run` (row 83) | both pass | no | $0.46 |
| 2 | The quick setup pinned a backend change to the frontend sub-project's tests (row 97) | both pass | no | $0.26 |
| 3 | Background subagents stopped when the orchestrator ended its turn (row 96); leftover processes made sandbox removal fail, and the run's record was lost (row 100) | not recorded | not recorded | not recorded |
| 4 | The engineer claimed through MCP and its fix passed, but MCP could pin only the whole suite, which outran `evidence_run`'s 10-minute limit (row 84) | both pass | no | $0.39 |
| 5 | The whole quick track ran over MCP and both gates were approved, but MCP had no `deliver` (row 84) | both pass | no | $0.60 |
| 6 | Delivered with no shell: clean audit, two independent reviews | both pass | yes | $0.67 |

The five recorded checks cost $2.38. The third check's cost was lost with its record.

## Environment and harness disclosures

- **Contention.** The six batch processes ran at once on four CPUs. Part A's after-fix run (three pytest jobs in A2, then A3 to A7) ran beside b2's items 6 to 10. Wall times include this contention, in every variant alike.
- **Shared environments.** 51 files under `ECCODE_MEALIE_ENVS` changed after the launch. All are caches written by test runs: 47 jiti transpile caches and 3 vitest result caches under `node_modules`, and one Python bytecode file. The writers were agents, hidden checks, rechecks and Part A. No package was installed.
- **Trees.** The repository, the pinned worktree and the after-fix worktree had no uncommitted or untracked file after the batch. No transcript refers to `.bench-hidden`, the suite's `_hidden` directory or the pinned worktree.
- **What agents could see outside their sandbox.** The host repository's path appears only as `OLDPWD` in an environment dump one reviewer recorded. Two transcripts include a `ps` listing that shows the other bench processes' command lines; no run read another's files (row 70).
- **`node_modules` symlink (row 101).** The frontend's `node_modules` is a symlink to a shared environment, which Claude Code's Glob and Grep do not follow. On the full-stack item an agent concluded it was missing.
- **Inherited launcher settings (row 99).** Every session of the batch ran with the launching session's effort, background-subagent setting, extra directories and plugin sync, in every variant alike. Chain items appended to one transcript file, and the analysis counts each item's own lines (amendment 1).
- **Leftover processes (row 100).** The batch's harness did not stop what an agent left running. The b1 frontend item failed both hidden checks in the batch and passes them in a clean tree.
- **The analysis.** `analyse.js` was run once on partial data while the batch ran, before labelling was complete, to check the pipeline. Its output was discarded, and no figure here comes from it.

## What this means

- **On a real project, at the protocol commit, the engine was not ready.** Its gates did their job:
  - no record failed its audit;
  - every blocking or major finding checked was real;
  - one review caught a demonstrated SSRF bypass.

  But it delivered 30% of the work, stopped often to ask the user, and refused correct steps 1.8 times per item. The bare agent, with the same tools, passed more hidden checks.
- **Almost every stop has a cause now on the register,** and most of those causes are fixed and tested. What remains open:
  - plans that pin a check that cannot pass yet (row 94);
  - orchestrators that end their turn while agents work (row 96);
  - checks that run one at a time (row 87);
  - the text guard's program-and-record rule (row 91);
  - lessons never being recorded (row 106);
  - the benchmark's tool list.
- **What would show the fixes work** is the same protocol run again at the fix commit, pre-registered, with the same items. That run has not been done.
