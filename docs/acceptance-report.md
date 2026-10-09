# Acceptance report: ECC Senior Web & AI Engineering Team

**Verdict: not accepted.** Requirement 7 (measured improvement over the original ECC) **failed**, and requirement 4 is only partly met: the demonstration application works and was verified independently, but its delivery through the toolkit's own final gate was not closed. Requirements 1, 2, 3, 5 and 6 are met, with the limits stated below. Every status is backed by a file in this repository; where evidence is thin it says so.

Date: 2026-10-09. Branch `claude/brave-bardeen-6y5ng9`. Models: `claude-sonnet-5-5` for every session in the evaluation and demonstrations. "Enhanced ECC" is **ECCode**, an independent implementation inspired by ECC ([docs/ecc-assessment.md](ecc-assessment.md)); the comparison baseline is the original ECC (`affaan-m/ECC` at `ef648e01`), unmodified apart from model pins normalised to `inherit` in both toolkits.

| # | Requirement | Status |
|---|---|---|
| 1 | Installation and one entry point, configurable limits | **Passed** |
| 2 | Agent collaboration: roles, recorded execution, handoffs, decisions, integration | **Passed** |
| 3 | Review gates: acceptance criteria, independence, evidence, blocking findings resolved first | **Passed**, reviewer judgement not guaranteed |
| 4a | Working web + AI application meeting the agreed criteria D1–D9 | **Passed**, with one cosmetic defect |
| 4b | That application delivered through the final gate, no known blocking defects (D10) | **Failed** (delivery gate escalated, audit failing, human decisions pending) |
| 5 | Persistent memory and resume from a fresh session; separate project memories | **Passed** |
| 6 | Verified learning: reviewed lesson, reuse in a fresh session, rejection when the cause differs, versioned and reversible promotion | **Passed**, within the limits below |
| 7 | Measured improvement against original ECC with predeclared targets | **Failed** |
| FA | Deliverables, all mandatory requirements passed | **Not met** (4b and 7) |

## 1. Installation: Passed
- `scripts/verify-install.js --live` follows [docs/usage.md](usage.md) in a throwaway HOME and Claude config directory: documented marketplace install (method A) and project-local copy (method B), `claude plugin validate --strict`, the installed plugin loads **12 agents, 7 skills, 7 commands**, `eccode init` and `status` from the installed copy, memory initialised, **limits configurable and enforced** (concurrency, cost, runtime, retries; the check drives a real `BUDGET_EXCEEDED`), and a headless `/eccode:status` shows the record through the SessionStart hook. Output: [docs/evidence/install/verify-install.txt](evidence/install/verify-install.txt) (all steps PASS).
- The same install, inside the evaluation sandbox, started the Groundwork delivery with the single entry point `/eccode:start` ([install.json](evidence/install/groundwork-sandbox-install.json)); the limits were set in `.eccode/config.json` before `init`.
- Limit: verified with Claude Code 2.1.29x on Linux only.

## 2. Agent collaboration: Passed
- Distinct roles with enforced separation: product-architect, architecture-reviewer, technical-designer, technical-reviewer, delivery-lead, learning-debugger, security-reviewer and frontend / backend / ai / test / devops engineers ([agents/](../agents)).
- **What actually ran** is in the record, not in a summary: the Groundwork record ([examples/groundwork/.eccode](../examples/groundwork/.eccode), 606 events) holds 71 agent runs by 12 roles, 16 owned tasks, 23 schema-validated handoffs (inputs, outputs, evidence, remaining issues), 261 evidence records (55 failing commands kept), recorded decisions, risks and findings, and phase gates that integrate the work. [Evidence README](evidence/groundwork/README.md) has the statistics and the session history.
- Limits: usage figures for runs are reported by the orchestrator, not measured by the engine; `--actor` is tied to the real subagent by the PreToolUse hook, which was active in the plugin-installed Groundwork run but not in the earlier TriageDesk demonstration.

## 3. Review gates: Passed (mechanics proven; judgement is not guaranteed)
- Enforced in code and covered by tests (136): author ≠ approver, approvals need resolvable evidence, stale artifacts rejected by hash, implementation approvals need a check the reviewer ran, earlier findings must be resolved with evidence, gate order, escalation after N rejections, user-only reopen.
- **Deliberate defects, blind reviewers** ([docs/evidence/gate-challenge](evidence/gate-challenge/README.md)): an incomplete design and a defective implementation were submitted. Each of the four gates was rejected once, corrected by a fresh author session, and re-approved by a fresh reviewer session; five engine probes were all refused. Design review found 4/4 planted defects; implementation review found the 2 security-critical ones with live probes and **missed** input validation (partly) and test coverage of isolation (fully). One escalation run is kept as evidence of the iteration limit.
- In Groundwork, independent reviewers requested changes 13 times and the engine refused 34 review attempts by its own rules. They caught real defects (a cap guard that never fired, documentation understating the number of evaluation runs, a release approved without the planned technical review).
- Limit: the engine guarantees independence and evidence, not the quality of a reviewer's judgement. Two rounds of the evaluation showed reviewers approving an implementer's wrong reason for setting a house rule aside; toolkit v2 now forces them to judge those decisions, which fixed that failure in round 2 but is itself only as good as the reviewer.

## 4. Working application
### 4a. Passed: Groundwork, requirements D1–D9 of the scope agreed before building ([demo-scope.md](build/demo-scope.md))
Verified by me, independently, in a clean clone following only the app's README ([independent-verification/](evidence/groundwork/independent-verification)): `npm test` **285/285**, real-Chromium journey at 360 px and 1280 px **28/28** (keyboard flow, no console errors), live `claude -p` provider tests **4/4**, verifier and fallback evaluations PASS. Responsive UI, JSON API with one error envelope, SQLite with migrations and restart persistence, three AI providers behind one adapter with deterministic grounding verification, scrypt passwords, HttpOnly SameSite cookies, CSRF, rate limiting, role and team scoping with cross-team 404 tests, audit log. Per-criterion table: [evidence README](evidence/groundwork/README.md).
- **AI evaluation thresholds (D8) were fixed before implementation and never moved.** Two holdouts failed M1c (3.07 %, then 2.50 % against 2 %); after improving the verifier with those retired holdouts as tune data, a third fresh sealed holdout passed on both providers (CLI M1 90.6 %, M1c 0.23 %, M2 98.75 %, M3 100 %, M4 10/10). Only the third result is unbiased; the second and third attempts were authorised by me as operator, not by a human product owner.
- Open defect: a stray `null` is rendered under the incident title and under "Draft review" (cosmetic).

### 4b. Failed: delivery through the final gate, "no known blocking defects"
`eccode deliver` was never run. Twelve gates are approved; `verification` escalated after three review rounds because four findings need a named human: V1 and V2 (the extra holdout runs and the tune-run overrun were authorised by the operator, which the reviewers rightly did not accept), V3 (the release gate has no technical review although the plan asked for one) and V4 (open high risks have only proposed dispositions). `eccode audit` also fails on this record because retiring the first holdout deleted pinned files without the rework listing them: a toolkit defect, fixed afterwards in the engine but **not repaired in this record**. Nine risks are rated high and open. See "Open items" in the [evidence README](evidence/groundwork/README.md).

## 5. Persistent memory and resume: Passed
- **Interrupt and resume** ([docs/evidence/resume-demo](evidence/resume-demo/README.md)): a real delivery was killed (SIGKILL of the process group) with a task claimed and partial work on disk; a new session with a new id and no history ran `/eccode:resume`, which reconciled the record against the working tree (`eccode reconcile --verify` re-runs recorded checks), recovered the interrupted run, re-claimed the task with the partial file recorded as already dirty, finished, and delivered; hidden grader 5/5, no regressions, `eccode audit` OK (re-checkable from the evidence folder).
- Groundwork: 24 sessions across a SIGKILL and a total change of process each time, continuing from the record alone ([session history](evidence/groundwork/README.md)).
- Memory preserves requirements, decisions, tasks, reviews and lessons; project memory never leaves its project and only verified, scrubbed lessons reach shared memory (tests in `tests/memory.test.js`, `tests/promotion-scrub.test.js`; cross-project reuse in `examples/learning-cycle/`).
- Limit: reconciliation catches changes to approved artifacts and recorded checks; it cannot know about work that was never recorded.

## 6. Verified learning: Passed, within limits
- **Independently reviewed lessons with full records** (symptom, environment, root cause, failed attempts, sources, verified fix, applicability limits): four organisational lessons from the evaluation's training phase and one debugging lesson ([learning-round1](evidence/learning-round1/README.md), [debug-lesson](evidence/debug-lesson/README.md)). A lesson is "verified" only if the same check failed before and passes after the fix and a reviewer who is not the author signs.
- **Applied in fresh sessions**: in the official evaluation the lessons were retrieved at the claim (round 1) and at the plan and the claim (round 2) in every holdout trial; round 2 passed 48/48 organisational-rule checks against 6/48 without learning ([learning-round2](evidence/learning-round2/README.md)). The debugging lesson was incorporated and applied on a different service.
- **Rejected when the cause differs**: on a debugging decoy (stale and corrupted cached costs whose causes were missing invalidation and in-place mutation, not cache keys) the lesson was set aside at the plan and again at the claim by naming the "not applicable when" condition that holds, and the real causes were fixed. CSV and read-only decoys were also set aside correctly in every trial.
- **Promotion into skills or workflows is versioned, evaluated and reversible** ([self-improvement](evidence/self-improvement/README.md)): a proposal grounded in four verified lessons, baseline 0/4 against candidate 4/4, self-approval refused, independent approval by a fresh reviewer session, orchestrator adoption refused, adoption as v1, **byte-for-byte rollback**.
- Limits, plainly: the adoption and rollback decisions were run by the operator script as `--actor user` (the CLI cannot prove a human typed them); the workflow evaluation measures coverage of the cited rules, not review quality; retrieval is lexical; the evaluation's lessons are organisational rules, and only one debugging lesson was demonstrated; the evaluation's own "debugging decoy" H5 turned out not to be a clean decoy (its reference fix includes a key normalisation), so the clean one is a round-2 task. In round 1 a defect was found in the learning mechanism itself (applicable rules set aside with a plausible reason and approved): it cost three trials, and was fixed before round 2.

## 7. Measured improvement: Failed
Targets were committed before any holdout trial ([eval/suite/targets.json](../eval/suite/targets.json)); a second round on new tasks was preregistered ([round2-protocol.md](../eval/suite/round2-protocol.md)). Conditions: **C0** original ECC with its own `/learn` route, **C1** ECCode with learning off, **C2** ECCode with verified learning; same model, tools, limits and prompts; same prior experience (QA feedback on six training tasks); 6 unseen tasks × 3 repeats per round; hidden graders.

| Target | Round 1 (toolkit v1, 54 valid trials) | Round 2 (toolkit v2, new mid-sized tasks) |
|---|---|---|
| L1 learning raises org-rule compliance ≥ 40 pp | met (83 % vs 40 %) | met (100 % vs 12.5 %) |
| L2 learning halves repeated mistakes | met (3 vs 9) | met (0 vs 12) |
| L3 learning raises success on related tasks ≥ 25 pp | met (75 % vs 25 %) | met (41.7 % vs 0 %) |
| L4 no harm when a lesson must be rejected | met (6/6 vs 6/6) | met (6/6 vs 6/6) |
| L5 learning cost ≤ 1.5× | met ($1.18 vs $0.99) | met ($1.29 vs $1.05) |
| **E1 enhanced with learning beats original ECC by ≥ 20 pp success** | **not met: 83.3 % vs 100 %** | **not met: 61.1 % vs 61.1 %** |
| E2 no more regressions than original ECC | met (0 vs 0) | met (0 vs 1) |
| E3 no more human intervention than original ECC | met (0 vs 0) | **not met (1 vs 0)** |
| E4 cost per success ≤ 3× original ECC | **not met: $1.30 vs $0.28 (4.6×)** | met, narrowly ($1.90 vs $0.66, 2.9×) |

**Honest reading.** Inside ECCode, verified learning clearly works (L1–L5, in both rounds). Compared with the original ECC it does **not**: the original, using its own learning route, solved the round-1 tasks 18/18 at a fifth of the cost, tied in round 2, and needed no extra human decision. The targets E1 and E3 were not met in round 2 and E1 and E4 were not met in round 1, so the requirement fails. Orchestration alone (C1) added no measurable quality (claims O1/O2 not supported). Trade-offs: ECCode costs 2.9–4.6× more per success (2.4–2.5× in the round-2 sensitivity runs) and takes 7–9× the wall time; what it buys instead (an audit trail, enforced independent review, resumability) is not scored by the predeclared targets.

Disclosures that qualify these numbers ([round 1 analysis](../eval/results/round1/ANALYSIS.md), [round 2 analysis](../eval/results/round2/ANALYSIS.md)):
- Round 1: an account usage limit disturbed 13 of 54 holdout trials. I quarantined them by an outcome-blind rule introduced after the fact, and re-ran them; the as-run numbers (C2 72.2 %, E3 also not met) are kept next to the final ones.
- Round 2 was designed after round 1 (larger tasks, toolkit v2) and is a second test, not a replication. Two hidden checks that every condition failed in every repeat were found defective or ambiguous only after the run (one contradicts its own task text). Official numbers keep them; sensitivity analyses without them change no verdict on E1, E3 or E4.
- Targets were declared after two pilot trials; the maintainer saw holdout task names before round 1 and read the failures after; C0 never dispatched a subagent in this headless setup; the "intervention" metric is a heuristic; one model, 6 tasks per round, wide intervals (C0 and C2 are statistically indistinguishable in round 2).
- Cost of the whole evaluation was small (tens of dollars); the cap was never the constraint.

## Final acceptance
| Deliverable | Where |
|---|---|
| Toolkit and source | repository root: `agents/`, `skills/`, `commands/`, `hooks/`, `lib/`, `bin/`, `schemas/`, `templates/` |
| Documentation | [README](../README.md), [usage](usage.md), [architecture](architecture.md), [memory](memory.md), [ECC assessment](ecc-assessment.md), [final report](final-report.md) |
| Demonstrations | `examples/groundwork/` (this run), `examples/triage-desk/`, `examples/learning-cycle/`, evidence under `docs/evidence/` |
| Evaluations and results | `eval/` (tasks, harness, targets, protocols), `eval/results/round1`, `eval/results/round2` |
| Limitations | this report and the final report |

Mandatory requirements 4 (delivery) and 7 are **not passed**, so the project is **not accepted** as having met its own completion criteria. No claim of broader intelligence is made or supported: the evidence is 12 small and 6 mid-sized service tasks, one model, one baseline. What would change the verdict: a human decision on Groundwork's four open findings plus a rework that records the deleted files would close 4b; 7 needs a different result against the original ECC, not a different reading of it. I did not change a target, a threshold, or a hidden check to obtain a pass.
