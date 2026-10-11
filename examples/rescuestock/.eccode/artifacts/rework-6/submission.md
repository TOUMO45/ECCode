# phase:rework-6: submission

Author: delivery-lead (run `run-mv47mcbh-0148c892`). Gate: `phase:rework-6`. Date: 2026-10-11. Iteration 1.

## Why this rework exists

- **Decision:** `dec-mv46ovt6-01a662af` ("Owners for follow-ups outside phase G task ownership"). It opens rework-6, test-only, owner test-engineer, for two follow-ups in files that no phase G task owns.
- **FU-33** (TR-F-7, `followups.md` L229, L289, L343) concerns the RS-39 test "startApp removes an expired image at startup and another one on the next tick" in `test/api/uploads-retention.test.js`.
  - The test polls until the image **row** is gone, then checks `existsSync` on the **file** at once.
  - `sweepExpiredImages` (`src/services/retention.js`) deletes the row and its audit event first (L35-L37), and only then awaits `unlinkQuiet` on the file (L47). The test can observe that gap.
  - **Four recorded failures:** ev:ev-mv43j15k-01209f8b, ev:ev-mv445oiq-01166891, ev:ev-mv44rydx-01958248, ev:ev-mv451ngy-01bf3721.
- **FU-46** (`followups.md` L305) concerns SEC-B-1 in `test/timing/planner-sec-b1.test.js`.
  - The test asserted each of 1,008 planner calls under 100 ms by wall clock.
  - Under CPU contention it failed at 186.9 ms (ev:ev-mv43keu0-0102c57c) and under host steal at 327.9 ms (ev:ev-mv445oiq-01166891).
  - The follow-up asks for a bound on the p95 the test already computes, plus a generous single-call ceiling. The PLANNER_LIMIT assertion must stay exact.
- **Effect:** both are noise in every full-suite evidence run. The decision fixes FU-33 first "so it removes noise from every later evidence run".

## Scope

- **One task:** `rework-6`, owner test-engineer, claimed once. Handoff **`ho-mv47ltf3-01c9351a`**.
- **Changed files:** exactly the two named. `git diff --stat 66206c9 223780a -- test` shows:
  - `test/api/uploads-retention.test.js`: +8/-1;
  - `test/timing/planner-sec-b1.test.js`: +21/-6.
- **How it was committed:**
  - The uploads-retention change was swept into the orchestrator's records snapshot `d519c46`.
  - The planner change and the handoff were committed in `223780a`.
  - Both files at HEAD `223780a` are what was reviewed and run here:
    - `uploads-retention.test.js`: sha256 `295bb790…`
    - `planner-sec-b1.test.js`: sha256 `95a40b59…`
- **No source change:** `git diff --stat 66206c9 223780a -- src fixtures scripts package.json` is empty, and the working tree holds only `.eccode` record changes.
- **Submitted artifacts:** this file and the two test files.

## What changed (checked against the diffs)

### `test/api/uploads-retention.test.js`: RS-39 startApp subtest (L711-L718)

- **Unchanged:** the row poll and the "removed by a later tick of the timer" row assertion.
- **New:** after the row poll, a bounded poll of the **file**: `existsSync` every 10 ms, for at most 5 s (`fileDeadline`, L714-L717).
- **The assertion is kept,** with a message: `assert.equal(existsSync(...), false, 'the file of the swept image is unlinked within 5 s of its row going')` (L718).
  - If the file is never removed, the test fails, about 5 s later than before and with a named message.
- **Not changed:** the `retention.sweep` log assertion and the "no request text in logs" assertion.
- **Why a poll and not an event:** the second pass's sweep exposes no event to a test. The first pass is already awaited through `retention.started`.

### `test/timing/planner-sec-b1.test.js`: all three SEC-B-1 tests

- **New constants with a measured-rationale comment (L12-L24):**
  - `SINGLE_CALL_CEILING_MS = 1000`;
  - `SWEEP_P95_MS = 20`, the same value as the old literal.
- **Quiet-host measurements in the comment** (six runs of the exact 1,008-call sweep):
  - max 4.3-7.1 ms, p99 1.3-2.4 ms, p95 0.7-1.0 ms;
  - the 12-offer catalogs: worst 13-25 ms of 150.
  - My own run (ev:ev-mv47o09j-015ce1a5) logged a 12-offer worst of 13.1 ms.
- **Per-call checks moved to the 1000 ms ceiling:**
  - the sweep's per-call check: 100 ms becomes the ceiling (L84);
  - **also** the single stock-100 call: 50 ms becomes the ceiling (L63);
  - **also** each of the 150 twelve-offer catalogs: 250 ms becomes the ceiling (L124).
  - Titles 1 and 3 no longer state "under 50 ms" or "under 250 ms".
- **The sweep p95 stays at `< 20 ms`** (L92-L93), now with a message naming the limit and the quiet value.
- **Kept exactly:**
  - no call may throw, in all three tests (L57, L82, L121);
  - the A-only plan, its lines, total and pickup count, and the same plan with maxPickups 1;
  - `calls == 7*6*3*4*2` (L91);
  - the feasibility count `20 < feasible < 150` (L126).

## Disclosures for the reviewer

1. **The planner change is wider than the one line FU-46 names.** FU-46 names only the sweep's per-call 100 ms check (old L70). The engineer also moved the single-call 50 ms check (test 1) and the 12-offer 250 ms check (test 3) to the same 1000 ms runaway ceiling.
   - This stays within the owned file and has the same rationale: wall-clock bounds on one call fail under host noise.
   - It still loosens two bounds that FU-46 did not ask to touch. The handoff lists it under `remainingIssues`.
   - The reviewer should decide whether 1000 ms is acceptable for those two, or whether they should keep a tighter, measured bound. On a quiet host they sit at under 5 ms and 13-25 ms.
2. **The 1000 ms ceiling is only a runaway guard. No mutant shows it, or the p95, firing.**
   - With the node cap in place (2,000,000), the old exponential algorithm surfaces as `PLANNER_LIMIT`. It is therefore killed by the exactness assertion `assert.equal(error, null, ...)`, not by a time bound.
   - In both planner mutant runs, the failing assertions are tests 2 and 3, "planner search limit exceeded":
     - ev:ev-mv47dqfe-018e0d01: full enumeration, at stock 30, qty 10000;
     - ev:ev-mv47dsj8-0120cf95: full enumeration with the cap lifted to 40M, at stock 100, qty 50000.
   - The sweep throws before its p95 line is reached, so the p95 is not shown firing either. The engineer's measurement script gives the full-enumeration p95 as 27.6 ms (above the 20 ms limit), but that is a measurement, not a failing test run.
   - With the cap lifted entirely, the large inputs would not return at all, so no mutant can show the ceiling alone firing. The engineer states this limit openly.
   - What protects the algorithm is: no PLANNER_LIMIT, exact results, and the p95.
3. **Not every no-unlink mutant fails, and that is the spec's design.**
   - **Passes:** the first "never unlink a swept image's file" mutant passes 33/33 (ev:ev-mv476e0b-01cc6895). The orphan sweep of the same pass removes the file: `retention.js` L9-L10, and spec L773 "Startup also removes orphan files older than 1 day".
   - **Extended mutant fails:** with the orphan sweep also stopped from unlinking, it fails 30/33 (ev:ev-mv476u2l-01edbb7b) at the first image's file check.
   - **Sharper mutant fails on the new wait:** a mutant that unlinks only the FIRST swept file, and whose orphan sweep never unlinks, fails exactly at the new bounded wait with the new message (ev:ev-mv477eod-01087627, the one subtest run alone).
4. **The test comment cites the wrong source** (same kind as TR-R5-2).
   - L711-L713 quote "spec: Retention, 'row and audit event first; an unlink that fails leaves an orphan for the orphan sweep'".
   - That wording is not in `spec.md`. It is the source comment at `src/services/retention.js` L35.
   - The spec says only that the sweep deletes rows and files with an audit event per image (L773, L979), and that startup removes orphan files (L773).
   - The behaviour and the fix are unaffected; only the traceability is off. I did not edit the test (not mine to edit).
5. **The mutant-diff rule from TR-R5-4 is followed, with one directory reuse.**
   - Every mutant has a directory under `scratchpad/rework6/<name>/` with `mutant.diff`, also printed at the top of its evidence log. I checked the diffs against the logs.
   - **The reuse:** `ur-nounlink` was reused when the first no-unlink mutant was extended (orphan sweep stopped too), so its `mutant.diff` now holds only the extended version.
   - **Both versions are still recoverable** from their own logs:
     - ev:ev-mv476e0b-01cc6895 shows the one-line `leftForOrphanSweep += 1` mutant;
     - ev:ev-mv476u2l-01edbb7b shows that line plus the orphan-sweep `continue`.
6. **The 20-run loop log shows exit codes, not counts.**
   - ev:ev-mv47lom9-015c619a sends each run's TAP output to `/dev/null` and stops at the first failure (`|| exit 1`).
   - The log shows `run 1 ok` to `run 20 ok`, and the evidence passed with exit 0. Per-run test counts are not in the log.
   - It ran on the final tree, `622af87f`.
7. **FU-33's own resolution rule is not met yet.**
   - The rule (`followups.md` L229, L343) is "three consecutive locked `npm test` runs pass it". On the fixed tree there are two so far:
     - the engineer's ev:ev-mv47hp51-018946ca;
     - mine, ev:ev-mv47qjdl-01aee9c0.
   - Both are green, and both are runs of `flock /tmp/rescuestock-suite.lock npm test` on tree `622af87f`.
   - A third, for example the reviewer's own locked run, would satisfy it.

## Engineer evidence

### FU-33 (retention race)

| Evidence | What | Result |
|---|---|---|
| ev:ev-mv475gzp-01fef662 | **REPRODUCED:** the UNCHANGED test against a scratch copy whose image unlink is delayed 300 ms (`ur-delay-unchanged`) | **failed as intended:** 41 tests, 40 pass, 1 fail, at the old file check (`expected: false, actual: true`, log L255-L269). This is the assertion that failed in the locked full runs. |
| ev:ev-mv476als-012ebc22 | the FIXED test against the same 300 ms delayed-unlink mutant (`ur-delay-fixed`) | passed: 41/41 |
| ev:ev-mv476e0b-01cc6895 | fixed test, mutant: a swept image's file is never unlinked (`ur-nounlink`, first version) | **passes, 33/33.** The orphan sweep removes the file, as designed. See disclosure 3. |
| ev:ev-mv476u2l-01edbb7b | fixed test, mutant: no unlink by the sweep **or** the orphan sweep (`ur-nounlink`, extended) | **failed as intended:** 33 tests, 30 pass, 3 fail |
| ev:ev-mv477eod-01087627 | fixed test, mutant: only the FIRST swept file is unlinked and the orphan sweep never unlinks (`ur-secondfile`) | **failed as intended** at the new bounded wait, with the new message (1 subtest run) |
| ev:ev-mv47lom9-015c619a | fixed file on the final tree, 20 runs in a loop | passed: `run 1 ok` to `run 20 ok`. See disclosure 6. |

### FU-46 (planner timing)

| Evidence | What | Result |
|---|---|---|
| ev:ev-mv47dqfe-018e0d01 | REVISED test, mutant `pl-fullenum` (`src/domain/search.js` with no irredundancy cut, no dominance table, no lower bound and no demand window) | **failed as intended:** 3 tests, 1 pass, 2 fail (tests 2 and 3, PLANNER_LIMIT) |
| ev:ev-mv47dsj8-0120cf95 | REVISED test, mutant `pl-nocap` (full enumeration, node cap lifted to 40M) | **failed as intended:** 3 tests, 1 pass, 2 fail (tests 2 and 3, PLANNER_LIMIT at stock 100, qty 50000) |
| ev:ev-mv47e3rn-01d51ab3 | revised file on the real tree, quiet | passed: 3/3 |
| ev:ev-mv47feek-01fdb68f | revised file on the real tree under CPU contention (3 × nproc busy loops for 60 s), 3 runs | passed: 3/3 each time |

### Full suite

| Evidence | What | Result |
|---|---|---|
| ev:ev-mv47hp51-018946ca | `flock /tmp/rescuestock-suite.lock npm test` | passed: 2270 tests, 2262 pass, 0 fail, 8 skipped |

- **Tree digests:**
  - the FU-33 mutant runs record tree `e4b760d5…`, the tree before the planner edit;
  - every later run records `622af87f…`, the final tree.
- **Not cited:** the earlier 20-run loop ev:ev-mv47aybz-01d2b0e2 (20/20), because it predates the planner edit.

## Delivery-lead runs on `223780a` (tree `622af87f…`)

| Evidence | Command | Result |
|---|---|---|
| **ev:ev-mv47nz7c-017465b7** | `uploads-retention.test.js` alone (`node --disable-warning=ExperimentalWarning --import ./test/helpers/net-guard.js --test …`) | **passed: 41 tests, 41 pass, 0 fail, 0 skipped; 7.4 s** |
| **ev:ev-mv47o09j-015ce1a5** | `planner-sec-b1.test.js` alone (same form) | **passed: 3 tests, 3 pass, 0 fail, 0 skipped; 0.9 s.** 12-offer worst 13.1 ms, 89/150 feasible. Load average 1.5 at the time. |
| **ev:ev-mv47qjdl-01aee9c0** | `flock /tmp/rescuestock-suite.lock npm test` (decision `dec-mv43s14b-01addb18`, `--timeout 1800`) | **passed: 2270 tests, 2262 pass, 0 fail, 8 skipped, 0 todo; suite 111.5 s.** NFR5 posttest: 7194 requests, p50 3.1 ms, p95 67.1 ms, ok. |

- **Count change:** 2270 tests, up from 2267 at rework-5. The 3 come from phase F's f2 iteration 2 (`66206c9`), not from this rework, which adds no test.
- **The 8 skips** are the existing fake-harness provider-contract cases.

## Acceptance criteria

| Criterion | Met | Evidence |
|---|---|---|
| `task:rework-6`, FU-33: the race is reproduced with the unchanged test; the fixed test passes reliably and still fails when the file is never removed | yes | Reproduced: ev:ev-mv475gzp-01fef662.<br>Fixed on the same mutant: ev:ev-mv476als-012ebc22.<br>Never removed: ev:ev-mv476u2l-01edbb7b and ev:ev-mv477eod-01087627 (red). The designed pass is ev:ev-mv476e0b-01cc6895.<br>20 runs: ev:ev-mv47lom9-015c619a.<br>Mine: ev:ev-mv47nz7c-017465b7. |
| `task:rework-6`, FU-46: every exactness assertion is kept; the p95 plus a generous single-call ceiling is bounded, the ceiling chosen from measurements; the test still fails on a full-enumeration mutant | yes, with disclosures 1 and 2 | the diff above (L12-L24, L57, L82, L91-L93, L121, L126); ev:ev-mv47dqfe-018e0d01, ev:ev-mv47dsj8-0120cf95 (red); ev:ev-mv47e3rn-01d51ab3, ev:ev-mv47feek-01fdb68f; mine: ev:ev-mv47o09j-015ce1a5 |
| `phase:rework-6`: test-only (`dec-mv46ovt6-01a662af`) | yes | no `src`, fixture, script or `package.json` diff since `66206c9`; the handoff's `filesChanged` names exactly the two files |
| The existing checks still pass | yes | ev:ev-mv47hp51-018946ca (engineer) and ev:ev-mv47qjdl-01aee9c0 (mine): 2270 / 2262 / 0 fail / 8 skipped |
| FU-33's own close condition: three consecutive locked `npm test` runs | **2 of 3 so far** | see disclosure 7 |

## Lessons

- **`mem-sd-mv1audrd-013b7102`** (root resolution of a tool-call guard): the engineer recorded it as **not-applicable**.
- **Reason:** this task edits two test files and builds no hook or guard. I agree.
- `memory search` for this kind of change (timing test, asynchronous race, wall-clock bound) returns no other verified lesson.
- **My own guard denials during this run:** a few read-only shell lines were refused on their raw text, for example a line with `2>/dev/null` next to `.eccode/` paths. These are the over-denials the lesson lists under "Not applicable when". They are not wrong-root denials.

## Review

**A technical review is proportionate.** This is a test-only change to two existing tests:
- no source, schema, auth, payment-path or configuration file changed;
- both tests read only the fake world and the pure planner.

A security review is not needed. The reviewer should check:
- **The retention wait:** that the bounded file poll cannot pass with the file left in place.
- **The planner bounds:** that the new bounds still protect the algorithm (disclosure 2), and whether the 1000 ms ceiling on tests 1 and 3 is acceptable (disclosure 1).
- **The comment citation:** disclosure 4.

## Live suites and network

- No live suite was run. My evidence commands ran under `env -u RS_LIVE_MODEL -u RS_LIVE_PAYPAL`.
- Network was 127.0.0.1 only, through `test/helpers/net-guard.js`.
- I made no commits. The only file I wrote is this one.
