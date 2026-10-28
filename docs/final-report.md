# ECCode: Final Report

**Date:** 2026-10-07 · **Branch:** `claude/keen-allen-5z33eb` · **See the [2026-10-23 addendum](#addendum-2026-10-23-the-senior-engineering-upgrade-v020--v050) for the current state; figures below describe the repository as of this report's date.**

This report sorts its claims into three groups: **Verified** (backed by tests, executed evidence or the hash-chained record), **Observed** (seen in the demo run, single sample) and **Not verified**. All figures come from the repository and its records. None are estimates unless they say so.

## 1. Deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | ECC assessment and recommendation (independent implementation, MIT attribution) | [docs/ecc-assessment.md](ecc-assessment.md), [NOTICE](../NOTICE) |
| 2 | Toolkit architecture and repository structure | [docs/architecture.md](architecture.md) |
| 3 | 12 agent definitions, 7 skills, 6 commands | `agents/`, `skills/`, `commands/` |
| 4 | Executable orchestration and review workflows | `lib/` engine + `bin/eccode.js`, `skills/orchestrate` |
| 5 | Templates for requirements, specs, plans, handoffs, reviews, lessons, proposals and progress | `templates/` |
| 6 | Installation, configuration, usage, troubleshooting | [docs/usage.md](usage.md), [README](../README.md) |
| 7 | Automated checks | `tests/` (51 tests), `scripts/validate-toolkit.js`, `claude plugin validate --strict` |
| 8 | Demonstration: web app with an AI feature through the full workflow | `examples/triage-desk/` (app + unedited `.eccode/` record) |
| 8b | Learning cycle across projects and sessions | `examples/learning-cycle/legacy-project/`, shared lessons |
| 9 | This report | `docs/final-report.md` |

## 2. Verified toolkit capabilities

`npm run check` runs the static validation of 12 agents, 7 skills and 6 commands, then **51/51 tests**. `claude plugin validate` passes `--strict` for the manifest, agents, skills and commands. The plugin installed through Claude Code 2.1.293 (`claude plugin install eccode@eccode`, isolated config dir).

| Requirement | How it is enforced | Test evidence |
|---|---|---|
| Fixed workflow order | A gate cannot start before its predecessor is approved | `tests/gates.test.js` |
| Author ≠ approver | Submitters, task claimers and completers are refused as reviewers | gates, tasks tests; guard hook test |
| Approval needs evidence | Every criterion cites a resolvable `ev:`/`artifact:`; a failed check cannot support "met" | gates test |
| Stale reviews rejected | SHA-256 of submitted artifacts is re-checked at review time | gates test |
| Reviewers inspect evidence | Phase and verification approvals need a passing check the reviewer ran after the submission | tasks test |
| Fixes verified | Approval must list every earlier blocking or major finding in `resolvedFindings` with evidence | gates test |
| Iteration limits and escalation | After `maxReviewIterations` the gate escalates with a recovery path; only `--actor user` reopens | gates test |
| Handoffs | Schema-validated with every field the brief requires; evidence ids resolve; a fresh passing check is required | tasks test |
| Ownership and isolation | Glob ownership, overlap refusal, `maxConcurrency`, git-verified changed files; `.eccode/` restricted to drafts | tasks tests, guard hook tests |
| Resume, interruption, retries | Event-sourced log, rebuild on lost snapshot or torn line, interrupted-run recovery, retry limit then escalation | resume-delivery tests |
| Budgets | Runtime and cost limits block new work; usage corrections are append-only | resume-delivery tests |
| Tamper evidence | Hash chain; snapshot equals replay; approved files unchanged at delivery | resume-delivery tests |
| Verified final handoff | `deliver` refuses unless every gate is approved and every reviewed file is unchanged | resume-delivery tests |
| Memory rules | Verification requires the same check to fail before the fix and pass after it, plus a non-author reviewer; revisions invalidate verification; supersession keeps history; env applicability; sanitized promotion | `tests/memory.test.js` |
| Self-improvement | Protected paths, grounding in verified lessons, baseline-vs-candidate evaluation, non-proposer review, user-only adoption, rollback | memory test |
| Secrets | Redaction in evidence logs and command lines; promotion scans the entire shared copy | resume-delivery, memory tests |

## 3. What the demonstration showed (observed in one run)

**Setup.** Real Claude Code subagents (Agent tool, `general-purpose` type, each loaded with its ECCode role definition) ran the TriageDesk delivery, coordinated by the main session as orchestrator. The plugin could not be hot-loaded into the already running session, so role definitions were passed in prompts. The PreToolUse guard hook was **not** active during the demo (see §5).

**Record.**
- **Volume:** 491+ events, chain intact (`eccode audit`). 172 evidence records (169 executed commands, 32 of them failing and kept on record). 45 agent runs, about 6.0M tokens, about 209 agent-minutes. Dollar cost was not reported by the harness.
- **Gate rejections that held:** every document gate was rejected once and then approved:
  - **Architecture:** 5 major findings, including a raw-schema keyword that would 400 and DNS rebinding.
  - **Design:** DES-1, the API key forwarded across a 307 redirect by `fetch`, demonstrated by probe.
  - **Plan:** a scheduling race shown by simulating the engine's own `readyTasks()`.
  - Review rejection rate 3/10. The engine refused 2 malformed reviews.
- **Implementation:** 5 phases, 17 tasks, 6 implementer roles, at most 2 concurrent claims.
  - Every task completed with a validated handoff on its first attempt; no retries were needed.
  - Every phase was approved by an independent reviewer who re-ran checks. Two reviews came from security-reviewer with adversarial probes.
- **Product:** 72 files, 439 tests passing, zero npm dependencies.
  - The full-mode eval ran **once** on the frozen holdout: **24/25 checks**.
  - It missed `high_urgency_recall` on the holdout (0.571, n=7, floor 0.70) after scoring 1.000 on tune rows. This is overfitting, recorded as RISK-12, and needs a user decision.
  - Injection leak was 0/27. Steer was 2/23 against a limit of ≤0.25.
  - Real-Chromium UI checks passed 18/18 at 360 and 1280 px, including keyboard flow, aria-live and an inert XSS payload. Screenshots are in `.eccode/artifacts/verification/`.
- **Learning cycle:**
  1. A product-architect hit a real toolkit bug (`risk update` wiped fields).
  2. learning-debugger reproduced it with a failing check, found the root cause (live state reduced from the in-memory event instead of the persisted one), fixed it, and verified the same command passing.
  3. technical-reviewer **rejected** the lesson for overclaiming its Node range. The lesson was revised, and security-reviewer verified it.
  4. Promotion exposed a second real defect: private paths leaked through evidence snapshots. It was fixed with a regression test before re-promotion.
  5. A fresh agent with no context, working in a **different project** whose record had been corrupted by the old bug, retrieved the shared lesson (score 0.828, verdict `applies`). It confirmed applicability with its own old-vs-new experiment, cited the lesson and repaired the record with `eccode rebuild`. Time to a verified fix was about 77 s, against about 10 min for the original investigation and review (median time to verified fix: 10.1 min).
- **Outdated or irrelevant lessons rejected:**
  - A seeded but true Node <18 `fetch` lesson was reported `does-not-apply` on Node 22 by every agent that met it. This happened naturally, during the first architect's search.
  - The verified lesson rejected itself under a simulated Node 18 environment.
- **Controlled self-improvement:**
  - Two reviews refused for `"decision": "approved"` were turned into a workflow lesson, then a proposal against `skills/review-gate/SKILL.md`.
  - The candidate scored 7/7 against a 4/7 baseline. The eval cases were mutation-tested by the reviewer.
  - It was approved by an independent reviewer and **adopted by the user** as v1, with a rollback path. The post-adoption eval passed.

**Verification gate outcome.**
1. The first verification review was **changes_requested**, with blocking finding VER-1: approved Success Criterion 2 (the holdout floor) was not met. `eccode deliver` refused with exit code 2.
2. The orchestrator asked the user. On 2026-10-08 the user **accepted RISK-12** (amending SC2/AC8 for this release only), confirmed the defaults, and **adopted** the review-gate improvement. These were recorded as `--actor user` events 520–522. The orchestrator transcribed them from the user's answers; the CLI cannot prove a human typed them (VER-2, see §5.1).
3. The delivery-lead cited the decision without changing any result. security-reviewer then verified that the decision events are in the chain, that the results are unchanged against the original eval log, that `npm test` passes 439/439, and that the frozen hashes are intact. They **approved** the verification gate.
4. `eccode audit` passed with 536 events and approved artifacts unchanged. `eccode deliver` then produced the **verified final handoff**, [`examples/triage-desk/.eccode/delivery/final-handoff.md`](../examples/triage-desk/.eccode/delivery/final-handoff.md).
5. Final totals: 9/9 gates approved, of which **4 were rejected once first**. 13 reviews were recorded and **5 were refused by gate rules**. 17/17 tasks were done, over about 219 agent-minutes and about 6.5M tokens.

**Toolkit defects found and fixed during the demo** (each with a reproduction test first):

| Defect | Found by |
|---|---|
| Snapshot/replay divergence (`Store.commit`) | product-architect symptom, learning-debugger root cause |
| Shared-memory promotion leaked paths via evidence snapshots | orchestrator verifying the first real promotion |
| `.eccode/**` ownership hole: tasks could edit pinned check scripts or approved artifacts | plan reviewer (PLAN-2) |
| CLI dropped argument quoting in `evidence run` and `improve evaluate` | delivery-lead, after several agents had blamed themselves |
| Nested-project git paths mis-scoped | orchestrator, before the demo |
| Secrets on the command line not redacted | test suite |
| Privacy-scan false positive and trust-blind ranking | test suite |

## 4. Metrics (`eccode metrics`, TriageDesk record)

| Metric | Value | Note |
|---|---|---|
| Review rejection rate | 4/13 | First drafts of the three document gates, plus the first verification |
| Reviews refused by gate rules | 5 | 2× malformed `decision` value, 3× a "met" criterion citing the failed eval run |
| Repeated-bug fingerprints | 0/1 | Single-project sample |
| Median time to verified fix | 10.1 min | n=1 |
| Recurrence after fix | 0 | The legacy-project case was pre-fix data, not a recurrence |
| Applicability checks | 66 applies / 22 does-not-apply / 7 provisional | "Applies" means the environment matches, not that the lesson is relevant; agents judged relevance themselves |
| Workflow changes adopted / regressions | 1 / 0 | Review-gate skill v1, adopted by the user; post-adoption eval passed |

Sample sizes are small. These are observations from one delivery, not trends.

## 5. Limitations (honest)

1. **Identity is asserted.** `--actor` is bound to the real subagent only when the PreToolUse guard hook runs. The hook is tested with simulated payloads, but it was not active during the demo. Without the hook, a caller can claim any role; the record makes that visible but does not prevent it.
2. **Live AI path is unverified.** There is no Anthropic API key, so no live model call was made. Live evals report NOT RUN, and RISK-7 (API shape drift) stays open. Fallback results are pipeline evidence, not model quality.
3. **Post-approval fixes.** The engine has no hotfix path for files owned by an already-approved phase. Twice (RISK-10, RISK-11) a fix had to go into a later call site or into documentation. A scoped "hotfix task" plus re-review would close this gap.
4. **Cost** is tracked in tokens only. The harness does not report dollars; set `pricing.usdPerMillionTokens` for estimates. The orchestrator three times closed a run before usage arrived. This was corrected via append-only `run correct` and logged as a provisional lesson, not yet reviewed.
5. **Retrieval** is lexical (BM25 + trigram) unless `memory.embedCommand` is configured.
6. **Confounded measurement.** The orchestrator's later dispatch prompts named the exact `"approve"` literal, so a lower rate of decision-literal refusals after the docs change could not be credited to the improvement.
7. **Mid-task commits.** The orchestrator's periodic commits sometimes captured implementers' in-progress files. Completion checks still passed, and the final reviewed content is what the gates recorded.
8. **One-run evidence.** Gate effectiveness was demonstrated on one delivery. Reviewer quality varies, and the engine guarantees independence and evidence, not judgment.

## 6. Remaining work

- **Fallback rules revision (VER-3):** the fallback's high-urgency recall (0.571) and its held-out-family injection recall (0.444) are accepted for this release. Improving them needs a rules revision validated on a **fresh**, unseen holdout.
- A hotfix task type, so approved-phase files can be changed under re-review. That would clear RISK-10's schema-level gate and RISK-11's `exec` in package.json.
- Make `run end` require usage figures, as the provisional lesson recommends.
- Run the guard hook live in a plugin-installed session, and run the live-model evals with a key.
- Mirror agents to Codex and Gemini natively. Today `export agents-md` gives sequential, disclosed role execution only.

## Addendum 2026-10-23: the senior-engineering upgrade (v0.2.0 → v0.5.0)

Seven merged PRs (#1–#7) since this report. The suite is now **117 tests**, green in CI on Node 18/20/22 × Linux, macOS, Windows. Same claim discipline as above: every figure here is recomputable from the repository.

**Verified (tests + CI + the hash-chained record):**

- **Lean discipline** (`docs/lean.md`): claim-time baselines of dependencies and `shortcut:` markers; completion refused for undeclared dependencies, markers, or code without a test (or a ≥10-char `testsNotNeeded`). Levels off/lite/full/strict.
- **Nine trust gaps closed**, the last structurally: `eccode mcp --actor <role>` serves the engine as typed tools to no-Bash agents (`docs/mcp.md`). Guard hardening includes write-time shell ownership, env/flag identity rules, `audit --against <ref>`, and a session-start upstream anchor. A seeded fuzz battery (240 generated attacks denied, 120 legitimate commands allowed) runs in every CI job.
- **Codebase intelligence**: 8-language import-resolved index (`onboard`, `impact`, `map`, `debt`) plus runtime tracing — dynamic `require`, ESM static/dynamic `import` (via `module.register`), Python `importlib`, Ruby `require`/autoload, PHP includes and autoloads, and JVM class loads (Java and Kotlin) observed and merged into impact reports. With codebase-memory-mcp installed, `impact --calls` adds function-level callers from its resolved call graph.
- **Work items and tracks**: many deliveries per record (greenfield/feature/refactor/fix/quick), per-track gate order; a 25-work-item seeded endurance test audits a 300+ event record.
- **Compatibility safety**: claim-time public-surface baselines; undeclared breaking changes refused at completion; refactor track refuses them outright; applied-migration edits and destructive SQL refused.
- **Bugs and problem solving** (`docs/bugs.md`): `eccode bugs` flags slips on the lines a change adds and runs installed analyzers (ruff, go vet, eslint, semgrep); completion refuses undeclared errors. Rules are calibrated on 4.6M lines of real code, with 2 error hits on 2.29M held-out lines, both intentional debugger hooks. `eccode mutate` runs mutation testing on the changed lines; `eccode fix verify` proves a regression test fails on the pre-fix code and passes on the fix. The debugging skill teaches the method from reproduction to a reviewed lesson.
- **Stack packs**: detection, runnable checks, a built-in secrets scan, `stack adopt` making checks required at verification.

**Measured (recorded benchmark runs; recompute with `eccode bench tally`):** 622 live agent runs across 12 tasks, 3 languages, 2 models; 1244/1244 hidden checks passed; 0 dependency additions; 0 agent failures. Every built-in task has an n≥10-per-variant batch on each model; on Haiku the two headline tasks also have a fixed-protocol n=25 batch. Stratified permutation per model (labels shuffled within task-batches, seeded): on Haiku the with-skill variant adds on average **5.37 fewer lines per change on Haiku**, two-sided p ≤ 5.0e-5; on Sonnet a pre-registered n=10 batch shows the opposite, **+3.00 lines per change in the pre-registered Sonnet batch** (p = 1.0e-4), while runs writing tests rose from 45/80 to 80/80 with the skill. A second pre-registered Sonnet batch on four new tasks, counting test lines apart, shows what those lines are: **−1.27 code lines per change in the pre-registered follow-up** (tests excluded, p ≤ 5.0e-5). The skill buys test discipline on both models and smaller code on both; total diffs shrink only where the model already writes tests (Haiku). Per-batch results vary and are all recorded, including non-significant batches, one null and the Sonnet total-lines reversal (row 36 of [limits.md](limits.md), closed by design).

**Observed live (headless sessions; twenty-one transcripts in [docs/live/](live/), the rest described in senior-engineering.md):** guard denial of record writes; a full no-Bash MCP cycle; a subagent adversarial battery; the `--actor user` ask held for human confirmation with a clean record; `onboard`/`impact --trace` answered correctly in an unfamiliar project (and exposed a real indexing defect, fixed with a regression test); the compat ladder — undeclared export removal refused, mis-named declaration refused, exactly-named declaration accepted; a second work item opened on a delivered record with the detected stack check green; one dedicated session per original red/orange row (docs/live/); one runtime-trace session per traced language (Python, Ruby, PHP, Java, Kotlin), each finding a loader edge static analysis cannot see; function-level callers through codebase-memory-mcp; the migration ladder (applied-migration edit and destructive SQL refused, additive migration accepted); the refactor track both ways (verification refused without a recorded behavior baseline, accepted with one); the benchmark harness running a real model; and problem solving end to end (a bug report reproduced, fixed at the root and proven with `fix verify`, a weak test suite strengthened from 33% to 100% mutation score, seven planted slips found by `bugs` and fixed).

**Independent audit (2026-10-23):** a fresh reviewer checked every limit against the code and found real defects, including a general shell in MCP `evidence_run` and identity bypasses through shell quoting. All are fixed with mutation-checked regression tests. The three limits left open after that audit were then closed: the sandboxed profile (`eccode install --sandbox`) makes the record read-only to every shell command at the OS level (live-verified); an integrity window around every evidence command reverts record changes and fails runs that touch tracked files outside the caller's claim; and runtime tracers now cover Java, Kotlin, Ruby and PHP. The last open limit (projects without a sandbox relying on the textual guard) closed when installs became enforced by default. That means the OS sandbox where Claude Code has one, otherwise a no-shell profile in which permission rules deny every shell tool, which also holds on native Windows (live-verified). No limit in [limits.md](limits.md) is open. The last one, row 36 (on Sonnet the lean-change skill makes total diffs larger), closed by design under a pre-registered follow-up: the extra lines are tests, and the code itself is smaller.


## Addendum 2026-10-24: planned capability completed (v0.10.0)

The evaluation of v0.9.0 named four planned capabilities that were missing and one question no run had answered. All four are built, tested and documented, and the question has a measured answer. The suite is 198 tests.

**Built:**
- **One-step path** (`eccode quick`, `/eccode:quick`, `handoff draft`): one command sets up a reviewed quick change from the repository. Live session: docs/live/22-quick-track-engine.txt.
- **Cost per track** (`eccode metrics`): runs, tokens, cost, review rounds and wall time per work item and per track. This fixed run accounting from the main session, which the guard had always refused.
- **Engine benchmark** (`bench --variant engine`, suite `bench/suites/engine`): the whole engine in the loop on multi-file tasks with regression traps.
- **Impact at scale**, measured on the Python standard library: Lib/-layout imports resolve (dependents of os.py 127 → 360), affected tests exclude test support (44 → 2), modules and dependents are ranked.

**Measured (pre-registered):**
- 80 runs on two models compared agents with and without the engine.
- Every run passed every hidden check except one engine run that stopped before any edit. The bare agents made none of the mistakes the traps invite, so the comparison had no room to show a gain (register row 59, open).
- The reviewed, recorded path cost 3.4× (Sonnet) to 5.0× (Opus) the median cost of a bare run. Engine runs wrote tests more often.

**Found by measuring:**
- The batches' transcripts exposed defects that kept correct changes from delivering: an ownership typo with no recovery, a delivery refused by its own run, a CLI shorthand the guard refuses, reviewers that never recorded, and test caches counted as changes (rows 54–57).
- After the fixes, two pre-registered follow-ups delivered 16/20 and then 19/20, every audit clean.

The open question, whether the engine improves correctness where bare agents do fail, needs a harder suite run through the same harness.

## Addendum 2026-10-24: real bugs and the debug track (v0.11.0)

Two steps followed the v0.10.0 evaluation: a benchmark on real bugs, and a lighter debug mode. Both are built, tested and measured. The suite is 214 tests.

**Built:**
- **Debug track** (`eccode debug`, `/eccode:debug`), the lighter mode for one bug:
  - one task, whose phase is the track's only gate;
  - the phase is submitted only after `fix verify` has proven the regression test and a mutation run is recorded;
  - one independent review; the orchestrator delivers.
- **Real-bug suite** (`bench/suites/realbugs`): twenty BugsInPy bugs in youtube-dl, black, tornado, thefuck and tqdm.
  - Each task is the project at its pre-fix commit, without history, with a hand-written bug report. The fix's own tests are the hidden checks.
  - CI validates every task live.
- **Benchmark variants:** `debug` (the debug track) and `method` (the debugging method as text, nothing installed).

**Measured (pre-registered, 240 runs, Sonnet):**
- **Real bugs, Sonnet:** passing both hidden checks: 57/60 without, 57/60 with the method text, 56/60 on the debug track and 57/60 on the quick track (Holm-corrected stratified tests, p = 1.0); median cost per run $0.13, $0.19, $0.44 and $0.49.
- The bare model fixed every bug (bug check 60/60), so correctness had no room to improve again (row 59, open).
- What the process changed is the proof:
  - tests written in 60/60 debug-track runs, against 21/60 bare;
  - every debug-track regression test proven to fail before the fix and pass after;
  - review findings, in four runs, that the projects' tests do not cover.
- The debug track missed its rule as the lighter mode: 0.91× the quick track's cost, not 0.6× or less (row 69).

**Found by measuring (rows 60–71):**
- Engine defects, each fixed and tested:
  - `fix verify`, `mutate` and `bugs --task` lost the task's base after completion;
  - a pinned check could not be corrected on a one-task track;
  - grammar caches counted as changes;
  - a Windows export rewrote line endings.
- Benchmark defects:
  - two bug reports gave a test command that collects nothing, or were silent on failures that already exist;
  - a temporary directory too long for Unix sockets;
  - benchmark agents writing outside their sandbox.
- Each is disclosed in the protocol's amendments or the register.

## Addendum 2026-10-24: a real project (v0.12.0)

Every earlier batch ran on fixtures, sandboxes or small slices of projects. This step ran every capability on one large, living codebase ECCode's authors did not write: Mealie, a FastAPI and Nuxt app, pinned at v3.20.0, with a window of 410 commits ([protocol](../bench/protocols/2026-10-24-mealie-pilot.md); [report](../bench/pilot-results/2026-10-24-mealie-pilot.md)).

**Measured, as registered:**
- **Model-free capabilities (Part A):** 10 criteria met, 6 missed, 1 with no verdict. In the after-fix run:
  - TS/JS import resolution went from 0.376 to 0.998;
  - breaking-change precision went from 0.087 to 1.0 on two detections;
  - bug-rule false positives went from 4.5 to 0 per 10,000 changed lines.

  But impact selects 80–90% of the suite for any module the app imports, so its share criterion depends on the sample (row 74). After the fixes, `fix verify` agreed with the direct runs (1.0, from 0.974). Stack detection found both stacks, and its checks matched the tools. `mutate` still gets no mutant on 16 of 41 real fixes (row 78).
- **The engine at the protocol commit (Parts B and C):**
  - 6 of 20 Mealie work items delivered with a clean audit, against a rule of 80% per chain; no record failed its audit;
  - 1.79 false refusals per item, against at most 1;
  - no lesson recorded;
  - the MCP item delivered in 0 of 2 runs;
  - neither greenfield chain delivered all three requests.
- **Correctness (no criterion):** the bare agent passed every hidden check in 17 of 20 Mealie runs, the engine in 13 of 20 (p = 0.12).
- **Cost:** the batch cost $62.97 of its $250 ceiling.

**Found and fixed (rows 72–108):**
- Every false refusal maps to a row. 47 of the 50 trace to defects fixed since, each with a test that failed first:
  - the integrity window erased other agents' events, and blamed a teammate's edits on a check;
  - role agents had no MCP tools, MCP calls timed out at 60 s, and MCP could not narrow a check or deliver;
  - the guard misread shell forms, and a final review found holes and regressions in those fixes;
  - reviews could not cite approved artifacts or a failed reproduction;
  - a rework stranded its work item, and a gate closed on its first reviewer while a second was finding an SSRF bypass;
  - a refactor work item could start without a behaviour command.
- The benchmark harness now gives each agent a clean environment and stops whatever it leaves running.

**Not shown:** whether the fixed engine meets the criteria. That needs the same protocol run again at the fix commit.

## Addendum 2026-10-26: the rerun at the fix commit (v0.13.0)

The pilot's protocol was run again with the fixed engine, on fresh items ([protocol](../bench/protocols/2026-10-25-mealie-rerun.md); [report](../bench/pilot-results/2026-10-25-mealie-rerun.md)):
- ten new Mealie changes from v3.27.0..v3.29.0;
- a new three-request greenfield service.

The criteria were unchanged. Since the pilot, a fix or debug item records a lesson, and the benchmark's tool list gained read-only shell commands.

**Measured, as registered.** A container restart cut the last four items of each Mealie chain. They count as failures in the primary reading, and a continued reading is reported beside it.
- **Met:**
  - false refusals, 0.64 per engine item (pilot 1.79);
  - a lesson recorded and later surfaced, in both chains;
  - the no-shell item, 2 of 2;
  - no record failing its audit.
- **Missed:**
  - delivery: 7 of 20 Mealie items (11 of 20 when the chains continued), against 80% per chain;
  - the greenfield criterion in both chains. Chain 1 met every condition except one the harness's patch cap left unverifiable.
- **Correctness (no criterion):** among the Mealie runs that finished, the engine missed one hidden check in 18 runs, and the bare agent none in 19.
- **Cost:** $48.57 of its $145 ceiling.

**Found and fixed (rows 109–130):**
- a gate that could be neither reviewed nor resubmitted after its artifact changed;
- the refactor baseline checked only at verification;
- an evidence timeout that left the tests running;
- six guard misreads;
- deleting git-ignored artifacts refused by ownership;
- an identity gap no run used: `ECCODE_ACTOR` set inside a main-session command;
- found by an independent review of those fixes: a check that outlived a killed eccode process, and two read-only tools that write files (`sort -o`, `uniq`);
- found by its Part A:
  - `mutate` leaving a timed-out mutant's tests running, and `stack run` reporting a timed-out check as a failure;
  - compat reading a deleted dev script's definitions as API, and missing routes on routers with other names;
  - four measurement instruments that could not see what they measured. The route table saw none of Mealie's API routes, in the pilot too, so route recall had never been measured.

Each has a test that failed first. Six limits are named, among them that the recorded lessons were shown to later agents but never used (row 119), a rework deadlock (row 120), and migration edits reported whatever they change (row 126).

**Part A** ([report](../bench/pilot-results/2026-10-25-mealie-rerun-part-a.md)): 14 of 17 criteria met as measured, on history none of the fixes saw. Missed: impact's share of the suite and compat precision (0.571; 0.80 after the fix).

**Not shown:** that the engine raises correctness where bare agents fail, or that the fixes made after this run raise delivery.

## Addendum 2026-10-26: the proof run (v0.14.0)

A pre-registered run looked for the bare agent's mistakes on purpose, to measure whether the engine catches them ([protocol](../bench/protocols/2026-10-26-mealie-proof.md); [report](../bench/pilot-results/2026-10-26-mealie-proof.md)). It took every eligible change of Mealie history newer than any ECCode fix: 19 items, each run twice bare and twice through the engine.

**Measured, as registered:**
- **Primary: no verdict.** The bare agent passed every hidden check in 36 of 38 runs, the engine in 36 of 38. All four failures are one frontend test on item 19 whose DOM event the request does not name (`spec-gap`), so no item was hard and the comparison could not run.
- **Delivery: met.** 38 of 38 engine runs delivered with a clean audit, against 80% (row 104, closed for single items).
- **Friction: met.** 0.08 false refusals per engine run.
- **Cost:** $61.30, against a $250 budget; stage 2 spent nothing.

**Reported, no criterion:** every engine run left tests (bare 13 of 38), and every fix-track run a proven regression test and a lesson. Checked after the fact: 37 of 38 engine patches and 30 of 38 bare patches would pass Mealie's lint and format CI step on the files they touch. Each engine run cost a median 10.8× a bare run's.

**Found and fixed (rows 131–133):** a verification report name Claude Code refuses to subagents, a lesson draft that hid the shape of a failed attempt, and `fix verify` calling a reproduction inconclusive when only some of its tests needed new API.

**Not shown:** that the engine raises correctness where a bare agent errs. On 19 changes of a well-tested project, this model made no such error.

## Addendum 2026-10-27: the multi-file run (v0.15.0)

A pre-registered run asked the proof run's question on large changes ([protocol](../bench/protocols/2026-10-27-mealie-multifile.md); [report](../bench/pilot-results/2026-10-27-mealie-multifile.md)). It took the 16 largest eligible changes of Mealie's recent history, 121 to 1,355 changed lines in 6 to 30 files. Stage 1 ran each three times bare; stage 2 ran 6 bare and 6 engine runs on each hard item.

**Measured, as registered:**
- **Hard items: three.** The bare agent passed 40 of 48 stage-1 runs. Its own mistakes made items 01, 05 and 07 hard; item 03's two failures were gaps in its request. A container restart in stage 1 left only item 01 hard in the registered reading, which has no verdict (amendment 1).
- **Primary: missed.** Engine 12 of 18, bare 9 of 18 on the hard items in stage 2; difference 0.167, p = 0.50.
  - Item 01: engine 4/6, bare 1/6.
  - Item 05: engine 6/6, bare 3/6.
  - Item 07: engine 2/6, bare 5/6. Four engine runs reached the 7,200 s timeout, which counts as a failure.
- **Delivery: missed.** 9 of 18 stage-2 engine runs delivered with a clean audit, against 80% (row 138, open).
- **Friction: met.** 0.17 false refusals per engine run.
- **Cost:** about $97 with four timed-out runs estimated, against a $310 budget.

**Reported, no criterion:**
- Graded on a clean tree with the timeout rule set aside, 17 of 18 engine patches pass, against 9 of 18 bare (post hoc).
- The engine's one failing patch there repeats the bare agent's naming mistake, past five reviews.
- Mealie's lint gate showed no difference here: 12 of 18 engine and 11 of 18 bare patches pass.
- A median engine run cost 7.7× a bare run's and took 48.5 minutes against 6.3.

**Found:** rows 134–138.
- Fixed, each with a test that failed first:
  - a record lock that timed out the moment a check ended (row 134);
  - a gate that refused an empty changed file (row 135).
- `ps` was added to the guard's read-only list (row 91).
- Mitigated:
  - hidden checks that read a stale test database the agent had left (row 136). This is fixed for single runs and source-backed chains, but not in greenfield chains.
  - a timed-out run's cost is unknown to the cost ceiling (row 137).
- Named: delivery on large changes (row 138).
- The run's own analysis counted a timed-out run by its hidden checks; it was fixed before any figure was reported.

**Not shown:** that the engine raises correctness on large changes. It fixed the bare agent's mistakes on two of three items, but timed out on the third, and the registered test missed.

## Addendum 2026-10-28: the delivery run (v0.16.0)

A pre-registered run asked whether large changes deliver once the multi-file run's stops are removed ([protocol](../bench/protocols/2026-10-27-mealie-delivery.md); [report](../bench/pilot-results/2026-10-27-mealie-delivery.md)).
- **The changes:** the engine gained a reviewed rescope, a 30-minute evidence default and checks sized to the step. The harness gained Mealie's dev environment, `rm` of its test temp directory and a 4-hour limit.
- **The runs:** all 16 mealie4 items, twice through the engine and twice bare. Three container restarts and an expired credential cut runs; each was run again under an amendment committed first.

**Measured, as registered:**
- **Primary: missed, by one run.** 25 of 32 planned engine runs delivered with a clean audit in the continued reading (78%, rule 80%). The other readings:
  - 24 of 32 with the credential-cut run kept;
  - 3 of 32 in the registered reading, the batch as the first restart left it.
- **Friction: met.** 0.06 false refusals per engine run.
- **Cost:** $136.88 recorded, against a $210 ceiling.

**Reported, no criterion:**
- No run timed out. The three in-sample items delivered 6 of 6, and the out-of-sample items 19 of 26.
- Within 2 hours, 22 of 32 delivered.
- Hidden checks: engine 29 of 32, bare 28 of 32 (p = 1.0).
- A median engine run cost 8.1× a bare run's and took 53.3 minutes against 5.6.

**Found:** rows 139–144.
- **Why runs did not deliver.** All seven stopped to ask a user, and five of their changes pass every hidden check:
  - Mealie's code generator formats the whole project, Markdown included, and so rewrote approved design files. An engineer's whole-package format did the same. An approved gate could not be reviewed again, and no run restored the file (row 140; row 141; both mitigated).
  - The code generator went unrun after its `uv run` wrapper was refused, as in the multi-file run, though the plain `python` command was allowed (row 142, mitigated).
  - Item 14's planned file moves were refused (row 143, mitigated).
- **Fixed, each with a test that failed first:**
  - a guard false refusal on `sed -n` under a path holding `-i` (row 139);
  - re-review of an approved gate whose files changed (row 140, mitigated: two gaps remain).
- **Mitigated:** an agent's leftover processes in sessions of their own are stopped on Linux (row 144).
- **The final review** found a guard regression in the first `sed` fix, a missing state-version bump, two gaps in the re-review, and guidance that led to a refused completion. All are fixed, with tests that failed first; nine minor findings are deferred and listed in the report.

**Not shown:** that large changes deliver under the rule. The fixes for this run's stops are not measured, and row 138 stays open.
