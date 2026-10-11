# Independent review, round 2: TK-6 repair (commit 30061e5 on cb73d42, 0.3.4)

Reviewed: `30061e5` on `worktree-agent-a24e7b0bc6643d426` (worktree
`/home/user/ECCode/.claude/worktrees/agent-a24e7b0bc6643d426`), the engineer's answer to `REVIEW.md`
(round 1, findings F1–F8). I did not write either commit. git 2.43.0, Node 22.22.0, Linux. Nothing in the
repository, the worktree, `examples/rescuestock/**` or any existing `.eccode/` directory was modified; the
pilot record was copied out of git objects (`git archive 220d3fa`) into a scratch repository for replay.
Scratch copies here: `fix2/` (30061e5), `red1/` (30061e5 tests over cb73d42 code), `red0/` (30061e5 tests
over 0.3.3 code), `patched/` (a one-line probe variant, never proposed as the fix). Probes: `probe-r2.js`,
`probe2-r2.js`, `probe5.js`–`probe9.js`, outputs `*.out`, `summary-r2.txt`; suite log `r2-npm-test.log`.

## Decision: changes required

Most of round 2 is right and verified: F3 and F4 are fixed (every odd name I tried now hashes like
`git hash-object -- <path>`, including control bytes, DEL, CR, newline, leading/trailing quotes and
spaces); F5's tests exist and are red on the old code; the pilot's record replays to a byte-identical
`state.json` under the new reducer; the F2 refusal cannot touch a run recorded before 0.3.4; the suite is
291/291 on my run.

Two things block. **R2-1:** the new "inside git" test is `gitHead()`, i.e. "HEAD resolves". Inside a work
tree whose HEAD does not resolve — a fresh repository before its first commit, or one `git checkout
--orphan` / `git symbolic-ref` away, both allowed by the guard — `treePin` returns `{}`: no tree, no marker,
no warning, and a submission records no commit. A run recorded that way is cited like a pre-0.3.0 run (the
stale check skips it), so the F2 refusal is bypassed with one git command, and a commit-less approval made
that way on 0.3.4 is only a *warning* (F1). The CHANGELOG and R28/R30 claims ("inside git, a run whose
digest could not be computed is recorded with `treeUnavailable`", "a submission keeps its commit whatever
the digest") over-claim for that case. **R2-2:** the F1 gap text and the delivery report state the cause
("the tree digest was unavailable when it was submitted, TK-6") as fact; for an unborn HEAD (the
engineer's own test fixture) or a record begun on an engine older than 0.3.0 the cause is something else.
Both are small to fix. The warning-not-blocker choice for F1 is acceptable once R2-1 is fixed (R2-5).

## Round-1 findings: resolution

| Round 1 | Claimed | Verified |
|---|---|---|
| F1 (Major) R30 consequence undocumented | Gaps reported, report qualified, docs | Resolved in code and docs; cause wording over-claims (R2-2); gap list follows gate order, not approval order (R2-3) |
| F2 (Major) silent null digest | `treePin`, warnings, refusal | Resolved for a null digest with HEAD resolving; **not** for an unborn HEAD inside a work tree (R2-1) |
| F3 (Minor) trimmed top/prefix | `gitPathLine` (also `workingTreeStatus`) | Resolved: trailing-space repository, sibling impostor and leading-space directory now oracle-equal (`probe2-r2.out`, tests 5–6) |
| F4 (Minor) stdin-paths protocol | `cQuote` every line | Resolved: 10 odd names incl. `\x01\x02\x1f`, `\x7f`, tab, `\\n` literal, `\"`, zero-width space, newline+CR all oracle-equal (`probe5.out`) |
| F5 (Minor) test gaps | 6 new nested-digest cases | Resolved: 9/10 red on 0.3.3, 4/10 red on cb73d42 (the F3/F4 cases), 10/10 green |
| F6 (Info) unseen bytes | Residual 16 | Documented accurately (assume-unchanged, skip-worktree, ignored dir, submodules, symlinks) |
| F7 (Info) `gitChangedFiles` quoting | Deferred to TK-7 | Accepted as a separate task |
| F8 (Info) | — | — |

## Findings

### R2-1 — Major — an unborn HEAD inside a work tree is treated as "outside git": silent, unmarked, and a bypass of the F2 refusal

- Where: `lib/project.js` `treePin` (`return gitHead(root) ? { treeUnavailable: true } : {}`) and
  `treeDigest` (`if (!gitHead(root)) return null;`, although its own comment says the digest is
  "deliberately independent of HEAD"); `lib/gates.js:188-189` (`const commit = gitHead(...); if (commit)
  …`), so no commit and no marker either.
- Evidence (`probe8.out`):
  - Fresh repository, one staged file, `rev-parse --is-inside-work-tree` = `true`: `treeDigest=null`,
    `treePin={}`; `eccode evidence run --json` exits 0 with `tree` and `treeUnavailable` both absent and no
    warning on stderr.
  - Same task flow twice: claim, write bytes A, run the check, write bytes B, complete citing the run.
    *normal*: refused, "ran on different bytes". *orphan* (HEAD pointed at an unborn branch for the run,
    then restored — what `git checkout --orphan x` … `git checkout main` does): **completion accepted on
    bytes the check never saw**. The guard's `gitRecordRisk` (`scripts/hooks/guard.js:376-392`) does not
    object to `checkout --orphan` or `symbolic-ref`.
  - `tests/tree-pin-unavailable.test.js` itself creates commit-less approvals on 0.3.4 with
    `withUnbornHead` and `gates.submit` succeeds without a warning; F1 then reports them only as warnings.
  - `probe9.out`: with the HEAD precondition removed (scratch copy only), the digest on an unborn HEAD
    equals the oracle and moves on an edit, so nothing else in `treeDigest` needs HEAD.
- Why Major: it is the residual-16 failure mode (pinning off, nothing said) in the most common place a new
  project starts, it re-opens the R28 refusal the round was built to add, and it is the one path by which a
  0.3.4 actor can still mint a commit-less approval, which R2-5's acceptance of warnings depends on.
- Resolution: decide "inside git" with `git rev-parse --is-inside-work-tree` (or `--git-dir`), not HEAD;
  drop the `gitHead` precondition from `treeDigest`; when inside a work tree and HEAD does not resolve,
  `gate submit` either refuses ("make the first commit") or records `commitUnavailable: true` and warns,
  and such an approval's gap is then not just a warning. Add a test with an unborn HEAD for `evidence run`,
  completion and `gate submit`. Correct the CHANGELOG/R28/R30 wording to match.

### R2-2 — Minor (required: user-facing claim) — the gap text and the release sentence assert TK-6 as the cause

- Where: `lib/delivery.js` `baselineGap` ("which recorded no commit (the tree digest was unavailable when
  it was submitted, TK-6)") and `releaseSentence` ("because the tree digest was unavailable (TK-6)").
- Evidence: a submission records no commit when HEAD did not resolve (fresh repository: the test
  fixture `recordWithCommitlessApprovals` produces exactly this and its gaps carry the TK-6 sentence), when
  the record was begun on an engine before 0.3.0 (commits are recorded since 0.3.0, CHANGELOG line 77) and
  continued on 0.3.4 (`recordsPins` turns true at the first new run), or under TK-6 (0.3.0–0.3.3, null
  digest). For the pilot the attribution happens to be right (`probe7.out`); in general it is a guess
  printed in `audit`, `reconcile` and the final handoff as fact.
- Resolution: state the fact and the possible causes, e.g. "recorded no commit (HEAD did not resolve, the
  engine predates 0.3.0, or 0.3.0–0.3.3 dropped it with an unavailable digest, TK-6)"; or record the
  engine version per event and attribute only when known.

### R2-3 — Minor — baseline and gaps follow `gateOrder`, not approval order (pre-existing; made live by TK-6's history)

- Where: `lib/delivery.js` `releaseTreeChanges` (`for (const id of state.gateOrder) … if (!baseline)`,
  `else if (s && !baseline) commitless.push`); rework gates are inserted after every plan phase
  (`lib/reducer.js:330-331`).
- Evidence (`probe6.out`, synthetic states over a real history C0→C1→C2 where C2 adds unpinned changes):
  - B (the pilot's shape): rework-1/3 approved commit-less *before* phase:e's commit C2, but after it in
    `gateOrder` → gaps list `architecture, phase:d` only; the reworks are not named. For the pilot,
    `probe7.out` lists all nine approved gates today; once `phase:e-payments` is approved with a commit,
    `phase:rework-1..3` drop out of the list.
  - A: rework-4 approved with commit C1 before phase:e approved with C2 → baseline is C2 (first in
    `gateOrder`), the C1→C2 changes (`app.js`, `other.js`) are not reported; the same approvals in time
    order report both. Without any commit-less gate the unqualified release sentence would then
    over-claim (pre-existing since 0.3.1, R38).
- The qualified sentence's effect clause ("changes made before that commit that no approval pinned were not
  compared") stays true; the gate list is incomplete.
- Resolution: pick the baseline as the earliest approved commit by approval time (or ancestry: `git
  merge-base --is-ancestor`), and collect commit-less gaps by `approvedAt` before it. Can be a follow-up
  task if recorded in residual 16; the pilot will hit case B.

### R2-4 — Minor — `deliver` still drops the release commit silently when the digest is null

- Where: `lib/delivery.js:446-448` (`const release = commit && tree ? { commit, tree } : null`), the
  pattern round 2 removed from `gate submit`; `delivery.completed` then carries no commit and the report has
  no release sentence (while the limitations line says "see the release sentence above").
- Resolution: keep the commit and mark `treeUnavailable` with a warning, or refuse delivery inside a work
  tree while the digest is unavailable (the user can fix git; it is not a permanent block). Name it in
  residual 16 either way.

### R2-5 — Info (judgement) — warning rather than blocker for release-baseline gaps: acceptable, conditional on R2-1

- A blocker as implemented would be permanent: gaps are derived from past approvals that no submission
  can repin, so every project with TK-6 history (the pilot) would be undeliverable. Pinned artifacts are
  still hash-checked; the gap only affects unpinned files changed before the baseline; it is now printed by
  `audit` (still exit 0), `reconcile` (`release-baseline` warning), the release sentence, the limitations
  list and `releaseBaselineGaps` in the JSON handoff. That is loud, which is what TK-6 lacked.
- It is unsafe only if a 0.3.4 actor can still create commit-less approvals on purpose, and R2-1 shows one
  can. With R2-1 fixed, gaps are historical only and a warning is the right severity.
- Recommended (not required): make the user, not the delivery-lead, accept the reduced claim, the R31
  pattern — e.g. deliver refuses while gaps exist unless a user-accepted risk names `release-baseline`;
  and show the gaps to the verification reviewer (today `checkReview` filters them out silently).

### R2-6 — Info — where the marker is recorded without a warning, and where nothing is compared

- `reconcile`'s re-run (`lib/reconcile.js:124`) and improvement runs (`lib/memory/improve.js:140`) go
  through `runCommand` and get the marker, but only `evidence run` and `gate submit` in `bin/eccode.js`
  print the warning. Completion and review neither warn nor refuse when the *current* digest is null
  (residual 16 says so). `audit`/`status` do not count marked runs. Suggest a count in `audit`.

### R2-7 — Info (pre-existing) — a non-UTF-8 file name is invisible to the digest

- `probe5.out`: an untracked file named `lat\xe9.txt` leaves the digest unchanged. git's `-z` bytes are
  decoded as UTF-8 by `execFileSync(…, { encoding: 'utf8' })`, the name becomes U+FFFD, `statSync` fails,
  the entry is dropped (a tracked one is dropped once dirty). Linux only. Worth a line in residual 16.

### R2-8 — Info — what checks out

- **Tests.** Round-2 tests: 17/17 on 30061e5; 6 pass / 11 fail on cb73d42 code (the four F3/F4 digest
  cases and all seven `tree-pin-unavailable` cases); 1 pass / 16 fail on 0.3.3 code. Full suite:
  tests 291, pass 291, fail 0, cancelled 0, skipped 0 (62.7 s, `r2-npm-test.log`); the worktree was clean
  before and after. The engineer's `r2-green.log` shows 16/17 (case 17 failing on an earlier wording of the
  release sentence); `r2-full2.log` (291/291) is the final state and matches my run.
- **Digest regression battery** (`summary-r2.txt`): 89 of 92 rows oracle-equal; the 3 that differ are the
  F6 by-design rows (clean submodule, assume-unchanged, skip-worktree). Root-level projects identical to
  0.3.3 in 23/23 regular root scenarios; copies/`CM`, trailing-space top, `.gitattributes` oracle-equal.
- **Replay.** The pilot's committed record (944 events) audits OK and rebuilds to a `state.json`
  byte-identical to the committed one under both 0.3.3 and 30061e5 (`probe7.out`). The reducer change
  emits `tree` only when present; old events carried both or neither and `undefined` never serialised, so
  older `stateHash`es are unchanged.
- **F2 refusal and old records.** The refusal tests `e.treeUnavailable`, a field only 0.3.4 writes, and
  only in `tasks.complete` and `checkReview`, which run on new commands, never on replay; no audit or
  reconcile path re-validates past completions or approvals. The pilot's 327 tree-less runs carry no
  marker and are skipped as before. (That same skip is the R2-1 bypass.)
- **Callers.** `treeDigest`: `gates.checkReview`, `tasks.complete`, `delivery.submissionTreeDigest`
  unchanged; `evidence.runCommand` and `gates.submit` moved to `treePin`. New `treePin` callers beyond
  those two: none in code; indirect via `reconcile` and `memory/improve` (R2-6). `unreviewedChanges`
  consumers all handle `unpinned`: `bin` audit, `reconcile.inspect`, `checkReview` (verification),
  `preconditions`.
- **Docs.** CHANGELOG test counts (10, 7, 291; "nine of ten" on 0.3.3, "four" on cb73d42, "all seven" on
  cb73d42) verified. R28/R30 rows cite "F2 …" (4) and "F1 …" (3), matching. Residual 16 is accurate except
  where R2-1 and R2-2 apply.

## What I ran

- `git show 30061e5` (code, tests, docs) and the engineer's logs `r2-red-cb73d42.log`, `r2-red-pin.log`,
  `r2-red-033.log`, `r2-green.log`, `r2-full2.log`.
- `node --test` on the two new test files in `fix2/`, `red1/`, `red0/`; `npm test` in the worktree.
- Probes: `probe-r2.js` (round-1 battery against 30061e5), `probe2-r2.js`, `probe5.js` (odd names,
  non-UTF-8), `probe6.js` (gate order), `probe7.js` (pilot replay from git objects), `probe8.js` (unborn
  HEAD / orphan bypass), `probe9.js` (digest without the HEAD precondition, scratch copy).

## What I did not test

- Windows and macOS (quoting with `\r\n`, case folding, NFD); the CLI `deliver` end to end with gaps (I
  checked `preconditions`, `buildReport`'s inputs and the code path, not a full delivery); concurrency;
  whether the guard should block `git checkout --orphan`/`symbolic-ref` (a guard change is not proposed:
  the engine-side fix in R2-1 is enough).
