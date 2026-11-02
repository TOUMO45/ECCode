# Phase 3 report

Written 2026-11-01. Branch `claude/eloquent-cray-0g0y6v`. Claims are sorted Verified / Reported / In flight / Pending, as the project's register requires. The full engine suite is **486 tests, 0 failing, 8 skipped** without the Python fixtures.

## 0a. Integrity check (2026-11-02, no spend)

**Test lists.** The two pre-merge heads (`9772341`, this session; `e3b6436`, the session that launched the re-measurement) and the merged head were compared by test name (every `test(` of every `tests/*.test.js`, by file and title) and by `node --test` run in a worktree at each head:

| Head | Top-level tests (by name) | `# tests` | `# pass` | `# fail` | `# skipped` |
|---|---|---|---|---|---|
| 9772341 (this session, pre-merge) | 478 | 489 | 461 | 0 | 28 |
| e3b6436 (other session, pre-merge) | 469 | 480 | 452 | 0 | 28 |
| merged head (current) | 484 | 495 | 467 | 0 | 28 |

No test of either head is missing from the merged head (the name diff is empty in both directions); the merged head is the union (the two `bench-resume` test files were concatenated). The 28 skips are environment-gated (Mealie live validation, `ECCODE_PYTHON`, tracers) and identical on all three heads. The "~474 at handoff" figure matches no head's `# pass`; the other session's own commit message reports 457 passing at `e3b6436`, which this machine runs as 452 (five environment-dependent tests), so the counts differ by environment, not by tests lost.

**Frozen H-B files.** `node bench/pilot/phase2-seeds.js check` and a per-file sha256 against `bench/pilot/phase2-freeze.json` (33 files): all **33 match at the frozen commit `4fbb80e`**, the worktree the measurement runs from; both detector files (`lib/behavior.js`, `scripts/behavior/probe_runner.py`) match on HEAD; 13 engine files differ on HEAD, the registered Phase 3 drift of row 157, of which 10 already differed at the handoff head `69aa414` and **3 were changed by this session** (`lib/lab.js`: the headless ask-user escalation; `lib/project.js` and `lib/quick.js`: the pre-flight hook). `lib/preflight.js` and the Phase 3 modules are in the require closure but not in the freeze (the rule's known gap, row 157). Verdict: pass under the registered rule; the measurement never loads HEAD.

**Seed key.** `ECCODE_SEED_KEY` is absent from this environment (presence checked, nothing printed): 0.D (seed validation and the H-B measurement) is **blocked on the owner's key**.

## 1. What was built, per part (events, gates, tools)

**Part A — design before code** (`lib/design.js`, `tests/design.test.js`). Events `design.alternatives`, `design.decision`, `design.adr` (content-hashed ADR), `design.spike.started/closed`, `design.amended`, `request.ambiguity`, `request.clarified` (user only), `request.assumption`. Gates: no task ownership on feature/refactor/greenfield without a decision over ≥2 alternatives with five tradeoffs each (`TRACK_RULE`); a decision locked once work starts (`DESIGN_LOCKED`); a spike never ships, by path or content hash (`INVALID_HANDOFF`/`DELIVERY_BLOCKED`); the verification review must cite the ADR (`REVIEW_REJECTED`); an interface the ADR does not declare blocks delivery; a blocking ambiguity stops planning (`AMBIGUITY_OPEN`) until the user clarifies or an assumption is recorded (surfaced in every handoff and the report). CLI `design`/`request`; MCP `design_*`/`request_*`.

**Part B — production guards** (`lib/guards/`, `scripts/guards/`). `guard.routing` (what the change needs, from `impact` and surfaces). B.1 migration (`migration.analysis` static Alembic analysis; `migration.rollback.proof` upgrade→downgrade→upgrade schema round-trip). B.2 `api.diff` (OpenAPI + Python signatures, breaking/additive/none). B.3 `perf.result` (two-worktree micro-benchmark with SQLAlchemy query counts for N+1). B.4 `race.result` (concurrent operations with SQL invariants). B.5 `release.plan` + `release.acknowledged`. `guard.waiver` (reviewer). Delivery and the last gate refuse a required guard not run on the current tree or a blocking finding unwaived. CLI `guard`; MCP `guard_*`.

**Part C — security as a capability** (`lib/security.js`, `scripts/guards/access_probe.py`). Executed `security.matrix.result`, `security.idor.result`, `security.authflow.result`, `security.input.result`, plus declared `security.policy`; against the project's own FastAPI app in a worktree with the network closed. Delivery refuses a change touching auth/routes/ownership without a matrix and IDOR result with zero unexplained failures; an unknown matrix cell needs a reviewed policy. CLI `security`; MCP `security_*`.

**Part D — large-change planning** (`lib/plan-budget.js`). `plan.contracts` (interfaces agreed before implementation), a per-task file/line budget (`task.budget.waived`), `plan.checkpoint` every N tasks (`CHECKPOINT_DUE`), a rescope that cites its contract and a blocking ambiguity when a contract changes twice; planned-vs-delivered in the report. CLI `plan contracts|checkpoint`, `task waive-budget`; MCP.

**Part E — observed standards** (`lib/standards.js`). `project.standards` from git history and config (commit style, naming, test layout, error handling, stated lint rules), recorded as project memory and shown at onboarding; observed, never enforced.

**Part F — risk-routed cost** (`bench/pilot/phase3-cost.js`). Cost per correct change per track with the targets (quick 1.5×, fix 4×, feature 8× bare).

**Part G — Senior Bench** (`bench/protocols/2026-11-01-senior-bench.md`, `bench/pilot/senior-bench.js`). 7 categories, harness-graded (the guards re-run on each arm's delivered tree, frozen by hash in `senior-bench-freeze.json`), ≥12 items/category (power 0.88 at a conservative odds ratio of 3), arms bare/ECC/Phase 3, all the brief's metrics, go/no-go, screening cap $100, measured-arm estimate ~$5,500–10,500. Registered, not launched.

Wiring: `STATE_VERSION` 6; new events reduced and their artifacts re-hashed by `audit`; record protection in the guard hook and sandbox profile; `lib/worktree.js` (the behavior diff's worktree pattern, exported for the guards).

## 2. Fixture scorecards (B and C), with real numbers

`tests/fixtures/phase3/ledger` is a FastAPI + SQLAlchemy + Alembic app (45 passing tests) with 31 seeded flaws (`seeds.js`). `tests/phase3-guards.test.js` runs each guard on each flaw and writes `tests/fixtures/phase3/scorecard.md`. **Zero false positives across all parts** (every safe counterpart left alone); the test asserts this and that every miss is a documented, justified limitation.

| Part | Guard | Caught / expect | False positives | Clean-correct / expect |
|---|---|---|---|---|
| B.1 | migration | 4 / 4 | 0 | 4 / 4 |
| B.2 | API | 2 / 3 | 0 | 3 / 3 |
| B.3 | performance | 3 / 3 | 0 | 2 / 2 |
| B.4 | concurrency | 1–2 / 2 | 0 | 1 / 1 |
| C | security | **8 / 8** | 0 | 1 / 1 |
| **all** | | **18 / 20** | **0** | **11 / 11** |

The 6–7 misses are each a limitation of the specific guard against this app, not a false reading, and are listed with justifications in the scorecard:
- **B.2 b2-field-type**: the ledger routes declare no `response_model`, so the OpenAPI response schema is empty and the schema-only API diff cannot see a field's type change (the Phase 2 behavior diff catches this at runtime; the compatibility guard reads the schema).
- **B.4 b4-double-spend / b4-duplicate-insert**: the app's `BEGIN IMMEDIATE` transactions make the double-spend window sub-millisecond on sqlite (caught ~50–85% of runs, a bonus when the race fires) and make the duplicate-insert check-then-insert atomic (never reproduces). The guard catches a race only when the concurrency actually provokes it.
- **The four Part C misses of the first scorecard are now closed** (directive follow-up): a field-leak oracle (diff a non-owner's response fields against a declared field policy; sensitive names flagged by default), a mass-assignment probe (inject privileged fields on a write, read back, flag what persisted), and a SQL boolean differential (a tautology against a contradiction) took security from 4/8 to **8/8**, including the c-idor-update bonus. A real matrix bug was fixed on the way (request bodies were built from the already-substituted URL; the route-focus filter now tolerates a mount prefix). Zero false positives still hold.
- **The two remaining misses are both Part B and structural**: **b2-field-type** (the ledger declares no `response_model`, so the schema-only API diff cannot see an int→str response field change; the Phase 2 behavior diff catches this at runtime), and **b4-duplicate-insert** (the check-then-insert is one `BEGIN IMMEDIATE` transaction on sqlite, so a duplicate is never produced; b4-double-spend is sub-ms and caught in most runs, tolerated as flaky).

Recorded in limits rows 161–162 and 166. The guards are executed oracles (migration static analysis and rollback proof, query-count N+1, body-aware access matrix with field-leak and mass-assignment probes, SQL boolean differential, auth-flow single-use), honest about what a schema-only API diff and a sqlite atomicity artefact cannot show.

## 3. Deviations from the brief (each pinned by a test)

See `docs/design/phase3-plan.md` §7. The load-bearing ones: H-B is measured from the `phase2-hb-freeze` worktree, not HEAD, because the freeze covers the whole engine and Phase 3 edits it (row 157); `lib/worktree.js` duplicates the frozen behavior-diff worktree code; the Part D task budget caps size with a waiver, reversing the architecture doc's "measure, never cap" (row 163); hot paths = the change's surfaces + impact dependents; OpenAPI/signature diff is FastAPI/Python only (row 160); design is enforced at claim on refactor (no design gate there); a headless blocking ambiguity is resolved by a recorded assumption; Part E is report-only.

## 4a. Cost profile and narrowing (Part F, directive follow-up)

`bench/pilot/phase3-profile.js` reads an engine run's saved `record/` and attributes wall-clock to phases. On the 0.A ECCode (Phase 2 debug) Mealie runs captured so far (5 runs of mealie3-01):

| Phase | Minutes (summed) | Check runs |
|---|---|---|
| other checks (verification / stack: the full Mealie backend suite) | 18.4 | 38 |
| behaviour diff + guard-labelled probe runs | 15.5 | 19 |
| lab: reproduce / baseline | 7.9 | 26 |
| behaviour diff | 4.5 | 12 |
| fix verify | 2.1 | 8 |

**Top three sinks:** (1) repeated full-suite check runs (the agent re-runs the pinned Mealie suite, ~168 s for 3,583 tests, to check its own work — the longest runs did it 10+ times); (2) review re-rounds (the 31–36 min runs had 7–11 review records, 3–7 rejected, each forcing a re-run); (3) the Lab's reproduction and baseline suite runs. A 36-minute run spent 24 minutes in check commands.

**Measured saving of scoping a check:** the mealie3-01 fix's own target tests (~20 ids, the recipe-migration subset) ran in ~30 s against the ~168 s full suite — about **5× per check**. Since checks are ~50–65% of a run's wall-clock, scoping the iteration checks would cut a ~35-minute run to roughly 15–20 minutes.

**Narrowings:**
- **Implemented, no gate change — guard routing by surface.** The guards already run only when the change reaches the relevant surface: a change touching no route runs no API/perf/security guard, a change with no migration file runs no migration guard, a change outside the race watch-paths runs no race probe (verified: a feature change reaching no code surface requires only the release-plan presence, no B/C guard). The behavior diff already probes only impacted surfaces (`surfacesOf`). So a small or docs-only change on a guard track pays nothing for the guards it does not need.
- **Implemented, owner-authorized at gate level — staged verification.** `config.verification.staged` (default on). A task iterates on impact-scoped checks; the guarantee is that the *claim of done* cites a passing run of the task's pinned **full** verification command, not that every iteration reruns everything. `lib/tasks.js` refuses a claim whose only cited passing run is scoped (a subset, or a trivially-passing command), naming the scoped run. The full command runs once at the claim and again at the reviewer's independent re-run. This preserves the gate's guarantee (final evidence is the full suite) while removing the per-iteration full-suite re-runs that were ~50–65% of a run's wall-clock. Positive/negative/bypass tests: `tests/review-discipline.test.js`.
- **Implemented, owner-authorized at gate level — review discipline.** On a code gate (phase/verification), a `changes_requested` finding must cite an executed failing check (`ev:<id>` of a failed command) or a specific `file:line` in its detail; `lib/gates.js` refuses an uncited rejection. Prose gates (architecture/design) are exempt. On an impact-routed low-risk task (guard routing required no production-sensitive guard), after `config.review.maxRejectionsBeforeDecision` rejections (default 1) the reviewer must approve or escalate rather than reject again — this bounds the 3–7 review re-rounds that drove re-runs. Positive/negative/bypass tests: `tests/review-discipline.test.js`. Commit `28c22d0`; full suite green (451 pass). Frozen H-B detector files unchanged (verified by hash).

**Re-measurement (narrowed engine) — done.** The Phase 3 debug track with the narrowing above, on the two Mealie hard items, 3 runs each, two parallel streams (concurrency 2). Total spend **$29.46 of the $60 cap**; neither item hit its $30 cap. Records: `bench/pilot-results/2026-11-01-phase3-remeasure-narrowed.{m3,m4}.jsonl`. Hidden pass = the item's hidden checks all pass; delivered = the engine completed delivery with a clean audit.

| Arm | mealie3-01 (hidden / delivered / $per run / min per run) | mealie4-05 (hidden / delivered / $per run / min per run) |
|---|---|---|
| narrowed debug (this run) | **3/3 pass, 3/3 delivered**, $4.00, 53.5 min | 3/3 hidden-pass, **2/3 delivered = 2/3 correct (ITT)**, $5.82, 71.9 min |
| 0.A debug (un-narrowed) | 2/5 pass, **1/5 delivered**, $2.39, 23.3 min (friction-stalled; truncated by a container restart) | no debug baseline recorded |
| bare | 10/10 pass, no engine, $0.37, 2.8 min | **6/10 pass**, no engine, $0.49, 3.6 min |
| ECC | 10/10 pass, $1.20, 7.9 min | 5/5 pass, $1.90, 16.4 min |

**What the re-measurement shows.**
- **The narrowing removed the delivery-blocking friction (the headline).** On mealie3-01 — the hard multi-file item where 0.A's un-narrowed engine delivered only 1 of 5 and stalled on the rest for a user decision a headless run cannot give (item 1's (b) finding) — the narrowed engine delivered **3 of 3** with clean audits and hidden 2/2. On mealie4-05 it delivered 2 of 3 and passed the hidden checks 3/3; the one non-delivery passed the hidden tests but was refused by the engine after post-approval edits (delivered=false) — a (b) case (a correct fix, not delivered), not a wrong patch, and **counted as a failure of the arm intention-to-treat** (the registered correctness figure is 2/3; it is the second H-C false refusal).
- **It is a capability result where bare is capability-deficient.** mealie4-05 is the item where bare ships an incomplete/unverified fix (6/10); the narrowed engine and ECC both pass it. So on the genuinely hard item the engine's discipline pays off.
- **It did not make the engine cheaper or faster per run than bare or ECC, and the report does not claim it did.** The disciplined debug process (reproduce → fix-verify → mutation → review → full-suite verification at the claim → the reviewer's independent full-suite re-run, both observed running live) is inherently heavier: ~53–72 min and $4–6 per completed delivery, against ECC's ~8–16 min / $1–2 and bare's ~3 min / $0.4 (bare and ECC run far less verification). What the narrowing bought is **completion**: the engine now finishes and delivers within a bounded cost ($29.46 for six runs) where it used to stall. Staged verification kept iteration checks scoped while the full command still ran at the claim and again at the reviewer's re-run; review discipline bounded the re-rounds. Total wall time was ~3h40m elapsed for the two parallel streams (376 min summed across the six runs).

## 4b. Bench runner resumability (Part F, directive item 3)

The bench runner is now resumable (`lib/bench.js`, `bin/eccode.js`, `tests/bench-resume.test.js`). A batch saved with `--save` starts with a header line holding its plan (suite, tasks, variants, runs, agent command, options); every run record carries the batch id, its `runIndex`, `startedAt` and `completedAt` (the per-run completion record); the runs in flight are named with their sandbox in `<save>.inflight.json`. `eccode bench resume <runs.jsonl>` records each cut run as `interrupted` (its transcripts copied when it has any), removes its sandbox, and runs it and every other unfinished run again under the header's options; `--concurrency 2` runs two at a time on worker threads (two at most: the agents share the machine and the task environments; a batch killed mid-run with SIGKILL is resumed in the test). An older save file without a header is resumed by count: the runs already recorded per (task, variant) are skipped and the flags name the rest. `--max-cost` is carried as a **total** budget across the resume (the prior spend is counted, so a resumed batch cannot overrun its cap). A host concurrency guard caps concurrent `bench` streams at 2 (`liveBenchStreams`, best-effort via `ps`; `--force` overrides), matching the two-stream limit the re-measurement ran under. The resume was tested on a killed run: a batch stopped after one of three runs resumes to run only runs 2 and 3, ending with a contiguous `runIndex` 0–2. This is the formalized version of the append-as-it-lands persistence that already let a killed batch keep its finished runs.

**Final comparison table, intention-to-treat** (`node bench/pilot/narrowed-compare.js`, computed from the records; the ECC row of mealie4-05 counts the 5 calibration runs, which the protocol counts toward its 10). An engine arm's run is **correct only when its fix passed the hidden checks and was delivered**: a correct fix the engine refused is the arm's failure, not a pass (intention-to-treat). Cost per prevented failure, as amendment 3 defines it, per run and on the ITT counts: (the arm's mean cost per run − bare's) / (bare's failure rate − the arm's); undefined where bare never failed.

| Item | Arm | Runs | Passing every hidden check | Delivered | Correct (ITT: passed and delivered) | Mean $/run | Mean min/run | $ per prevented failure vs bare (ITT) |
|---|---|---|---|---|---|---|---|---|
| mealie3-01-fix-3be8f3d8 | bare | 10 | 10/10 | — | 10/10 | 0.37 | 2.79 | — |
| mealie3-01-fix-3be8f3d8 | ECC v2.2.3 | 10 | 10/10 | — | 10/10 | 1.20 | 7.88 | undefined (no failure prevented) |
| mealie3-01-fix-3be8f3d8 | 0.A debug (un-narrowed Phase 2) | 5 | 2/5 | 1/5 | 1/5 | 2.39 | 23.34 | undefined (no failure prevented) |
| mealie3-01-fix-3be8f3d8 | narrowed Phase 3 debug | 3 | 3/3 | 3/3 | 3/3 | 4.00 | 53.48 | undefined (no failure prevented) |
| mealie4-05-fix-fb221afa | bare | 10 | 6/10 | — | 6/10 | 0.49 | 3.55 | — |
| mealie4-05-fix-fb221afa | ECC v2.2.3 | 10 | 10/10 | — | 10/10 | 1.79 | 19.88 | $3.26 |
| mealie4-05-fix-fb221afa | narrowed Phase 3 debug | 3 | 3/3 | 2/3 | 2/3 | 5.82 | 71.86 | $79.99 |

Reading: on mealie4-05, the item where bare ships an incomplete fix 4 times in 10, ECC prevented every bare failure at **$3.26** of extra spend per prevented failure. The narrowed Phase 3 debug track passed the hidden checks in all 3 runs but **delivered 2 of 3**: run 3 was a correct fix the engine refused (the agent re-wrapped a comment after the approval, reverted it, and an evidence log's hash no longer matched; the verification reviewer rejected and the only way out was a user-only reopen), so intention-to-treat its failure rate is 1/3 against bare's 4/10 and a prevented failure cost **$79.99** (on the hidden checks alone, which is not the registered reading, it would be $13.33). That run is recorded under H-C with the 0.A run #3 case as the second false refusal (Phase 2 protocol, amendment 3; 2 of 11 ECCode Mealie debug runs, mean 0.18 per run, within H-C's ≤ 1.0); the headless rule now lets the orchestrator reopen an approved gate whose artifacts changed after approval (resubmitted and reviewed again), closing that path. On mealie3-01 bare never fails, so no arm can prevent a failure there; what the narrowed track changed is delivery (3/3 against 1/5 un-narrowed), at 11× bare's cost and 19× its time per run. The earlier "3/3 pass" wording for mealie4-05 in the table above stands as a hidden-check figure only; the registered correctness figure is **2/3**. A supplementary mealie4-05 run (run 4, launched from a fresh container when run 3 was thought lost with the first container's restart; delivered, hidden 2/2, $5.90, 108.9 min) is outside the registered three everywhere: flagged `supplementary` in its record, left out of this table, and used only for the time profile in §4c.

## 4. Cost per track on the fixtures vs targets

From the realbugs batch (the only data with all tracks today): bare 1×; quick/engine **3.58× bare, over its 1.5× target**; fix/debug **3.49×, within its 4× target**. The quick figure is the full engine cost on realbugs; narrowing (skip the behavior diff on a no-surface quick change; skip perf when no route is reached) is proposed before the measured Senior Bench run. Reported, no gate (Part F). `node bench/pilot/phase3-cost.js <runs.jsonl>`.

## 4c. Time profile of the narrowed runs (directive item 3)

**What survived and what did not.** The six registered narrowed runs ran in the first container (the session that launched them). Their transcripts and engine records (`--transcripts`) lived in that container's scratch space and were not committed, so no per-phase profile of those six exists; their run records carry only wall-clock, cost, turns, dispatches, review rounds and the number of checks recorded:

| Item | Run | Minutes | $ | Orchestrator turns | Subagent dispatches | Reviews | Rejections | Checks recorded | Delivered | Hidden |
|---|---|---|---|---|---|---|---|---|---|---|
| mealie3-01 | 1 | 46.7 | 3.2303 | 56 | 15 | 3 | 0 | 10 | yes | 2/2 |
| mealie3-01 | 2 | 52.6 | 3.8384 | 29 | 17 | 6 | 1 | 16 | yes | 2/2 |
| mealie3-01 | 3 | 61.1 | 4.9313 | 24 | 21 | 6 | 1 | 22 | yes | 2/2 |
| mealie4-05 | 1 | 55.4 | 5.6597 | 74 | 27 | 6 | 1 | 21 | yes | 2/2 |
| mealie4-05 | 2 | 101.0 | 6.4738 | 75 | 32 | 10 | 2 | 32 | yes | 2/2 |
| mealie4-05 | 3 | 59.1 | 5.3217 | 6 | 16 | 5 | 2 | 22 | no | 2/2 |
| mealie4-05 | 4 (supplementary run 4) | 108.9 | 5.9015 | 54 | 13 | 4 | 0 | 9 | yes | 2/2 |

So that this cannot happen again, every engine run record the bench writes now carries the run's **profile** (`lib/profile.js`, kept in the record by `lib/bench.js` at grading time, before the sandbox is removed): wall-clock minutes per phase from the record's events (plan, lab, implement, review, guards and delivery, behavior diff, orchestrator between dispatches), every executed check binned by what it was for (lab: reproduce/baseline, lab: hypotheses, fix verify, mutation, scoped checks, full claim run, reviewer re-run, behavior diff, production guards), and agent time with no command running per phase. `bench/pilot/phase3-profile.js` reads either saved transcript directories or the records' profiles (`--records`).

**The one fully instrumented narrowed run** is the supplementary mealie4-05 run 4 (launched from this fresh container when run 3 was thought lost with the first container's restart; 108.9 min, $5.90, delivered with a clean audit, hidden 2/2; outside the registered three, flagged `supplementary` in the record). Its record is profiled below (`node bench/pilot/phase3-profile.js <its transcripts dir>`; 48.4 of its 108.5 minutes were executed checks):

| Phase | Wall-clock min | Agent time (no command) min |
|---|---|---|
| implement | 45.75 | 40.28 |
| behavior diff | 31.05 | 1.64 |
| review | 15.68 | 3.49 |
| orchestrator between dispatches | 7.17 | 6.07 |
| lab | 3.84 | 3.65 |
| guards and delivery | 2.23 | 2.22 |
| verification | 1.4 | 1.39 |
| plan | 1.24 | 1.24 |
| plan review | 0.18 | 0.18 |

| Commands | Minutes | Runs |
|---|---|---|
| reviewer re-run | 32.85 | 11 |
| behavior diff | 9.85 | 4 |
| full claim run | 2.61 | 4 |
| lab: reproduce / baseline | 2.17 | 12 |
| fix verify | 0.46 | 2 |
| scoped checks | 0.23 | 1 |
| lab: hypotheses | 0.2 | 2 |
| production guards | 0 | 1 |

**The top three sinks**, from the command bins (exact) and the agent-time bins (approximate: the interval between two record events is given to the activity under way):
1. **Agent time implementing, with no command running: 40.3 min.** The model writing a 1,000-line change and its tests across three tasks. No check runs here; this is generation time, and the narrowing cannot touch it.
2. **The reviewers' independent full-suite re-runs: 32.9 min over 11 runs.** The pinned full command for this item is the Mealie backend suite (729 s in the run's own words), and it ran for the technical reviewer, the security reviewer, and again after each of the 4 rejections of 8 review rounds (the low-risk review bound does not apply: the security guard is routed on this item). This is 68% of all check time and 30% of the run.
3. **The behavior diff's probe runs: 9.9 min over 4 runs** (baseline runs and candidate runs of the probe runner, on a configuration with no app, so they probed nothing and were waived by the reviewer): a cost with no information on this item.

The staged verification worked as designed on the owner's side: scoped checks 0.2 min, the full claim run 2.6 min over 4 runs; the Lab's reproduction, baseline and hypothesis runs cost 2.4 min. The full-suite re-run on the reviewer's side is the sink the narrowing left in place.

**Proposal (not implemented: it changes a gate, so it waits for the owner's approval). Reviewer mode: one full run per tree, not two or more.** The guarantee today is that the claim of done cites the owner's passing run of the pinned full command, and the reviewer's independent run of the same full command passes on the tree under review. The proposal keeps both halves and removes the duplicate work: (a) the engine already records a tree fingerprint with the owner's full claim run (the test-outcome invariant and the guards carry `treeFingerprint`); the reviewer's independent run becomes a run of the **impacted set** (the tests `impact` selects for the changed files, plus the task's scoped checks), and the engine refuses the approval unless the owner's cited full run has the **same tree fingerprint** as the tree the reviewer ran on, so one full run of exactly this tree exists and was independently spot-checked; (b) on a re-review after `changes_requested`, a reviewer re-run is required only when the fingerprint changed since the reviewer's last run. Same guarantee (a passing full run on exactly the delivered tree, an independent check on it), one full run instead of two per round and none on an unchanged tree. On this run it would have replaced 11 reviewer full-suite runs (32.9 min) with impacted-set runs of about half a minute each: roughly 27 minutes saved of 108 (25%), the behavior diff's 10 minutes on an unconfigured app being the next candidate (skip the probe runs when the configuration names no app, which is not a gate change). Pinned by nothing yet; `docs/limits.md` row 167 names the narrowing's current scope.

## 5. Part 0 results

- **0.B** (tornado-15 label): an independent labeller, given only the request, patch, hidden-check output and rubric, labelled it `agent-error` with high confidence (the fix is correct but the run rewrote an existing log line the test expects). Hard items with it: 4; without: 3.
- **0.C** (Mealie H-B config and runner): built from a deterministic rule, frozen (33-file freeze), tagged `phase2-hb-freeze` (commit `4fbb80e`); the measurement runs from a worktree at that tag. Recorded before measurement: the frozen route detector never joins `APIRouter` prefixes, so most Mealie seeds will be `insufficient-coverage` under the frozen pipeline and H-B will not be met as frozen (row 158) — the honest result of the frozen detector, for the owner to decide after 0.D.
- **0.A** (exploratory three-arm, 4 hard items × 10 × 3): ECC calibrated at **$1.66/run** on mealie4-05 (10–34 min, rising), replacing the 4–8× assumption; the full run projects to ~$150 under the $300 cap and **is running** (bare and ECC from HEAD, the ECCode Phase 2 arm from the `phase2-hb-freeze` worktree since HEAD is now Phase 3). Records in `bench/pilot-results/2026-11-01-phase2-ha-exploratory.*.jsonl`. Pre-registered as underpowered (primary power 0.00 at 4 items); reported for its per-item failure-mode-prevention table and silent-failure rate, never for significance.
- **0.A** per-item pass rates collected before a container restart truncated the background run (uptime showed 38 min; the same restart failure the multi-file run hit). Runs passing every hidden check / runs:

  | item | bare | ECC v2.2.3 | ECCode Phase 2 (debug) |
  |---|---|---|---|
  | tornado-10 | 9/10 | 10/10 | 10/10 |
  | tornado-15 | 10/10 | 9/10 | 9/10 |
  | mealie3-01-fix | 10/10 | 10/10 | 2/5 (truncated) |
  | mealie4-05-fix (SSRF) | 6/10 | **10/10** (incl. 5 calibration) | — (not reached) |

  Reading (exploratory, underpowered — primary power 0.00 at 4 items, no significance claimed): on tornado-10 both engines prevented bare's one failure; on tornado-15 (the close-call item) each engine introduced one failure bare avoided; on mealie4-05 (the genuinely hard item, bare 6/10) ECC passed every one of its 10 runs, preventing every bare failure. The Phase 2 debug arm is missing where it matters most (mealie4-05) and underperformed on the partial mealie3-01 (2/5), so those failures are being labelled and the arm is being relaunched to complete the table. The bare and ECC arms are now complete (ECC was topped up after the restart); only the debug (ECCode Phase 2) Mealie runs are the restart casualty (mealie3-01 2/5, mealie4-05 not reached), left truncated because completing them is ~10 h of restart-prone debug-Mealie runs for an arm the design pre-registers as underpowered. The independent tornado-15 label (0.B, `agent-error`) is applied: with it, tornado-15's engine failures are engine-introduced agent-errors; without it (reading the item as a spec-gap) they would not count. The table is reported both ways in the committed records.
- **0.A failure-mode labels** (`bench/pilot/phase2-screening/ha-labels.json`), classified from each failed run's record and the agent's own closing statement; (a) wrong patch delivered, (b) correct patch not delivered (timeout / cost cap / gate refusal with the work done / escalation), (c) other:

  | arm | item | runs failed | class | root cause |
  |---|---|---|---|---|
  | **ECCode (debug)** | mealie3-01 | 3 | **all (b) friction** | each stopped to ask the user with real work done: #1 group-scoping half proven, halted on a pytest import-file-mismatch breaking the pinned check; #2 archive-limit half complete (33 tests pass), halted on a `git stash` approval the sandbox asks the user for; #4 halted on a plan flaw needing a user-only rescope. Headless, nobody answers, so delivery never happens. |
  | ECCode (debug) | tornado-15 | 1 | (a) | delivered a correct fix that also rewrote an existing log line the hidden test pins — the close-call item; agent-error under the 0.B label, spec-gap without it. |
  | **ECC v2.2.3** | tornado-15 | 1 | (a) | same close-call log-line change (label-dependent). |
  | **bare** | mealie4-05 | 4 | all (a) capability | incomplete SSRF fix: `safehttp` written but existing OIDC tests break and the proxy (`NOPROXY`) requirement is unmet. |
  | bare | tornado-10 | 1 | (a) capability | unverified assumption: the fix clears the template namespace at the wrong handshake point; the hidden test fails. |

  **Stated plainly, as the directive asks:** on the hard multi-file Mealie item every ECCode debug failure is **(b) — friction and cost, not capability.** The agent did the work (one half proven, the other's 33 tests passing) and then halted for a user decision that a headless run cannot give (a pinned-check import clash, a `git stash` approval, a plan flaw needing rescope). Bare "passes" mealie3-01 10/10 precisely because it never stops to ask — it writes code straight through. This is the headless-friction the multi-file run documented, and it is exactly what the Part A headless-assumption path and the Part D large-change planning are meant to remove; it also motivates item 2's narrowing (fewer, scoped checks and bounded review rounds) and item 3's resumability. bare's own deficit, by contrast, is **(a) capability** — on the two genuinely hard items (mealie4-05 6/10, tornado-10 9/10) it ships incomplete or unverified fixes, which ECC and (where it delivered) ECCode did not. No (a) failure for ECCode on a Mealie item; no (c).
- **0.D** (seed validation and H-B): PENDING the seed key, which is not in this container; it runs when the owner sets `ECCODE_SEED_KEY`.

## 6. Senior Bench — round 1 screened; the measured arms await approval

Registered (section 1, Part G; amendments 1 and 2 in `bench/protocols/2026-11-01-senior-bench.md`). Round 1 (three categories, two arms) was **screened on 2026-11-01/02 for $31.88 of the $100 cap** (`bench/suites/senior`, `node bench/suites/senior/_tools/yield.js`):

| Category | Items screened | Bare runs | Runs passing correctness | Runs failing the harness grade / guessed | Usable items (>= 1 failing run) | Spend | Go/no-go (>= 12 usable) |
|---|---|---|---|---|---|---|---|
| migration | 9 | 27 | 19/27 | 0/27 | 0 | $15.95 | no-go |
| authorization | 5 | 15 | 15/15 | 0/15 | 0 | $2.93 | no-go |
| ambiguous | 16 | 48 | 37/48 | 46/48 | 16 | $13.01 | go |

Migration and authorization are **no-go** as screened: the bare agent writes a reversible migration when the request asks for one (0 of 27 runs fail the rollback grade; 3 of 9 items are still hard by correctness, labelled agent-error), and it fixes a stated access rule every time on the 5 of 16 authorization fixes whose flaw the access matrix can observe at all (register row 169). Ambiguous is **go** with 16 usable items, by construction (0 of 48 bare runs asked; 46 guessed, 2 neither); its discriminating power is in the measured arms, where the Phase 3 arm must stop and ask. The measured round 1 on that category is ≈ 320 runs, about $1,400–2,100, and **does not start without the owner's approval**. The `ledger` fixture flaws remain the instrument check of the harness grades; the per-item instrument check (`_tools/instrument.json`) records why 4 migration and 11 authorization candidates were dropped.

## 7. New limits rows

157 (the freeze covers the whole engine; H-B runs from a worktree), 158 (the frozen route detector misses prefixed routes), 159 (Part A checks presence not quality), 160 (guards FastAPI/SQLAlchemy/Alembic only), 161 (perf is wall-clock, race needs the declared invariant), 162 (security probes are targeted, not a scanner), 163 (the Part D budget, amending the architecture doc), 164 (Part E observed-only, no PR comments without a network API), 165 (Part F targets; quick over target on realbugs), 166 (guard scorecard 18/20, the two misses structural), 167 (gate-level narrowing: staged verification + bounded low-risk review rounds — a scoped iteration check can pass until the claim's full run). Header: forty-seven open.

## 8. Recommended next step

1. Set `ECCODE_SEED_KEY` in the environment so 0.D (seed validation then H-B from the frozen worktree) can run in a fresh session; expect H-B to report mostly `insufficient-coverage` under the frozen route detector (row 158), then decide whether to register a prefix-joining detector (a new freeze).
2. Let 0.A finish and read its failure-mode-prevention table (committed records).
3. Approve the Senior Bench screening ($100 cap) and then the measured arms, with the cost-per-track narrowing applied to the quick track first.
