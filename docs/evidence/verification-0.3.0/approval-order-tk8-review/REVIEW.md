# Independent review: TK-8 approval order for reviewed files (commit 1db9a97, 0.3.5)

Reviewed: `1db9a97` on `tk8-approval-order` (worktree
`/home/user/ECCode/.claude/worktrees/agent-a24e7b0bc6643d426`), base `b74b357` (0.3.4 with TK-6 merged). I
did not write the change. git 2.43.0, Node 22.22.0, Linux. Nothing in the repository, the worktree,
`examples/rescuestock/**` or any existing `.eccode/` directory was modified; the pilot record was copied out
of git objects (`git archive b74b357 examples/rescuestock`) into a scratch repository. Scratch copies here:
`fix/` (1db9a97), `base/` (b74b357), `red/` (1db9a97 tests over the b74b357 engine). Probes:
`pilot-tk8.js` → `pilot-tk8.out`, `probe-cases.js` → `probe-cases.out`; suite log `npm-test.log`.

## Decision: approve

The orchestrator can merge `1db9a97`. The change is the minimal correct one: the only place that decides
which approval of a file is current (`unreviewedChanges`: the `latest` map and `deletedInReviewedWork`) now
walks `approvalOrder`, every other `gateOrder` walk in `lib/` was checked and does not decide currency, the
pilot's audit now passes for the right reason (the file's bytes are exactly the later approval's), and the
record replays byte-identically. The findings are informational.

## What I verified

- **The fix** (`lib/delivery.js`, the only engine file changed): `latest` is filled in approval order, so the
  last approval to pin a path wins; `deletedInReviewedWork(p, rank)` looks only at phase gates approved
  *after* the pinning approval; `pendingSubs` (gates under review) is order-independent and still walks
  `gateOrder`. The dropped `status !== 'approved'` test is redundant: `approvalOrder` returns approved gates only.
- **The other `gateOrder` walks** (`grep -rn gateOrder lib bin`), each read: `reconcile.js:42` and `:99`
  collect every approved review's evidence (the "latest" evidence there is chosen by its own `at`);
  `gates.js:151` checks architecture/design pins (one gate each, order-free); `gates.js:33-41` is the gate
  sequence itself; `tasks.js:97` `submittedContent` is an `any`; `project.js:251` `recordsPins` is an `any`;
  `status.js` and the report's gate table list; `rework.js:73` filters the verification gate;
  `preconditions` requires all approved. Other readers of approvals (`approvedSubmission`, `gates.js:268`)
  take a named gate. None decides which approval of a file is current. The CHANGELOG's account is accurate.
- **The only way to `approved` is an approving review** (`lib/reducer.js:131-135`), and an approved gate
  cannot take a new submission (`gates.submit` requires `in_progress`/`changes_requested`); only the user's
  reopen of an approved verification gate clears its approval (`gate.reopened` with `reopenedFrom`). So in a
  full log every approved gate has the `review.recorded` that `approvalOrder` keys on, and its sequence is
  that of the approval of the *current* submission.
- **Pilot at b74b357** (`pilot-tk8.out`): 1156 events; audit OK; rebuilt `state.json` byte-identical to the
  committed one under both engines. 0.3.4 reports `src/services/requests.js modified after approval
  (phase:rework-1)` as blocking; 0.3.5 reports nothing blocking. Why, from the record: requests.js is pinned
  by `phase:c-core-flow` (approval seq 445), `phase:rework-1` (seq 487) and `phase:d-extraction` (seq 808);
  its current bytes (`678b42cc…`) equal `phase:d-extraction`'s pin. Of 58 files pinned by two or more
  approved gates, exactly 3 change their current approval with the order: requests.js (the false failure),
  `src/config.js` and `.eccode/artifacts/plan/followups.md`, both still reported as pending re-review in
  `phase:e-payments`, now attributed to `phase:d-extraction` instead of `phase:rework-1`. No other entry
  changes. Every approved gate has its approving review in the log (no fallback used).
- **Synthetic cases** (`probe-cases.out`, real git history, both engines):
  1. three gates pin `src/a.js`, approved `phase:b` (v1) → `rework-1` (v2) → `phase:a` (v3), gate order
     `phase:a, phase:b, rework-1`: file at v3 — 0.3.4 reports "modified (rework-1)", 0.3.5 nothing; reverted
     to v2 — 0.3.4 nothing (a missed change), 0.3.5 "modified (phase:a)". Correct.
  2. `rework-2` approved on s1 (seq 3), changes requested on s2 (seq 8), approved on s3 (seq 12), and
     `phase:c` with other bytes approved at seq 6: file = s3 → nothing; with `phase:c` approved at seq 14
     instead → "modified (phase:c)". The sequence that counts is the approval of the current submission.
  3. identical `approvedAt`: with the full log, ordered by sequence (correct); with one approving review
     missing from the log, the fallback ties fall to gate order and the old false report returns (3b, see
     TK8-1); with distinct `approvedAt`, the fallback is correct (3c).
  4. deletion: a file pinned by `rework-1` and deleted by a phase approved after it — 0.3.4 "deleted after
     approval", 0.3.5 nothing (correct); re-created with new bytes → reported by both; re-created with the
     bytes `rework-1` reviewed → reported by neither (TK8-2).
- **Tests.** New file: 3/3 on 1db9a97; on the b74b357 engine cases 1 and 3 fail, case 2 passes (a
  regression guard), as stated. `npm test` in the worktree: tests 332, pass 332, fail 0, cancelled 0,
  skipped 0 (97.5 s), worktree clean before and after; matches the engineer's `full.log`.
- **Docs.** Version 0.3.5 in `package.json`, `.claude-plugin/plugin.json`, `marketplace.json`; CHANGELOG 0.3.5
  and the R30 row describe the defect, effect, fix and tests accurately (one wording slip, TK8-3).

## Findings

### TK8-1 — Info — the fallback order is all-or-nothing

- `approvalOrder` uses event sequences only when *every* approved gate's approving review is in the log;
  otherwise all gates are ordered by `approvedAt`, ties by gate order — where TK-8 reappears (case 3b). In
  a full log this cannot happen (above); it needs a state whose log lacks approvals and whose approval
  timestamps tie (a hand-built state, or `ECCODE_NOW` pinning the clock *and* a truncated log). Optional:
  rank gates with a sequence by it and only the rest by time.

### TK8-2 — Info (pre-existing, unchanged) — a reviewed deletion undone at old reviewed bytes passes

- A file an earlier approval pinned, whose deletion a later phase reviewed, re-created with exactly the
  earlier approval's bytes, is reported by neither engine (case 4c), and the release-tree diff from a
  baseline at which the file existed shows nothing either. The bytes were reviewed once; the latest review
  removed the file. Candidate for a follow-up (treat a reviewed deletion as the current "version" of the
  path); not part of TK-8.

### TK8-3 — Info — CHANGELOG wording

- "The first and third failed on 0.3.4 with the pilot's message": the third fails with
  `src/gone.js deleted after approval (phase:rework-1)`, the deletion counterpart, not the pilot's
  "modified after approval". Reword if convenient.

## What I did not test

- Windows and macOS; the CLI `deliver` end to end on the pilot copy (verified `unreviewedChanges`, which
  audit, reconcile, the verification approval and delivery share).
