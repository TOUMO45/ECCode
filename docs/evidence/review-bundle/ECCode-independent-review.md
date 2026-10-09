# ECCode independent review and completion plan

Reviewed 9 October 2026. Verdict: the project is a substantial working prototype, but the original completion goal is not achieved. The agent's report is candid about benchmark failure; its claim that requirements 1–6 have passed is too broad when tested against the implementation.

## Scope and independent verification

Source: [TOUMO45/ECCode, commit b8def3da](https://github.com/TOUMO45/ECCode/tree/b8def3da909abac3eea1ef76e595b7248938b1c7), the tip of `claude/brave-bardeen-6y5ng9` when inspected. GitHub's default branch was `claude/keen-allen-5z33eb` at `d2d0c243`; the reported branch was 70 commits ahead, with no commits behind. Installing the default branch therefore does not necessarily install the version described in the report.

Bulk Git downloads stalled, so I retrieved a complete snapshot through GitHub's raw-file endpoint and verified every one of its 2,049 files against the Git blob hashes returned by GitHub's tree API. All matched. This was a review copy; I did not modify the remote repository or its implementation.

I inspected the engine, guard hooks, agent instructions, memory and improvement mechanisms, evaluation protocol/results, Groundwork code, and acceptance evidence. I ran deterministic tests and eight additional isolated probes. I did not rerun paid model evaluations, live Claude sessions, or browser tests. Historical model/browser results remain repository-reported evidence.

Independent results on Windows, Node 24.15.0:

| Check | Result |
|---|---|
| Toolkit component validation | Passed: 12 agents, 7 skills, 7 commands, hooks wired |
| `npm run check` | 131 passed, 5 failed, 136 tests |
| Groundwork `npm test` | 265 passed, 21 failed, 286 reported tests including a failing test-file/hook entry |
| Groundwork event audit | Passed: 731 events |
| Groundwork approved-artifact hash checks | No changes detected |
| Groundwork record statistics | 81 runs, 12 roles, 17 tasks, 25 handoffs, 323 evidence records, 27 reviews, 36 rejected review attempts |
| Additional probes | Confirmed the behavior described below |

These Windows failures do not disprove the reported Linux results. Several are portability or environment failures: POSIX shell commands, a Git line-ending conversion, symlink permissions, executable fixtures, process signals, and path handling. They do mean that a clean Windows pass has not been established. The successful hash audit establishes internal consistency of the supplied record, not independent attestation of every historical event.

## Most important findings

### F1 — High: reviews need not cover the agreed acceptance criteria

[`lib/gates.js:211–286`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/lib/gates.js#L211) validates the criteria supplied by the reviewer. It does not require them to cover an authoritative list of requirement IDs. The review schema only requires at least one criterion. Artifact-reference anchors are discarded in [`lib/evidence.js:139`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/lib/evidence.js#L139).

**Reproduced:** a brief containing multiple requirements was approved using only “The document has a title,” citing a nonexistent section of an existing artifact.

**Required repair:** persist immutable, versioned requirement IDs; derive each gate's mandatory coverage from the approved requirements and plan. Reject missing, duplicate, or unknown IDs. Validate cited sections where anchors are supported. A criterion's meaning still needs independent judgment, but omission is mechanically preventable.

**Acceptance:** omitting any mandatory criterion or citing an invalid section fails approval; complete, valid coverage passes.

### F2 — High: an omitted changed file can escape review and delivery checks

[`lib/tasks.js:54–65`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/lib/tasks.js#L54) exempts files inside the task's ownership from the unaccounted-change check even if the handoff omits them. Completion records only declared files. Phase pins and final delivery then rely on that incomplete set.

**Reproduced:** a task changed two files inside `src/**` but declared only one. The phase approved. I modified the omitted file after approval; `unreviewedChanges` returned an empty list and final delivery succeeded.

**Required repair:** derive the complete change manifest from the workspace or isolated worktree, including additions, modifications, deletions and renames. Require handoff reconciliation with that manifest. Pin the release tree and invalidate affected approvals when it changes. Define generated-file exclusions explicitly.

**Acceptance:** omitted, newly added, deleted, renamed, or subsequently changed deliverable files block delivery until reviewed.

### F3 — High: passing evidence is not bound to the required check or source version

[`lib/tasks.js:231–234`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/lib/tasks.js#L231) accepts any cited passing command after the claim. Phase reviews similarly require a recent reviewer-run passing command without requiring it to match the task's declared verification. Command evidence does not pin the tested source tree. Unlike file evidence, command references do not check whether their logs still exist or match a digest.

**Reproduced:** a task declared a command that exits with failure, but completed using an unrelated command that exits successfully. Separately, deleting a command's evidence log left its reference valid.

**Required repair:** define required check IDs in the approved plan; bind results to those IDs, task/gate, source-tree digest, test definitions, environment, actual execution identity, and complete log digest. Invalidate obsolete results. Do not describe every historical failed check as superseded unless a matching successful replacement exists.

**Acceptance:** an unrelated success, obsolete source version, missing/tampered log, or missing required check cannot authorize completion.

### F4 — High: reviewer write restrictions are bypassed through the shell

[`scripts/hooks/guard.js:216–238`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/scripts/hooks/guard.js#L216) checks shell operations for record manipulation and actor mismatches, but does not apply general task ownership to shell writes. Shell commands without `eccode` return early. Reviewers have Bash access.

**Reproduced:** the guard denied a reviewer's direct Write to a source file, but issued no denial for `echo changed > src/server.js` from the same reviewer. The probe submitted hook input; it did not execute that shell write.

**Required repair:** run reviewers against a read-only source snapshot, allowing writes only to isolated test output and review drafts. Isolate implementers by worktree and filesystem permissions, with controlled integration. Fail closed for protected mutations if the guard cannot evaluate them. Adding more shell regular expressions alone is not a dependable boundary.

**Acceptance:** equivalent writes through direct tools, shell redirects, scripts, interpreters, or alternate paths have the same authorization outcome.

### F5 — High: an agent can claim to be the human, and critical risks do not block release

The hook explicitly permits the main session to use `--actor user`. The CLI's user-only operations trust that string. [`lib/delivery.js:39–57`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/lib/delivery.js#L39) has no release-risk disposition check.

**Reproduced:** a main-session command asserting `--actor user` was not denied. A completed sample project with an open critical risk was delivered successfully. The historical Groundwork log also contains operator decisions explicitly labelled as not coming from the human product owner, and four high risks remain open.

**Required repair:** put reserved decisions behind a separate human approval channel that agents cannot mint. Bind approval to the exact request, scope, artifact version, limits and expiry; prevent replay. Define a release policy for high/critical risks: verified mitigation or explicit acceptance by the authorized owner. Existing general authorization can be represented as bounded delegation, rather than repeated prompts.

**Acceptance:** agents cannot reopen reserved gates, raise reserved limits, waive findings, or accept risks by changing an actor argument. Altering the approved action invalidates its authorization.

### F6 — High: shared lessons lose their verification binding

[`lib/memory/records.js:323–325`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/lib/memory/records.js#L323) returns no verification objection for a record outside local memory once its status is `verified`. Local lessons have a content-hash relationship to review events; promoted shared records do not receive equivalent validation on retrieval.

**Reproduced:** I created and independently verified a lesson using the repository's fixture, promoted it, changed its saved solution without review, and opened a different project. The modified lesson still returned `applies` with no verification error.

**Required repair:** content-address shared revisions and preserve a trusted review/promotion attestation for the exact sanitized content. Check that attestation on every import/use; quarantine changes and malformed records. Keep the trusted index outside agent-writable storage. Test revocation, stale knowledge, conflicting lessons and cross-project privacy.

**Acceptance:** changing one byte of a promoted solution makes it unusable as verified knowledge until reviewed again.

### F7 — Medium: state mutation can proceed from a corrupted snapshot

[`lib/store.js:97–107`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/lib/store.js#L97) trusts snapshot contents when its sequence and last hash match the log. It does not verify the snapshot's content against replay before committing another state transition.

**Reproduced:** changing only the snapshot's architecture status to approved let the design gate start. A later audit detected the discrepancy, so this is not a claim that final audited delivery always bypasses it.

**Required repair:** derive trusted state from verified events, or validate a trusted snapshot digest before mutation. Make multi-step task/handoff and improvement transitions recoverable. Add crash and concurrent-writer fault tests. A hash chain stored alongside all writable data is not protection against an actor that can rewrite and rehash the whole history; stronger threat models need an independently protected checkpoint.

### F8 — Medium: limits are accounting checks, not complete runtime enforcement

[`lib/project.js:38–50`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/lib/project.js#L38) checks recorded totals. Run closure accepts reported usage; missing pricing can leave reported tokens with zero dollar cost. Recovery records interrupted runs with zero duration and spend. Task concurrency does not cap every agent run.

**Required repair:** integrate provider/harness usage, reserve budget before dispatch, track in-flight spend, enforce deadlines and process cancellation, cap active runs, and represent missing usage as unknown. Document which limits the host enforces and which are estimates. Do not claim hard dollar enforcement from after-the-fact self-reporting.

### F9 — Medium: portability and release reproducibility remain incomplete

The Windows test failures are real results from this review, with logs in the evidence package. The repository has no `.github` CI workflows in the reviewed snapshot. Browser testing depends on a globally installed, unpinned Playwright. The package advertises `lib/index.js` as its main entry, but that file is absent. The reported branch is ahead of the default installation branch.

**Required repair:** declare supported platforms and Node versions; add clean CI for those combinations, portable process launching and fixtures, fixed line-ending policy, pinned browser/test dependencies, package-content validation, a versioned release, changelog, record migrations and an upgrade/rollback test. Test the exact installed release, not only the source checkout.

## Evaluation: what it establishes and what it does not

The published results correctly mark requirement 7 failed. Round 1 reported ECCode 83.3% success versus ECC 100%; round 2 reported 61.1% each. ECCode cost 2.9–4.6 times more per success and took substantially longer. These are repository-reported historical results; I inspected their protocols and stored summaries, rather than rerunning the model sessions.

The 48/48 versus 6/48 learning result supports retaining and using organizational rules under this suite. ECC also achieved 48/48. It does not demonstrate broad debugging expertise or superiority to ECC. Only one debugging-lesson transfer was demonstrated separately. Withholding undocumented organizational rules from the no-memory condition measures memory's information advantage, not by itself the quality of reasoning or review.

The benchmark already used `/eccode:change`, a lighter path with four dispatches, rather than the complete new-product workflow. Therefore adding a change mode is not the missing optimization; the existing change mode needs to become adaptive.

For the next version:

1. Freeze a genuinely changed toolkit, supported host/model versions, protocol, metrics, limits, and grading rules before final testing. Preserve the failed historical results.
2. Use representative task categories: UI/accessibility, API/authentication, database migration, multi-service integration, AI evaluation, unfamiliar bugs, interrupted work, and malicious or stale inputs.
3. Start planning around 30–50 distinct tasks and repeated runs across 2–3 supported models; choose the final sample size from pilot variability and a power/precision calculation. More repeats of six tasks do not create broad task coverage. Analyze paired results and uncertainty at the task level.
4. Have an independent evaluator check every hidden assertion against the task text, using more than a single reference implementation. Predeclare how invalid graders and infrastructure failures are handled.
5. Compare supported ECC operation, ECCode adaptive mode, and ECCode strict mode. Include matched memory-enabled and disabled comparisons where making learning claims. Verify actual dispatch behavior and comparable budgets.
6. Measure escaped defects, review precision, rework, recovery success, legitimate escalations, unnecessary escalations, cost per accepted task and latency. Do not reward bypassing human authorization merely because it reduces intervention counts.
7. Preserve per-trial results, final patches, check logs, version manifests, usage and intervention records in a sanitized replay bundle. Summaries alone are insufficient to independently recompute the entire experiment.

The old target of a 20-percentage-point advantage cannot be met when the baseline already exceeds 80%. It still failed as written. A future release may use a newly agreed, preregistered product-value target, but that creates a new evaluation; it does not retroactively pass the old one. Broader task coverage must be justified by intended use, not selected to make ECC lose.

## How to make ECCode stronger

Use three explicit workflow levels. For low-risk changes, use one implementer and one independent final reviewer. For normal features, add planning where dependencies or interfaces require it. For authentication, payments, migrations, public releases and other high-impact changes, retain full architecture and specialist review. Define routing rules before execution and require escalation if actual risk grows. All modes retain complete requirement coverage, trusted evidence, file coverage and authorization.

Reduce repeated context loading and polling. Pass compact, versioned handoffs; dispatch only relevant specialists; cache repository maps keyed to source versions; parallelize genuinely independent tasks. Measure improvements rather than assuming additional agents help.

Expand learning around diverse root causes: races, invalidation, authorization, migrations, parser edge cases, API changes, provider failures and prompt injection. Test cross-project transfer, wrong-cause decoys, contradictory lessons, stale versions and harmful advice. Improve retrieval only after measuring recall and incorrect application; a vector database alone does not establish expertise. Separate approved organizational policy from fallible debugging lessons, which need applicability judgments.

Finish Groundwork. The visible `null` has an identifiable cause: native `Element.append` calls in [`public/js/views/incident.js:55–59`](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/examples/groundwork/public/js/views/incident.js#L55) and [259–261](https://github.com/TOUMO45/ECCode/blob/b8def3da909abac3eea1ef76e595b7248938b1c7/examples/groundwork/public/js/views/incident.js#L259) receive conditional `null` values. The custom `h()` helper filters null children, but those calls bypass it. Filter children or append conditionally. Add `.env.example` with accurate loading instructions, resolve stale risk entries, document residual semantic-verifier limitations, and obtain actual product-owner acceptance. This review identified the cause but did not modify the application.

## Required completion sequence

| Phase | Work | Exit condition |
|---|---|---|
| A: Restore trustworthy gates | F1–F6, with adversarial regression tests | Every demonstrated bypass is refused; intended workflows still complete |
| B: Reliability and release | F7–F9, crash/concurrency recovery, supported-platform CI, versioned installation | Exact release installs, upgrades, resumes and rolls back successfully; no unresolved release-blocking findings |
| C: Adaptive execution and learning | Risk-based routing, reduced overhead, varied bug-transfer suite | Predeclared efficiency and learning checks pass without weakening authority or verification |
| D: Independent evaluation | New frozen protocol and unseen task set | Agreed quality/cost targets pass with reported uncertainty and reproducible evidence |
| E: Real-world acceptance | Finish Groundwork; pilot on a real repository for several weeks | Owner accepts deliverables and residual risks; pilot rework, escaped-defect and cost targets pass |

Reassess the original requirements as follows: installation is demonstrated on Linux but portability is incomplete; collaboration is demonstrated but independence/authority need hardening; review gates are partial; the application is substantially implemented but clean acceptance remains qualified; resume is demonstrated with integrity gaps; learning is demonstrated narrowly with a shared-memory trust flaw; superiority to ECC failed its declared targets.

“100% achieved” should mean every mandatory, versioned requirement and repair acceptance test has passed on the declared scope, with evidence and authorized sign-off. It cannot mean universal expertise, zero future bugs, or AGI. Do not turn the number of roles or tests into an expertise score.

## Evidence package

`ECCode-review-evidence.zip` contains this review, original local test logs, source-integrity and Groundwork-audit results, isolated probe results, and a reproduction script. To rerun the probes, check out the pinned source commit and run `node review-probes.cjs <checkout-directory>`. The probes create temporary sample projects, not changes to the source checkout. They use Node and Git and require no paid model calls. They intentionally demonstrate accepted-invalid behavior; successful script execution is not a security pass.
