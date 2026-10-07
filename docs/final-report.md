# ECCode: Final Report

**Date:** 2026-10-07 · **Branch:** `claude/keen-allen-5z33eb`

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
| 7 | Automated checks | `tests/` (52 tests), `scripts/validate-toolkit.js`, `claude plugin validate --strict` |
| 8 | Demonstration: web app with an AI feature through the full workflow | `examples/triage-desk/` (app + unedited `.eccode/` record) |
| 8b | Learning cycle across projects and sessions | `examples/learning-cycle/legacy-project/`, shared lessons |
| 9 | This report | `docs/final-report.md` |

## 2. Verified toolkit capabilities

`npm run check` runs the static validation of 12 agents, 7 skills and 6 commands, then **52/52 tests**. `claude plugin validate` passes `--strict` for the manifest, agents, skills and commands. The plugin installed through Claude Code 2.1.293 (`claude plugin install eccode@eccode`, isolated config dir).

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
  - It was approved by an independent reviewer and is **not adopted**: adoption requires the user.

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
| Review rejection rate | 3/10 | All three were first drafts of document gates |
| Reviews refused by gate rules | 2 | Both a malformed `decision` value |
| Repeated-bug fingerprints | 0/1 | Single-project sample |
| Median time to verified fix | 10.1 min | n=1 |
| Recurrence after fix | 0 | The legacy-project case was pre-fix data, not a recurrence |
| Applicability checks | 66 applies / 22 does-not-apply / 7 provisional | "Applies" means the environment matches, not that the lesson is relevant; agents judged relevance themselves |
| Workflow changes adopted / regressions | 0 / 0 | One approved proposal awaits the user |

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

- **User decisions:**
  - RISK-12: accept the holdout miss as a known fallback limitation, or commission a revision with a fresh holdout.
  - Adopt the review-gate improvement `imp-muyofpap-01971797`.
  - Confirm the orchestrator defaults: Q1 Haiku default, Q4 card redaction, Q7 zero dependencies.
- A hotfix task type, so approved-phase files can be changed under re-review. That would clear RISK-10's schema-level gate and RISK-11's `exec` in package.json.
- Make `run end` require usage figures, as the provisional lesson recommends.
- Run the guard hook live in a plugin-installed session, and run the live-model evals with a key.
- Mirror agents to Codex and Gemini natively. Today `export agents-md` gives sequential, disclosed role execution only.
