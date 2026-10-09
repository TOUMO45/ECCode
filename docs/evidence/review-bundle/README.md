# The independent review bundle, and what this branch did with it

**What this is.** On 2026-10-09 an independent reviewer (a Codex session on the maintainer's machine, working from a verified snapshot of commit `b8def3da`, the tip of `claude/brave-bardeen-6y5ng9`) produced `ECCode-review-evidence.zip`. The maintainer uploaded its files to this session; they are preserved here byte for byte, with `MANIFEST.sha256`. This page maps every finding, test failure and recommendation in the bundle to what the branch `claude/funny-feynman-rt1io9` does about it, with the test that proves each engine change. Nothing in the bundle was edited.

## Contents of the bundle

| File | What it is | Lines |
|---|---|---|
| `ECCode-independent-review.md` | The review: scope and verification method, findings F1–F9 with reproductions, the evaluation assessment, how to make ECCode stronger, the required completion sequence | 155 |
| `eccode-check-windows.log` | `npm run check` on Windows 11, Node 24.15.0: 131 passed, 5 failed of 136 | 293 |
| `groundwork-check-windows.log` | Groundwork `npm test` on the same machine: 265 passed, 21 failed of 286 | 745 |
| `independent-evidence.json` | Source-integrity check (2,049 files, no mismatch), Groundwork audit (731 events OK), record statistics, risk register, the operator's `--actor user` events | 161 |
| `review-probe-results.json` | The eight isolated probes' raw results | 109 |
| `probes/*.js` | **Not from the bundle.** The reviewer's `review-probes.cjs` was not uploaded; these nine scripts were written fresh here from the review's descriptions and run against this branch's head before any fix (commit `f734139`). They require the engine by path relative to the repository and clean up after themselves | |

## The eight probes, re-run on this branch before the fixes

The review was made against `b8def3da`. This branch had already changed the engine (the red-team fixes RT1–RT9, `rework extend`, the post-delivery reopen), so each probe was re-run on `f734139` by a fresh-context agent before anything was fixed.

| Probe | Reviewer's result on `b8def3da` | On `f734139` before the fix | Why |
|---|---|---|---|
| F1 review coverage and bogus anchor | approved | **still approved** | `checkReview` validates only the supplied criteria; anchors dropped in `resolveRef` |
| F2 omitted owned file | approved, delivered | **closed** | RT2 (`files changed inside your ownership that the handoff does not declare`) refuses completion; the control path shows the declared file is pinned and a later edit blocks delivery. Two gaps remained (below) |
| F3a unrelated check accepted | completed, approved | **still accepted** | neither completion nor phase review reads `task.verification` |
| F3b evidence log removed or altered | still resolvable | **still resolvable** | only file evidence is re-hashed |
| F4 reviewer shell write | no denial | **no denial** (10 of 10 cases) | shell ownership checks ran only for implementer roles |
| F5a main session as `user` | no denial | **no denial** | by design, asserted by a test |
| F5b open critical risk delivered | delivered | **delivered** | no release policy exists |
| F6 tampered shared lesson applies | applies | **applies** | `unverifiedReason` returns null for any non-local record marked verified; the promoted copy carries no attestation |
| F7 forged snapshot drives a transition | accepted | **accepted**, and a plain `rebuild` then launders it into a hash-valid log | `state()` trusts a snapshot whose seq and hash match |

## Finding by finding

All nine are repaired on this branch (version 0.3.0). Each repair was made in an isolated branch by an agent that first turned the probe into a failing regression test, then merged; the test files are `tests/review-F*.test.js` (78 tests), rows R26–R36 of [`docs/threat-model.md`](../../threat-model.md), and the `0.3.0` section of [`CHANGELOG.md`](../../../CHANGELOG.md). "Required repair" and "Acceptance" are the review's words; the last column says how far each is met.

| Finding | Required repair (review) | On this branch | Acceptance met? |
|---|---|---|---|
| **F1** reviews need not cover the agreed acceptance criteria; anchors discarded | persist requirement ids; derive each gate's mandatory coverage; reject missing, duplicate, unknown ids; validate cited sections | `gates.requiredCriteria` derives the ids from the artifacts (acceptance-criteria ids of the brief for architecture, design and verification; `phase:<id>` for the plan; `task:<id>` + `phase:<id>` for a phase); `eccode gate show` lists them; approvals missing any are refused; duplicates and look-alike ids refused; `#anchor` validated against headings, JSON paths, line ranges. Ids are persisted in the submitted artifact bytes the gate pins (hash), not in a separate registry | **Yes** on the declared scope: omitting a required criterion or citing an invalid section fails approval; complete, valid coverage passes (8 tests). A criterion's meaning still needs judgement (residual 4) |
| **F2** an omitted changed file escapes review and delivery | derive the complete change manifest; reconcile the handoff with it; pin the release tree; invalidate approvals when it changes; define generated-file exclusions | Omitted owned changes were already refused (RT2). Added: dirty owned files refused at claim; every submission records commit and tree; delivery reports files added, modified, deleted or renamed after the last approved submission's commit; delivery needs a clean tree and records the release commit; `release.ignore` names generated paths | **Yes**: omitted, newly added, deleted, renamed and subsequently changed deliverable files block delivery until reviewed (10 tests). Git-ignored files remain invisible (residual 6) |
| **F3** passing evidence not bound to the required check or source version; logs unverified | required check ids from the plan; bind results to task, tree digest, execution identity, log digest; invalidate obsolete results | Completion needs a passing run of the task's declared command by the owner after the claim; phase approvals need a reviewer run of every declared command; evidence records a content digest of the tree and the log bytes; a check on different bytes, a deleted or altered log, is refused at completion, review and reconciliation | **Yes**: an unrelated success, an obsolete tree, a missing or tampered log, or a missing required check cannot authorise completion (9 tests). Not done: binding to test definitions or the environment beyond the tree digest; a failed check is "superseded" only by a later passing run of the same command, which the reconcile check already requires |
| **F4** reviewer write restrictions bypassed through the shell | read-only snapshots for reviewers; worktree isolation for implementers; fail closed for mutations the guard cannot evaluate | The guard applies the Edit rules to every role's shell write targets, denies inline interpreter programs that call a write API, resolves relative targets from the hook cwd and denies writes after a `cd` it cannot bind; writes to record or memory files anywhere are denied | **Partly**: equivalent writes through direct tools, redirects and inline interpreters now get the same answer (6 tests); a script file the guard cannot see into still escapes (residual 1). Read-only snapshots and worktree isolation need the host and are not built |
| **F5** an agent can claim to be the human; critical risks do not block release | a human approval channel agents cannot mint; approvals bound to request, scope, version, limits, expiry, no replay; a release policy for high/critical risks; bounded delegation | `--actor user` needs a person at a terminal (TTY confirmation; `ECCODE_TEST=1` is the suite's switch); the guard denies it from every agent context; `eccode delegate grant` records a delegation bound to grantee, action, target, uses and expiry, spent before the action, revocable; `release.blockRiskSeverities` blocks delivery on open critical or high risks; the handoff lists user and delegated events | **Yes**: agents cannot reopen gates, raise reserved limits, waive findings or accept risks by changing an actor argument; a delegation covers one action and target and cannot be replayed (18 + 6 + 2 tests). The terminal check cannot tell the product owner from another person (residual 2) |
| **F6** shared lessons lose their verification binding | content-address shared revisions; keep an attestation; check it on every use; quarantine changes; trusted index outside agent-writable storage | Promotion writes an attestation (hash of layer, status, trust, content; the verifying review's revision, reviewer and content hash; promoter; engine) and appends to a hash-chained `attestations.jsonl`; retrieval, search weighting and `memory audit` recompute and require the index to agree; shared records are immutable | **Yes**: one changed byte of a promoted solution (or status, trust, layer) quarantines the record until re-promoted (6 tests). The index is outside the record files but still on an agent-writable disk (residual 3) |
| **F7** state mutation from a corrupted snapshot | derive trusted state from verified events or validate a digest before mutation; recoverable multi-step transitions; crash and concurrent-writer tests | Every event carries `stateHash`; `Store.state()` verifies the snapshot against it or a full replay and refuses `SNAPSHOT_DIVERGED` inside the commit lock; torn snapshots rebuilt; the handoff gap after a crash is an audit warning recoverable with `eccode handoff record`; concurrent-writer and torn-snapshot tests | **Yes** for the demonstrated bypass (7 tests). An actor who rewrites and rehashes the whole history is not detected, as the review says: an independently protected checkpoint is not built (residual 3) |
| **F8** limits are accounting checks | integrate host usage; reserve budget; track in-flight spend; deadlines and cancellation; cap runs; unknown usage as unknown; document what the host enforces | `limits.maxActiveRuns`; `limits.reserveUsdPerRun`; unknown usage recorded as `null` and totals called a lower bound; recovered runs carry their real duration; the usage table states what is enforced, self-reported, or host-only | **Partly**: caps, reservation and honest accounting are enforced (6 tests); deadlines, process cancellation and provider-side usage need the host and are documented as such, not claimed |
| **F9** portability and release reproducibility | declare platforms; CI; portable launching and fixtures; line-ending policy; pinned browser deps; package validation; versioned release; migrations; upgrade/rollback test | Platforms declared; the five Windows failures traced to fixtures and fixed; `.gitattributes`; `shellQuote` with a `win32` branch; `lib/index.js`; package and manifest validation; version 0.3.0 with a changelog; record compatibility documented; an upgrade/rollback test against 0.1.0 | **Partly**: everything on the list except a Windows run (no host here; CI reports) and pinned browser dependencies for Groundwork (an approved artifact of the delivered record; see below) |


## The Windows test failures

### Toolkit (`eccode-check-windows.log`, 5 of 136)

| Test | Cause on Windows | Change on this branch |
|---|---|---|
| `evidence logs redact secrets and record exit codes` (exit 4 expected, got 0) | the fixture `echo …; exit 4` runs under `cmd.exe`, where `;` is not a separator: one `echo`, exit 0 | fixture rewritten as a `node -e` program (same assertions) |
| `evidence run preserves argument quoting (sh -c …)` | needs `sh` and `test`; and `shellQuote` emitted POSIX single quotes that `cmd.exe` does not understand, so a quoted argv element is split at `&&` | `shellQuote` gains a `win32` branch (one copy in `lib/util.js`); fixture uses `node -e` programs |
| `rework: a file deleted by an approved rework …` (`src/web/b.js` modified after approval) | `git checkout --` with the reviewer's global `core.autocrlf=true` rewrote the LF file as CRLF; the record pins bytes | test repositories set `core.autocrlf=false`; the toolkit repository gets a `.gitattributes` (`* text=auto eol=lf`, bundle files and evidence logs `-text`) |
| `#1 adopt and rollback …`, `#13 only evaluated proposals …` (candidate evaluation exit 1) | the fixture's evaluation command is `grep -q`, absent on `cmd.exe` | fixture uses a `node -e` program with the same contract |

The engine's command runner is unchanged: it hands the command to the platform shell as before. Windows could not be run from this session; the causes are reasoned from the log, Node's documented `shell: true` behaviour and `cmd.exe` parsing, and each fixture was verified on Linux. The CI Windows job stays non-gating until it has passed on the runner.

### Groundwork (`groundwork-check-windows.log`, 21 of 286)

| Group | Tests | Cause | Decision |
|---|---|---|---|
| `test/api/static.test.js` | 9 (8 tests plus the file's hook) | the fixture creates a symlink to prove traversal protection; Windows refuses `symlink` without the privilege (`EPERM`) | not changed |
| `test/eval/scorer.test.js` runner exit codes | 3 | the runner reports `NOT_RUN` (exit 3) when the `claude` CLI is absent before it checks the run cap (exit 2); on the reviewer's machine the CLI was absent | not changed |
| `test/unit/ai/cli.test.js` | 8 | the fake CLI is a shebang script; Windows cannot spawn it (`PROVIDER_UNAVAILABLE`, reason `spawn`) | not changed |
| `seed-index` process test | 1 | Windows has no `SIGTERM` delivery; the child exits with `null` | not changed |

Why not changed: every one of these files is an approved artifact of the delivered Groundwork record; editing it would show as "modified after approval" and needs a rework through the gates (as rework-5 did for the `null` defect). The failures are fixture portability, not product defects, and Groundwork never declared Windows: its README requires Node ≥ 22.5 and a global Playwright. The statement is now explicit in `docs/evidence/groundwork/README.md`: supported on Linux and macOS; a Windows port of the test fixtures is a rework the product owner can order.

## Evaluation (the review's assessment and seven recommendations)

Agreed in full. The review's reading matches the acceptance report: requirement 7 failed on its predeclared targets, the 48/48 vs 6/48 learning result shows rule retention under this suite and not broad expertise, and the benchmark already used change mode, so "add a change mode" was not the missing optimisation. The branch does not re-run anything (a model run needs the user's budget). The seven recommendations are folded into [`eval/suite/round3-protocol-DRAFT.md`](../../../eval/suite/round3-protocol-DRAFT.md): frozen release and protocol, eight task categories, a pilot of 32 tasks with the sample size derived from its variance, independent grader validation with two reference implementations, four conditions (ECC supported operation, ECCode adaptive, ECCode strict, learning off), the new metrics (escaped defects, review precision, rework, recovery, legitimate vs unnecessary escalations, cost per accepted task, latency), and a replay bundle. The draft states that a new target is a new evaluation and does not pass the old one.

## "How to make ECCode stronger"

| Recommendation | On this branch |
|---|---|
| Three explicit workflow levels with routing rules defined before execution and escalation when risk grows | Written into the orchestrate skill (§1): low-risk (one implementer, one independent reviewer), normal (plus planning and its review), high-impact (the full delivery with the security reviewer), classified and recorded as a decision before execution, re-routed with a new decision if the work grows; every level keeps coverage, declared checks, the release tree and the authority rules, which the engine enforces whatever the path |
| Reduce repeated context loading; compact versioned handoffs; dispatch only relevant specialists; measure rather than assume | Change mode and the adaptive path exist; the measurement is round 3's P2 and latency. No new mechanism was added without a measurement to justify it |
| Expand learning around diverse root causes; test cross-project transfer, decoys, contradictions, stale versions, harmful advice; measure retrieval before improving it | Shared lessons now carry an attestation and are quarantined when their bytes change (F6); stale and superseded lessons were already flagged; wrong-cause assessments exist. A varied bug-transfer suite is evaluation work (phase C) and is listed in the round-3 draft, not claimed |
| Finish Groundwork: the `null` (cause named), `.env.example`, stale risk entries, residual verifier limitations, product-owner acceptance | The `null` was fixed by rework-5 through the gates on this branch (`docs/evidence/groundwork/README.md`, second delivery), `.env.example` added; the verifier's residual is RISK-1 and the README's "What verified means"; the product-owner decisions are one reply away in [`docs/sign-off.md`](../../sign-off.md). The stale titles of RISK-13 and RISK-15 remain (their status is `mitigated` and their mitigation text is current); recording their closure from this session was refused by the session's permission policy and is left for the owner |

## Required completion sequence

| Phase | Exit condition (from the review) | Status on this branch |
|---|---|---|
| A: restore trustworthy gates (F1–F6) | every demonstrated bypass refused; intended workflows still complete | Done for every demonstrated bypass (F1–F6 closed, 59 tests); intended workflows complete (the whole suite and the shipped records still pass) |
| B: reliability and release (F7–F9) | exact release installs, upgrades, resumes and rolls back; no release-blocking findings | Done on Linux and macOS: the 0.1.0 record installs, upgrades, resumes and rolls back under test; no release-blocking finding is open. Windows unverified; Groundwork's Windows fixtures left to a rework |
| C: adaptive execution and learning | predeclared efficiency and learning checks pass | Routing rules are written; the checks are round 3's, not run |
| D: independent evaluation | agreed targets pass with uncertainty and reproducible evidence | Protocol drafted; needs the user's cap and model choice |
| E: real-world acceptance | owner accepts deliverables and residual risks; pilot on a real repository | Sign-off package ready; no pilot team |

## What "100 %" means here

The review's definition: every mandatory, versioned requirement and repair acceptance test has passed on the declared scope, with evidence and authorised sign-off. On this branch: every repair acceptance test the review named passes on the declared scope (Linux and macOS, Node 18.17/20/22), with the four partial rows above stated as partial and their residuals in the threat model. What a toolkit branch cannot supply by itself: a model run with a budget (phase D), a product owner's decisions (phase E), a pilot team, and an outside human security review. Each has a one-reply package (`docs/sign-off.md`, `eval/suite/round3-protocol-DRAFT.md`, `docs/security-review-request.md`).
