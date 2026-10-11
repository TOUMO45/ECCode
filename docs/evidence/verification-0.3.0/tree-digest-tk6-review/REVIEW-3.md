# Independent review, round 3: TK-6 repair (commit 366c8ab on 30061e5, 0.3.4)

Reviewed: `366c8ab` on `worktree-agent-a24e7b0bc6643d426` (worktree
`/home/user/ECCode/.claude/worktrees/agent-a24e7b0bc6643d426`), the answer to `REVIEW-2.md` (R2-1..R2-7).
I did not write any of the three commits. git 2.43.0, Node 22.22.0, Linux. Nothing in the repository, the
worktree, `examples/rescuestock/**` or any existing `.eccode/` directory was modified; the pilot record was
copied out of git objects (`git archive 220d3fa`) into a scratch repository for replay. Scratch copies:
`fix3/` (366c8ab), `red2/` (366c8ab tests over 30061e5 code). Probes: `probe10.js` (bypass attempts),
`probe7-r3.js` (pilot replay), `probe6-r3.js` (approval order), `probe-r3.js`, `probe5-r3.js` (digest
batteries); outputs `*.out`; suite log `r3-npm-test.log`.

## Decision: changes required (one small change)

Every round-2 finding is resolved as claimed, and nothing regressed: 303/303 on my run, the pilot replays
byte-identically, its nine approved gates are reported as gaps in approval order with the possible-causes
text, and the HEAD-based bypasses I tried (orphan, detached at a real commit, HEAD on a deleted branch,
a linked worktree with a dangling HEAD) are now refused or pinned.

What remains is the same hole through a different door. **R3-1:** every git call in the engine inherits the
caller's environment, so `GIT_DIR=<anything that is not this repository>` (or `GIT_WORK_TREE` elsewhere)
on an `eccode` command makes the engine believe it is outside any work tree. The run then records neither
tree nor marker and prints nothing, a stale run cited later is accepted, and `gate submit` records an
approval with no commit and no marker — the commit-less approval R2-1's `NO_COMMIT` was added to make
impossible, which F1 then reports only as a warning. The guard refuses `ECCODE_*` assignments inline but
not `GIT_*`. The docs' new invariants ("every approval made on 0.3.4 inside a work tree has a commit";
"release-baseline gaps can only come from records written before 0.3.4 or outside any work tree") do not
hold under it. The fix is a few lines in the two git helpers.

## Round-2 findings: resolution

| Round 2 | Claimed | Verified |
|---|---|---|
| R2-1 (Major) unborn HEAD read as "outside git" | `insideWorkTree`; digest without HEAD; `NO_COMMIT` at submit and deliver | Resolved for HEAD states (`probe10.out`): orphan submit refused `NO_COMMIT`; runs on detached HEAD, a HEAD on a deleted branch and (tests) an orphan branch are pinned and refused as stale; a linked worktree with a dangling HEAD is inside=true, HEAD unresolved, digest computed. Not resolved for environment overrides (R3-1) |
| R2-2 (Minor) cause asserted | `NO_COMMIT_CAUSES` | Resolved: gap text, both release sentences and the limitations line state "recorded no commit" plus the three causes; no TK-6-as-fact wording left |
| R2-3 (Minor) gate order | `approvalOrder` by approving review's `seq`, fallback `approvedAt`, then gate order | Resolved: `probe6-r3.out` case A now reports the C1→C2 changes; case B lists `rework-1`, `rework-3` in time order; pilot gaps in seq order (below). The decision value checked (`'approve'`) is the one the reducer and the pilot use |
| R2-4 (Minor) deliver dropped the commit | `release = { commit, ...treePin }`, warning | Resolved (test via `-r` preload; reducer keeps `tree` absent and `treeUnavailable` set; replay test) |
| R2-5 (Info) warning vs blocker | Kept as warning, documented | Acceptable, but its premise (no new gaps can be minted) fails under R3-1 |
| R2-6 (Info) | `audit` counts marked runs | Resolved (`treeUnavailableRuns` in JSON, a line in text) |
| R2-7 (Info) non-UTF-8 names | Residual 16 | Documented |

## Findings

### R3-1 — Major (required) — `GIT_DIR` / `GIT_WORK_TREE` in the environment turn pinning off silently and mint commit-less approvals

- Where: `lib/project.js` `git()` and `lib/delivery.js` `gitOut()` call `execFileSync('git', …, { cwd })`
  with the inherited environment; `insideWorkTree`, `treeDigest`, `treePin`, `gitHead` all go through
  them. `scripts/hooks/guard.js:57` (`IDENTITY_ENV`) refuses inline `ECCODE_*` only.
- Evidence (`probe10.out`, library and CLI, round-3 code):
  - claim → bytes A → `evidence run` with `GIT_DIR=<nonexistent>` → bytes B → complete citing the run:
    **accepted on bytes the check never saw**; the run carries no tree and no marker. Same with
    `GIT_DIR=<project>/nope` and with `GIT_DIR=<project>/.git GIT_WORK_TREE=<another directory>`.
    Control, detached HEAD, HEAD on a deleted branch, and `GIT_INDEX_FILE=<new index>` are all refused
    as stale.
  - `gate submit` with `GIT_DIR=<nonexistent>`: accepted, `commit` absent, no marker — once approved, a
    release-baseline gap (a warning) on a 0.3.4 record.
  - CLI `evidence run` with `GIT_DIR=<nonexistent>` in its environment: exit 0, no tree, no marker, no
    warning on stderr.
- Scope: pre-existing and wider than TK-6 — the same override nulls `gitChangedFiles` (completion's
  ownership accounting is then skipped), `workingTreeStatus` (delivery's clean-tree check) and the
  release-tree diff. It is in scope here because round 3's invariants and R2-5's acceptance of warnings
  rest on "no 0.3.4 approval lacks its commit inside a work tree". It also bites legitimately: an
  `eccode` call made from a git hook inherits `GIT_DIR`/`GIT_INDEX_FILE` and today pins nothing.
- Resolution (any of, first preferred):
  1. Run git with the `GIT_*` repository-selection variables removed (`GIT_DIR`, `GIT_WORK_TREE`,
     `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
     `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_NAMESPACE`, `GIT_CONFIG_*`/
     `GIT_CONFIG_PARAMETERS`) in both helpers, so discovery always starts from the project directory; add
     a test with `GIT_DIR` and `GIT_WORK_TREE` set for `evidence run`, completion and `gate submit`.
  2. Belt and braces: when the record already pins (`recordsPins`) and git now says "not a work tree",
     record `treeUnavailable` and warn instead of `{}`, and refuse `gate submit` — a project does not
     leave git in the middle of a delivery.
  3. Optionally add `GIT_*` (and `NODE_OPTIONS`, which can preload code into the CLI) to the guard's
     inline-assignment refusal.
  Correct the two invariant sentences (CHANGELOG, R30, residual 16) or make them true.

### R3-2 — Info — `approvalOrder` falls back as a whole

- `bySeq` is used only when *every* approved gate has its approving review in the log; one missing review
  (a truncated or imported log) switches all gates to `approvedAt`, which is fine for real records (ISO
  timestamps from the same clock) and only ties on synthetic ones; the third tier (gate order) breaks
  ties. No finding, noted for the reader.

### R3-3 — Info — test-motivated indirection in `lib/delivery.js`

- `deliver` looks `project.treePin` up at call time so a `node -r` preload can replace it in a CLI child.
  Harmless (anyone who can preload code into the CLI controls it anyway), but it is a production shape
  chosen for a test; a comment says so. Also: my scratch copy without `examples/` fails
  `review-F2-F5b` case 12 ("old records are not judged retroactively"), which reads
  `examples/triage-desk` and `examples/groundwork`; it passes in the worktree. Not a defect of this commit.

### R3-4 — Info — the pilot's numbers, for the coordinator

- The pilot has 19 commit-less **submissions** and 9 **approved gates**; gaps are per approved gate, so 9
  are reported, not 19.

## Verified

- **Suites.** `npm test` in the worktree: tests 303, pass 303, fail 0, cancelled 0, skipped 0 (63.7 s,
  `r3-npm-test.log`); worktree clean before and after. Round-3 tests on 30061e5 code: 41 run, 28 pass,
  13 fail (all round-3 cases: R2-1 ×6 — two digest, three pin, one delivery — R2-2, R2-3 ×3, R2-4, R2-6, plus `review-F2-F5b` 12 which is the
  scratch-copy artefact above; the engineer's `r3-red-30061e5-final.log` shows 29/12 in the worktree,
  consistent). Engineer's `r3-green.log` 41/41 and `r3-full.log` 303/303 match my runs. Test counts in the
  CHANGELOG and R28/R30 rows (12, 15, 303) match the files.
- **Pilot replay** (`probe7-r3.out`): 944 events; audit OK; rebuilt `state.json` byte-identical to the
  committed one under 0.3.3, 30061e5 and 366c8ab. Gaps: `architecture, design, plan,
  phase:b-foundation, phase:c-core-flow, phase:rework-1, phase:rework-2, phase:rework-3,
  phase:d-extraction` — exactly the approving reviews' sequence (61, 133, 178, 345, 445, 487, 587, 653,
  808), reworks before `d-extraction` as approved; text: "which recorded no commit (possible causes: …)";
  no baseline yet, so the "not compared with any reviewed commit" effect clause.
- **Digest batteries** on 366c8ab: 89/92 oracle-equal (the 3 by-design F6 rows), root projects equal to
  0.3.3 in 23/23, 10/10 odd names (`probe-r3.out`, `probe5-r3.out`).
- **Bypass attempts that now fail** (`probe10.out`): detached HEAD at a real commit, HEAD on a deleted
  branch, `GIT_INDEX_FILE` pointed at a new index → stale refusal; orphan HEAD → `NO_COMMIT`; linked
  worktree with HEAD on a deleted branch → inside a work tree, HEAD unresolved, digest computed (so
  `NO_COMMIT` by the same code path). The "commit, run, `reset --hard`" probe reverted the uncommitted
  record itself (the guard refuses `reset --hard` anyway); the digest is content-only, so history moves
  cannot change it.
- **Callers.** `treePin`: `evidence.runCommand`, `gates.submit`, now `delivery.deliver`.
  `insideWorkTree`: `treeDigest`, `treePin`, `gates.submit`, `preconditions`, `releaseTreeChanges`.
  `unreviewedChanges` consumers unchanged and all handle `unpinned`. Reducer: `delivery.completed` and
  `gate.submitted` keep older events' output identical (`undefined` never serialised; pilot replay).

## What I did not test

- Windows and macOS; a full CLI delivery on the pilot copy; whether the guard, as deployed in a live
  session, lets `GIT_DIR=… eccode …` through (read from `guard.js:57` and `:341`, not executed through
  the hook); `NODE_OPTIONS` beyond noting it.
