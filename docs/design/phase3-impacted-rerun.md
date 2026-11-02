# Design: the reviewer's re-run on the impacted set, with a tree-hash check

Status: **design only, 2026-11-02. Not implemented.** It changes what the verification and phase gates accept as the reviewer's independent evidence, so it waits for the owner's approval. Recon: `docs/design/phase3-report.md` §4c (the time profile of the narrowed runs), `docs/limits.md` row 167 (the narrowing's current scope), `lib/tasks.js` (staged verification: the claim cites the owner's passing run of the pinned full command), `lib/gates.js` (review discipline), `lib/lab.js` (`tests.baseline` and the test-outcome invariant, which already records per-test outcomes and a tree fingerprint), `lib/guards/common.js` (`fingerprint`, `treeFingerprint`).

## 1. The guarantee today, and what this keeps

Today a code gate's approval rests on two executed facts: (1) the owner's claim of done cites a passing run of the task's pinned **full** verification command on the tree it claims; (2) the reviewer's own run of that same full command passes on the tree under review (`evidence run --gate …`, independent of the owner). Both are executed by the engine and hash-chained. The narrowed mealie4-05 run 4 shows the cost: 11 reviewer runs of the 12-minute Mealie suite, 32.9 of 108 minutes, two reviewers times the review rounds.

This design keeps both facts and removes the duplicate full run:

1. **Same tree.** The engine already records a tree fingerprint with the owner's full claim run (the test-outcome invariant's run carries `treeFingerprint`; the guards do too). The approval of a code gate is refused unless the owner's cited full run has the **same tree fingerprint** as the tree the reviewer is reviewing right now (`gates.recordReview` recomputes the fingerprint at approval time). So exactly one passing full run of exactly the delivered tree exists, by the owner.
2. **Independent check on the impacted set.** The reviewer's independent run becomes a run of the **impacted set**: the tests `impact` selects for the files changed since the claim base (its dependents' test files and the task's own test files), plus the task's scoped checks, plus every test file the change itself touched. The reviewer still executes it (`evidence run --gate … --impacted`), it is still recorded and hashed, and it must pass. An empty impacted set (a docs-only change) is an explicit `impact: none` evidence record, never silence.
3. **No re-run on an unchanged tree.** On a re-review after `changes_requested`, the reviewer's run is required only when the tree fingerprint changed since the reviewer's last recorded run; an unchanged tree cites the previous run.
4. **Guards and the security reviewer are untouched.** Their own re-runs (migration proof, matrix, IDOR) stay as they are; this design concerns the pinned verification command only.

What changes in the guarantee, stated plainly: the reviewer's independent evidence narrows from "the whole suite passes on this tree, run by me" to "the whole suite passed on this exact tree, run by the owner and bound to it by hash; the tests the change can reach pass, run by me". The owner's run is executed by the engine, not asserted, so the whole-suite fact still rests on an executed run; what the reviewer no longer independently establishes is that a test *outside* the impacted set is unaffected. The negative tests below are about exactly that gap.

## 2. Events and rules (for the implementation, after approval)

| Change | Where |
|---|---|
| `evidence run --impacted`: runs the impacted set; the event carries `impacted: {base, files, tests, mapSha256}` with the impact map's hash | `lib/evidence.js`, `lib/impact` (existing `impact` command) |
| `review.recorded` approval on a code gate refuses when the cited owner full run's `treeFingerprint` ≠ the current tree's (`TREE_CHANGED`), or when the reviewer's cited run is neither a full run nor an impacted run on the current fingerprint (`REVIEW_REJECTED`) | `lib/gates.js` `checkReview` |
| The impacted set is computed from the claim base to the current tree at run time, never taken from the handoff | `lib/evidence.js` |
| `config.verification.reviewerRerun: full | impacted` (default stays `full` until approved and measured) | `lib/config.js` |
| Report and handoff name which mode the review used and the two fingerprints | `lib/delivery.js`, `lib/quick.js` |

## 3. Tests that must exist before any implementation is merged

Positive:
- P1. Owner full run on tree T, reviewer impacted run on T, fingerprints equal → approval accepted; the report names both runs and the mode.
- P2. Re-review after `changes_requested` with an unchanged tree → approval accepted citing the reviewer's earlier run; with a changed tree → refused until a new impacted run.

Negative (each refuses with the named code):
- N1. **A test outside the impacted set that the change breaks.** Fixture: module A imported by test file TA; the change edits A and also a module B that `impact` does not link to TA's directory (a dynamic import, or a data file read at runtime); TB fails. The owner's full run (which includes TB) fails → no claim; and separately: an owner full run that passed on T₁, then a later edit of B producing T₂ with TB failing, reviewer impacted run on T₂ passes → approval refused (`TREE_CHANGED`: the full run is on T₁, not T₂). The test asserts the refusal names the fingerprints.
- N2. **Tree altered after verification.** Owner full run on T₁; any file edited (even whitespace in a non-test file) → fingerprint T₂; reviewer impacted run on T₂ passes → approval refused `TREE_CHANGED`; after a new owner full run on T₂ → accepted.
- N3. **Stale impact map.** The impacted set was computed on T₁; the change then adds a new test file; the reviewer's cited impacted run carries `mapSha256` of T₁'s map → approval refused (`IMPACT_STALE`: the map must be computed on the tree under review).
- N4. **Impacted run that is a subset by hand.** A reviewer run whose command is a narrower subset than the computed impacted set (one file of it) is not an impacted run → refused.
- N5. **The reviewer's run on another tree.** The reviewer runs the impacted set in a worktree at the base, or after a `git stash` → its fingerprint ≠ the reviewed tree → refused.

Bypass (forged events):
- B1. A forged `evidence.recorded` with `impacted` and a matching fingerprint but no artifact/log → `audit` fails and the approval is refused (`EVIDENCE_NOT_EXECUTED`).
- B2. A forged owner full run with the current fingerprint and `status: passed` but a log whose hash does not match → `audit` fails.
- B3. `config.verification.reviewerRerun` flipped to `impacted` after the claim → the gate rule reads the mode from the record's `work.started` config snapshot, not the live config (or refuses a mode change mid-work).

## 4. The time target, from measurements instead of a round number

The brief's "15 minutes" is replaced by what is measured. Data: the 7 narrowed Phase 3 debug runs on the two Mealie hard items (6 registered + 1 supplementary; `bench/pilot-results/2026-11-01-phase3-remeasure-narrowed.*.jsonl`) and the one fully profiled run (run 4, `docs/design/phase3-report.md` §4c). Every engine run record now carries its phase profile, so these distributions fill in with every future run.

Across the 7 runs (median / p90):

| Measure | Median | p90 | Range |
|---|---|---|---|
| Wall minutes per run | 59.1 | 104.2 | 46.7–108.9 |
| Cost per run ($) | 5.32 | 6.13 | 3.23–6.47 |
| Review rounds | 6 | 7.6 | 3–10 |
| Rejections | 1 | 2 | 0–2 |
| Checks recorded | 21 | 26 | 9–32 |

Per phase, the one profiled run (n = 1, 108.5 min; medians and p90 per phase need the profiles of the next runs, which the bench now records):

| Phase | Wall min | Agent time (no command) | Commands |
|---|---|---|---|
| implement | 45.8 | 40.3 | scoped checks 0.2 (1), full claim run 2.6 (4), fix verify 0.5 (2) |
| behavior diff (phase) | 31.1 | 1.6 | behavior diff 9.9 (4) and the reviewer re-runs that fell in it |
| review | 15.7 | 3.5 | reviewer re-run 32.9 (11) in total across phases |
| orchestrator between dispatches | 7.2 | 6.1 | — |
| lab | 3.8 | 3.7 | reproduce/baseline 2.2 (12), hypotheses 0.2 (2) |
| guards and delivery, verification, plan | 4.9 | 4.9 | — |

**The floor.** Model implementation time with no command running is 40 of 108 minutes on a ~1,000-line, 3-task change; no narrowing of checks reaches it. Together with the Lab, planning and the orchestrator's turns (≈ 18 min of agent time), about **58 minutes of this run is agent time**, which the engine's rules do not spend.

**A realistic target for a mealie4-05-class item (multi-file fix, ~1,000 lines, security-routed):** the impacted re-run would have replaced 32.9 min of reviewer full-suite runs with ≈ 11 × 0.5 = 5.5 min (−27 min); skipping the behavior diff's probe runs when the configuration names no app saves ≈ 10 min (not a gate change); a review bound that also covers security-routed tasks once the security reviewer has approved would remove the 4 rejection re-rounds' re-runs (included above). That puts the run at **≈ 70 min (108 − 37)** with the same agent time, and its median across the seven at **≈ 45–50 min** (the median run spent proportionally less in reviewer re-runs). **Target: median ≤ 50 min and p90 ≤ 75 min per narrowed debug run on the two Mealie hard items**, to be checked against the recorded profiles of the next ten runs, not against this one run; the 15-minute figure is withdrawn as unreachable for items whose generation alone takes 40 minutes (it may hold for the quick track's single-file changes, where the full suite is the only large cost).

## 5. Limits (to register with the implementation)

- The impacted set is as good as `impact`'s map: a test reached through a dynamic import, a fixture file, a data file or an environment variable is outside it; the owner's full run on the same tree is what covers those, and N1 pins that the tree binding is what makes it safe.
- The fingerprint covers tracked and untracked files of the tree but not the environment (installed packages, a database file outside the tree); a change of environment between the owner's run and the review is invisible to it, as it is today.
