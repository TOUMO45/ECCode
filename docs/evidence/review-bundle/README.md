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

PENDING-MERGE-TABLE

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
| Three explicit workflow levels with routing rules defined before execution and escalation when risk grows | PENDING-MERGE-ROUTING |
| Reduce repeated context loading; compact versioned handoffs; dispatch only relevant specialists; measure rather than assume | Change mode and the adaptive path exist; the measurement is round 3's P2 and latency. No new mechanism was added without a measurement to justify it |
| Expand learning around diverse root causes; test cross-project transfer, decoys, contradictions, stale versions, harmful advice; measure retrieval before improving it | Shared lessons now carry an attestation and are quarantined when their bytes change (F6); stale and superseded lessons were already flagged; wrong-cause assessments exist. A varied bug-transfer suite is evaluation work (phase C) and is listed in the round-3 draft, not claimed |
| Finish Groundwork: the `null` (cause named), `.env.example`, stale risk entries, residual verifier limitations, product-owner acceptance | The `null` was fixed by rework-5 through the gates on this branch (`docs/evidence/groundwork/README.md`, second delivery), `.env.example` added; the verifier's residual is RISK-1 and the README's "What verified means"; the product-owner decisions are one reply away in [`docs/sign-off.md`](../../sign-off.md). The stale titles of RISK-13 and RISK-15 remain (their status is `mitigated` and their mitigation text is current); recording their closure from this session was refused by the session's permission policy and is left for the owner |

## Required completion sequence

| Phase | Exit condition (from the review) | Status on this branch |
|---|---|---|
| A: restore trustworthy gates (F1–F6) | every demonstrated bypass refused; intended workflows still complete | PENDING-MERGE-A |
| B: reliability and release (F7–F9) | exact release installs, upgrades, resumes and rolls back; no release-blocking findings | PENDING-MERGE-B |
| C: adaptive execution and learning | predeclared efficiency and learning checks pass | Routing rules are written; the checks are round 3's, not run |
| D: independent evaluation | agreed targets pass with uncertainty and reproducible evidence | Protocol drafted; needs the user's cap and model choice |
| E: real-world acceptance | owner accepts deliverables and residual risks; pilot on a real repository | Sign-off package ready; no pilot team |

## What "100 %" means here

The review's definition: every mandatory, versioned requirement and repair acceptance test has passed on the declared scope, with evidence and authorised sign-off. On this branch: PENDING-MERGE-CLAIM. What a toolkit branch cannot supply by itself: a model run with a budget (phase D), a product owner's decisions (phase E), a pilot team, and an outside human security review. Each has a one-reply package (`docs/sign-off.md`, `eval/suite/round3-protocol-DRAFT.md`, `docs/security-review-request.md`).
