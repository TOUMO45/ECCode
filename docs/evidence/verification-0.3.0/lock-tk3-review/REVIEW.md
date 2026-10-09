# Independent review: TK-3 Windows lock-contention repair (commit e488f38)

Reviewed: `e488f38` on `eccode/win-lock-retry` against base `6a2b869` (0.3.2), worktree
`scratchpad/winlock`. Reviewer did not write the change. Node 22.22.0 / libuv 1.51.0, Linux.
Probes and logs: `docs/evidence/verification-0.3.0/lock-tk3-review/probes/`.

## Decision: changes requested

The `withLock` change itself is sound: the new codes are the right Windows codes, every
contended path is bounded by `timeoutMs` except one corner (F3), the callback cannot run
twice, the release retry is harmless, and the memory store's `lock()` gets the same
behaviour for free. The eight regression cases do fail on the base (7/8) and pass on the
fix, and the mocks restore `fs` on every exit path.

What blocks approval is the attribution, not the code. Reading libuv's Windows sources
(fetched into `probes/`) shows that on the CI runner (Server 2025, Node 22, libuv ≥ 1.49)
`unlink` uses POSIX delete semantics, which removes most of the "delete pending → EPERM on
open" window the change is built around, while a second race with exactly the observed
shape (`exit 1`, raw fs error) exists in the tree and is untouched: every `risk add` reads
`state.json` **outside** the lock (`lib/authority.js:116`) while the writer inside the lock
renames over it with `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which Windows refuses with
`EPERM` when the target has any open handle. I rate the rename race at least as likely as
the lock race. The CHANGELOG and threat-model text present the lock change as the TK-3
repair; if TK-3 is closed on it and the flake continues, the record is wrong. Required
changes are F1 and F2; F3–F6 are small and optional.

## Findings

### F1 — Medium — the more likely cause is untouched: rename over `state.json` while a sibling reads it outside the lock

- Where: `lib/authority.js:116` (`const preview = store.state();` before `store.commit`),
  `lib/store.js:222` (`writeJson(this.stateFile, next)` inside the lock) →
  `lib/util.js:35-40` (`writeFileAtomic`: `fs.renameSync(tmp, file)`).
- Evidence:
  - `probes/probe-A.log`: one `risk add` performs `readFileSync(state.json)` and
    `readFileSync(events.jsonl)` **outside** the lock, then inside the lock one
    `renameSync(state.json.<tmp> -> state.json)`. Six concurrent children therefore race a
    reader's open handle on `state.json` against the writer's replace-rename.
  - `probes/libuv-fs.c` (v1.49.0) `fs__rename`: `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`,
    no `FILE_RENAME_POSIX_SEMANTICS`. A replace-rename whose target has an open handle
    fails with `ERROR_ACCESS_DENIED`, which `probes/libuv-error.c:158` maps to `UV_EPERM`:
    the classic `EPERM: operation not permitted, rename` of Node on Windows. It is a raw
    error, so `bin/eccode.js:529` prints `internal error` and exits 1 — the shape seen in
    runs 66/67/68/92.
  - `probes/libuv-fs.c:1086-1214` `fs__unlink_rmdir`: on Windows 10 1607+/Server 2016+ the
    unlink sets `FILE_DISPOSITION_POSIX_SEMANTICS`, so the holder's release removes the name
    at once even while a contender's `stat` handle is open; the contender's next
    `CreateFile(CREATE_NEW)` then succeeds. The two-contender "delete pending" story in the
    test and CHANGELOG mostly cannot happen on the runner. (`EBUSY`/`EPERM` from a scanner
    or indexer holding the lock file without `FILE_SHARE_DELETE` remains possible, so the
    change is still worth keeping; it is just not the demonstrated cause.)
  - The engineer's own alternatives list says "rename of state.json refused by a scanner";
    the realistic refuser is not a scanner but the project's own sibling processes.
- Reproduction (Windows only; cannot run here): six `risk add` children on one record,
  stderr captured — the new `spawnCli` will print either `EPERM ... open '.lock'` (lock
  hypothesis) or `EPERM ... rename '...state.json...'` (this finding).
- Resolution: (a) bound-retry the `renameSync` in `writeFileAtomic` on `EPERM`/`EACCES`/
  `EBUSY` (same `LOCK_CONTENDED` set, same 25 ms poll, same kind of cap; graceful-fs does
  exactly this for Windows), and/or take the preview read in `commitReserved` under the
  lock; (b) reword CHANGELOG 0.3.3 and threat-model item 7 so the lock change is "one of two
  candidate causes, decided by the next captured stderr", and do not close TK-3 on this
  commit alone. Either (a)+(b) or (b) with a follow-up task is acceptable.

### F2 — Medium — a permanent `EACCES`/`EPERM` now looks like contention and the timeout message loses the code

- Where: `lib/util.js:95` (`LOCK_CONTENDED` test), `lib/util.js:107-108` (LOCK_TIMEOUT).
- Evidence: `probes/probe-C.log` C2 — with `open` refusing `EACCES` for good, the call
  ends after `timeoutMs` with `[LOCK_TIMEOUT] Could not acquire lock … within 300ms`;
  `message names EACCES: false`. On Linux/macOS `EACCES`/`EPERM` from `open('wx')` is never
  contention (a read-only `.eccode/`, a root-owned lock file); before the change the CLI
  reported the real error at once, now it stalls 10 s and reports exit 2 with a misleading
  message. The CHANGELOG's "every other error code is still thrown at once" is only true of
  codes outside the set.
- Resolution: remember the last contended error and put it in the LOCK_TIMEOUT message
  and `details` (`last error: EACCES open …`); optionally widen the set beyond `EEXIST`
  only when `process.platform === 'win32'` (the tests would then stub the platform).

### F3 — Low — the stale branch's `continue` still skips the timeout check

- Where: `lib/util.js:98-101`.
- Evidence: `probes/probe-B.log` — with `stat` reporting a stale file, `unlink` returning
  success without removing it and `open` refused with `EPERM`, `withLock(..., {timeoutMs:
  300})` never returns; killed by `timeout -s KILL 5` (exit 137). The base has the same
  `continue` after a stale unlink, but the new codes widen the entry condition (an `EPERM`
  open now reaches it). On Windows with POSIX delete I could not construct a real trigger
  (a delete-pending file refuses the unlink's open, which the fix does bound), so Low.
- Resolution: drop the `continue`; after a successful stale unlink fall through to the
  timeout check (with or without the sleep).

### F4 — Low — a refused `writeSync` after a successful `open` loops on the process's own lock

- Where: `lib/util.js:91-95`.
- Evidence: `probes/probe-C.log` C1 — `writeSync` throwing `EPERM` is caught by the
  contention branch: the lock file (ours) exists with a fresh mtime, the fd is never
  closed (`leaked: true`), the loop polls until `LOCK_TIMEOUT`, `fn` never runs and the
  lock file is left for the next writer to wait on. Unreachable before the change (`EEXIST`
  is not a write error); unlikely on Windows but possible (`EBUSY` from a filter on a new
  handle). Resolution: on a write failure close the fd and unlink before rethrowing, or
  move `writeSync` out of the try.

### F5 — Info (pre-existing, unchanged) — the release deletes whatever file is at `lockFile`

- Where: `lib/util.js:119-127`; same unconditional unlink in the base.
- Evidence: `probes/probe-E-e488f38.log` and `probes/probe-E-base6a2b869.log` (identical):
  holder A outlives `staleMs`, B breaks the lock and enters, A's release deletes B's lock,
  C enters while B is still inside. The retry loop widens the window by at most 10 × 25 ms
  and only when an unlink is refused; an unlink cannot "succeed but report an error" in
  libuv (`fs__unlink_rmdir` reports success only when the disposition call succeeded), so
  the retry cannot delete a contender's fresh lock in a case the base did not already. Not
  blocking; a future hardening is to verify the lock's pid before unlinking.

### F6 — Low — `spawnCli` never reads the child's stdout

- Where: `tests/helpers.js:215-223`.
- Evidence: `spawn` with default stdio pipes stdout and only stderr is consumed. Node's
  `flushStdio` resumes unread pipes on exit so `'close'` still fires, but a child that
  prints more than the pipe buffer (64 KiB) before exiting would block and the test would
  hang. `risk add` prints one line, so no effect today. Resolution: `stdio: ['ignore',
  'ignore', 'pipe']` or collect stdout as well (useful in the failure message anyway).

### F7 — Info — tests: mocks, timing, platform

- `tests/lock-transient-errors.test.js:32-39`: `t.after` restores `fs` before `rmSync`;
  `after` hooks run on failure as well, so no mock survives a failing case. The mocks only
  intercept calls on the lock path and `node --test` runs each file in its own process
  with tests sequential by default, so other files are unaffected.
- Timing: case 5 polls at ≥ 25 ms, so `unlinks ≤ 12` holds for any `timeoutMs: 200` run
  (max 9 on a fast machine, fewer on a slow one); `elapsed < 2000` and `< 2000` acquisition
  bounds leave > 25× headroom. Nothing in the file can flake on a slow machine.
- `t.after` needs Node ≥ 18.8; CI's floor is 18.17. On Node 18/20 `rmSync` is the JS
  rimraf, which destructures `fs.unlinkSync` lazily; restoring before `rmSync` (as done)
  avoids it capturing a mock. Good.
- The two-contender case (`:77`) is a scripted trace, not a Windows observation; see F1.

### F8 — out of scope, found in passing — `sleepSync` is not exported but the CLI imports and calls it

- `lib/util.js` exports block has no `sleepSync`; `bin/eccode.js:10` destructures it and
  `bin/eccode.js:118` calls it on `EAGAIN` in the stdin reader, which would throw
  `TypeError`. Queued as a separate task; not part of this change.

## Windows-cause assessment

- libuv error mapping (`probes/libuv-error.c`, v1.49.0): `ERROR_ACCESS_DENIED` → `EPERM`
  (158), `ERROR_PRIVILEGE_NOT_HELD` → `EPERM` (159), `ERROR_SHARING_VIOLATION` and
  `ERROR_LOCK_VIOLATION` → `EBUSY` (85, 87), `ERROR_NOACCESS`/`ERROR_CANT_ACCESS_FILE`/
  `ERROR_ELEVATION_REQUIRED` → `EACCES` (72-75), `ERROR_FILE_EXISTS`/`ERROR_ALREADY_EXISTS`
  → `EEXIST` (97-98).
- `fs__open` (`probes/libuv-fs.c:400+`): `'wx'` → `CREATE_NEW` with
  `FILE_SHARE_READ|WRITE|DELETE`; an existing file gives `ERROR_FILE_EXISTS` → `EEXIST`; a
  delete-pending file gives `STATUS_DELETE_PENDING` → `ERROR_ACCESS_DENIED` → `EPERM`, so
  `EPERM` (not `EACCES`) is the delete-pending code. `EBUSY` is a sharing violation (a
  handle opened without share flags: antimalware, indexer). `EACCES` on the lock file is
  the least likely of the three; harmless to include.
- `fs__unlink` uses POSIX delete on the runner's OS, so the holder's own release does not
  leave a delete-pending name for a contender's `stat` handle. The hypothesis in the
  CHANGELOG ("a file another process has just unlinked (delete pending)") therefore needs
  an external handle without `FILE_SHARE_DELETE` to be true; that is plausible on
  `windows-latest` with Defender on, but it is not the mechanism the test scripts.
- The engineer's alternatives: `rename` of `state.json` refused — plausible and, per F1,
  caused by the project's own readers, not only a scanner; `appendFile` `EBUSY` — possible
  only with an external non-sharing handle (readers in the tree open with full sharing);
  `mkdir` `EPERM` — `ensureDir` on an existing directory does not fail on Windows, unlikely.
- Masking: the change cannot hide the rename race (a different syscall, still thrown),
  but it hides permission problems on the lock file behind a 10 s `LOCK_TIMEOUT` (F2).
  70 % for the lock hypothesis is too high; I would put the lock race and the rename race
  at roughly 30 % and 50 %, with the captured stderr deciding.

## What I ran

- `npm run check` on `e488f38`: 265 tests, 265 pass, 0 fail (`probes/npm-check.log`).
- The new test file against base `lib/util.js` in a detached worktree of `6a2b869`:
  7 fail, 1 pass (the ENOSPC case) (`probes/base-6a2b869-new-test.log`). The temporary
  worktree was removed afterwards.
- Probe A (`probe-A-reads-outside-lock.js`): record reads outside/inside the lock during
  `risk add`. Probe B (`probe-B-stale-continue-spin.js`): stale-branch spin. Probe C
  (`probe-C-writesync-and-eacces-message.js`): write failure after open; EACCES message.
  Probe E (`probe-E-release-deletes-contender-lock.js`) on both trees: release vs. a
  breaker's lock. Probe F: the `writeFileSync(events.jsonl)` seen in probe A is Node's
  `appendFileSync` implementation (`node:fs:2519`), inside the lock — not a log rewrite.
- Read `withLock` line by line (`lib/util.js:71-129`), `Store.commit`/`state()`/
  `repairTail`, `commitReserved`, `records.js` `lock()`, `bin/eccode.js` exit handling,
  `.github/workflows/ci.yml`, and libuv `src/win/error.c` and `src/win/fs.c` at v1.49.0.

## What I did not check

- Nothing ran on Windows; the libuv reading is of v1.49.0 sources (Node 22.23 on the runner
  ships ≥ 1.49; local is 1.51.0), and the `MoveFileEx`-with-open-target behaviour is from
  the libuv code plus documented Windows semantics, not a live reproduction.
- The suite on Node 18.17 and 20 (only 22.22 here); I reasoned about `rmSync`/`t.after`.
- The CI logs of runs 66, 67, 68 and 92 (no access from here).
- The spawn tests under CPU load, or whether `stderr` from a child killed by the OS is
  complete; `assertAllExitZero` prints what it got.

---

# Round 2: commit 901f8a0 (`git diff e488f38..901f8a0`)

Same reviewer, same rules. Node 22.22.0 / libuv 1.51.0, Linux. New logs and probes under
`probes/` (`npm-check-round2.log`, `prev-e488f38-*.log`, `probe-G-*`).

## Decision: approved

Every round-1 finding that needed a change is resolved by code that I read line by line
and exercised, the two regression files fail (or hang, for the F3 case) on e488f38's
`lib/util.js` and pass on 901f8a0, the CHANGELOG and threat-model item 7 now present the
rename race and the lock race as two bounded candidate causes with TK-3 kept open until a
Windows run captures the error, and the one optional item (the preview read under the lock)
is recorded as a follow-up rather than claimed. The three new observations below are
informational; none needs a change before merge.

## What I ran (round 2)

- `npm run check` on 901f8a0: **274 tests, 274 pass, 0 fail** (`probes/npm-check-round2.log`).
- Both regression files against e488f38's `lib/util.js` in a detached worktree of e488f38
  (removed afterwards), run file by file because the F3 case spins there:
  - `tests/write-atomic-retry.test.js`: **0 pass / 5 fail** (`probes/prev-e488f38-write-atomic.log`),
    matching the claim.
  - `tests/lock-transient-errors.test.js`: the original eight cases pass (8/8,
    `probes/prev-e488f38-lock-orig8.log`); the F2 case fails on the message regex
    (`probes/prev-e488f38-lock-F2.log`); the F4 and F8 cases fail
    (`probes/prev-e488f38-lock-tests.log`, second run); the F3 case never returns — the
    whole file run directly was killed by `timeout -s KILL 60` (exit 137, same log, first
    line), consistent with round-1 probe B. A plain `node --test` of both files hung on it,
    which is why the combined log `prev-e488f38-round2-tests.log` is empty.
- Probe G (`probe-G-rename-retry-edges.js`, `probe-G.log`) on 901f8a0, for the questions
  asked: target directory vanished, rename landed-but-reported-refused, success-path temp
  files, bound.

## Round-1 findings: resolution

| Finding | Status | Evidence |
|---|---|---|
| F1 rename over `state.json` | Resolved (code + attribution) | `lib/util.js:34-74` `writeFileAtomic(file, content, { retryMs = 1500 })`: retries `renameSync` on `FILE_IN_USE = {EPERM, EACCES, EBUSY}` at 25 ms until `retryMs`, then unlinks the temp (best effort) and rethrows the original error; any other code is thrown at once with the temp removed. Five mocked cases, 5/5 fail on e488f38. CHANGELOG 0.3.3 and threat-model item 7 reworded: two candidate causes, rename rated likelier, TK-3 open, decided by the captured stderr. The preview read in `commitReserved` is still outside the lock; recorded in the CHANGELOG as a follow-up, which is what round 1 allowed. |
| F2 timeout masks the code | Resolved | `lib/util.js:132-151`: `last` is the open error, overwritten by a non-`ENOENT` stat/unlink error; LOCK_TIMEOUT message ends in `(last error: <code> <message>)` and `details.lastError = {code, syscall, message}`. `last` is always defined at the timeout check (it is set on every contended iteration before the check). Test fails on e488f38, passes now. |
| F3 stale `continue` spin | Resolved | `lib/util.js:142`: the stale unlink no longer `continue`s; the iteration falls through to the timeout check and the 25 ms poll. Test (stat stale, unlink no-op, open EPERM) hangs on e488f38 and times out at ~200 ms on 901f8a0. Cost: one extra 25 ms sleep after a stale break, acceptable. |
| F4 write failure after open | Resolved | `lib/util.js:155-163`: `writeSync` moved out of the acquisition loop; on failure the fd is closed, `releaseLock` removes our file, the error is rethrown unchanged. Test checks the fd is `EBADF` and the file is gone; fails on e488f38. |
| F5 release deletes whatever is at `lockFile` | Known, documented | Comment at `lib/util.js:168-171`, CHANGELOG "Known, unchanged (review F5)". Behaviour unchanged from 0.3.2; not blocking. |
| F6 `spawnCli` stdout not drained | Resolved | `tests/helpers.js:216-226` (`spawnCli`): `stdio: ['ignore', 'pipe', 'pipe']`, both pipes collected; `assertAllExitZero` (just below) prints both on failure. |
| F7 tests | No change needed | New cases follow the same mock/restore pattern (`t.after`, restore before `rmSync`; the F4 case restores `fs.writeSync` in its own `after`). Timing: F2 `timeoutMs: 100`, F3 `200` with `unlinks ≤ 12` (max 10 at 25 ms polls), F4 `< 500` for a path with no sleep; rename tests `< 1500` for two 25 ms sleeps and `[200, 2000)` with `2..12` attempts (probe G3b: 9 attempts, 202 ms). None can flake on a slow machine. |
| F8 `sleepSync` not exported | Resolved | `lib/util.js:320` exports it; the test asserts every name `bin/eccode.js` destructures from `lib/util` is a function. Fails on e488f38. (The separately queued task `task_f8c57c1f` for this is now redundant and can be dismissed.) |

## The rename retry, read for the questions asked

- **Temp file on success paths:** the temp is the rename's source, so a successful rename
  consumes it; probe G3a shows two consecutive writes leave no `*.tmp`. On the give-up and
  non-transient paths the temp is unlinked (G1: `ENOENT` thrown after 1 attempt, no temp
  because the directory itself is gone; G3b: `EBUSY` after 9 attempts, temp removed, target
  untouched).
- **A first rename that landed but was reported as an error:** a same-volume `MoveFileExW`
  is one `NtSetInformationFile(FileRenameInformation)` call, so it cannot report failure
  after replacing the target; the temp and the target are always in the same directory here,
  so the cross-volume copy-then-delete path never applies. If it did happen (probe G2, forced
  by the mock), the retry finds the temp gone and throws `ENOENT` from the second attempt
  after 26 ms while the target holds the new content — a reported failure for a write that
  landed, which is the safe direction for a caller that then re-reads. Informational, no change.
- **Bound:** `Date.now() - start > retryMs` is checked on every failure before sleeping, so
  the wait is at most `retryMs` plus one poll and one rename; `retryMs = 1500` is well inside
  the lock's `timeoutMs = 10000`, so six writers each paying it at worst still cannot push a
  contender into LOCK_TIMEOUT on that account alone.
- **Target directory vanished:** `renameSync` answers `ENOENT` (Windows:
  `ERROR_PATH_NOT_FOUND` → `ENOENT`), which is not in `FILE_IN_USE`, so it is thrown at once;
  the temp unlink also fails `ENOENT` and is swallowed (G1). Correct.

## New observations (informational, no change required)

- **N1 — POSIX permission errors on a rename now cost up to 1.5 s before the same error.**
  Every `writeFileAtomic` caller (`lib/store.js`, `lib/evidence.js:76`, `lib/delivery.js:403`,
  `lib/memory/improve.js:139-227`) retries `EPERM`/`EACCES` from the rename for `retryMs` on
  Linux and macOS, where the codes are never transient (a read-only directory fails earlier,
  at the temp `writeFileSync`, so the common case is unaffected). The error is thrown
  unchanged afterwards, so nothing is masked; it is a delay, and the CHANGELOG says so.
  A `process.platform === 'win32'` gate would remove it at the cost of platform-stubbing
  the tests; not worth it now.
- **N2 — the F3 regression test hangs rather than fails if the spin ever returns.** On
  e488f38 the case never returns and node:test produces no output for the file until killed.
  If the stale-path bound regresses, CI will show a job timeout instead of a named failing
  test. A future hardening is a per-file `--test-timeout` in `npm test` or a watchdog in
  the case; not needed for this merge.
- **N3 — `last.message` in the LOCK_TIMEOUT text repeats the lock path.** Node's fs errors
  already carry the path, so the message now names it twice. Cosmetic.

## Still not checked

Nothing ran on Windows; the claim that the Windows job decides between the two causes
rests on the captured stderr naming `open '.lock'` or `rename '...state.json'`. The suite
ran on Node 22.22 only.
