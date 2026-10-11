# phase:rework-5: submission

Author: delivery-lead (run `run-mv43fvlo-01d19015`). Gate: `phase:rework-5`. Date: 2026-10-11. Iteration 1.

## Why this rework exists

- **Decision:** `dec-mv41b2g0-018dc143`. f2 (handoff `ho-mv41a3s6-0138e24d`) added two spec-required behaviours. Each one made a previously approved test stale, because the old expectation pinned the earlier behaviour:
  1. **lost-response RS-25 (FU-41(a)).** Before the lease holder re-sends an `unknown` capture, it now reads the authorization itself, under the lease. It no longer relies on the reconciler's step-2 read from the same tick.
     - Spec: ARCH-26 (2) and Payment saga step 6.
     - `followups.md` FU-41 (a).
  2. **admin-basic `refund_order`.** The handler now sends the queued refund call itself, right after the commit.
     - Spec: Sender table, refund row (`spec.md` line 827): "the compensation caller or the `refund_order` handler, right after commit".
     - Spec: Admin routes, `refund_order` (line 399).
- **Effect:** `npm test` was red on those two subtests, and `npm test` is part of f4's verification command. This rework therefore blocks f4's completion.

## Scope

- **One task:** `rework-5`, owner test-engineer, claimed once.
  - Handoff: `ho-mv43etq7-01598938`.
  - Commit: `0c7b37b`.
- **Ownership:** `test/api/lost-response.test.js` and `test/api/admin-basic.test.js`.
- **Changed files:** exactly those two. `git show 0c7b37b -- test/` shows +22/-8 across the two files.
- **No source file changed.**
  - `git diff --stat d49482e 0c7b37b -- src test/timing` (from the commit that opened rework-5) is empty except for the two test files.
  - `git diff --stat 0c7b37b -- src test fixtures scripts package.json` against the working tree is empty.
  - The handoff states that no `src` file, fixture or f4 file was touched, and that no live suite was run.
- **Submitted artifacts:** this file and the two test files. Both test files are byte-identical to `0c7b37b`:
  - `lost-response.test.js`: sha256 `cd21749c…`
  - `admin-basic.test.js`: sha256 `261761d4…`

## What changed in the two tests (checked against the diff)

### `test/api/lost-response.test.js`: RS-25 timeout subtest

- **The trail `deepEqual`:**
  - Before: `['get_authorization', 'capture', 'capture']`.
  - After: `['get_authorization', 'get_authorization', 'capture', 'capture']`.
  - It is still an exact ordered `deepEqual` of the kinds, **not** weakened into a length check.
- **The indices shift by one:**
  - `trail[2]` is A's capture: the same key `so:<A>:capture:1`, `replayed` 0.
  - `trail[3]` is B's capture.
- **Every other assertion is kept:**
  - two sends of A's key;
  - one capture per authorization at the provider (`fake_paypal_captures` = 2);
  - send_count, plan executed and epoch, as before.
- **Comment:** cites ARCH-26 (2), saga step 6, FU-41(a) and the f2 handoff.

### `test/api/admin-basic.test.js`: `refund_order` subtest

- **Error cases kept unchanged:**
  - the unknown order gets 404;
  - the early 409 `INVALID_STATE`;
  - the second refund gets 409.
- **After the 200, these assertions changed:**
  - Before: the operation is `refund_requested` and the one `provider_calls` row is `{refund, so:<id>:refund:1, status intent, started_at null}`.
  - After:
    - the operation is **not** `refund_requested`;
    - exactly one `provider_calls` row, `{kind refund, operation_key so:<id>:refund:1, send_count 1}`;
    - `COUNT(provider_calls)` = 1;
    - the `fake_paypal_calls` refund rows are exactly `[so:<id>:refund:1]`.
- **New:** after the second refund (409), there is still exactly one `fake_paypal_calls` refund row ("the refusal sent nothing").
- **Title:** now says the call "is committed and sent once by the handler".

### Observations for the reviewer (no change made; tests are not mine to edit)

1. **The operation status is asserted only as `notEqual 'refund_requested'`.** The test does not pin it with `equal 'refund_failed'`.
   - The before-log (`ev-mv439gxz-01147594`, line 116) shows the actual status is `refund_failed`. The fake provider refuses the hand-made capture id `FAKE-CAP-1`.
   - So the assertion accepts any other status. The exact-one-call and exact-key assertions are still pinned.
   - The test's comment states that the completed refund is covered by `admin-refund-order.test.js`.
2. **The new comment cites "FU-42 / SEC-11: one refund per captured order" for the exactly-one-send rule.** Neither source says that:
   - FU-42 (`followups.md` line 263) is about refund amounts against `supplier_orders.total_cents`.
   - SEC-11 (`spec.md` line 50) is about forced reset and audit naming.
   - The rule itself is supported by:
     - spec line 399: `refund_order` is allowed only for a `captured` operation, so a second call is refused;
     - the Sender table refund row: one send right after commit;
     - the deterministic key `so:<id>:refund:1`.
   - This affects only the comment, not the behaviour.

## Before and after (engineer)

| Evidence | Command | Result |
|---|---|---|
| ev:ev-mv439cua-010718f4 | BEFORE: `lost-response.test.js` alone | failed as expected: 9 tests, 8 pass, 1 fail (RS-25 timeout subtest: the extra `get_authorization`) |
| ev:ev-mv439gxz-01147594 | BEFORE: `admin-basic.test.js` alone | failed as expected: 18 tests, 17 pass, 1 fail (`refund_order`: expected `refund_requested`, actual `refund_failed`) |
| ev:ev-mv43btqg-01084c9e | AFTER: `lost-response.test.js` alone | passed: 9/9 |
| ev:ev-mv43by2u-010c440b | AFTER: `admin-basic.test.js` alone | passed: 18/18 |
| ev:ev-mv43e8b9-015088e3 | AFTER: `npm test` | passed: 2267 tests, 2259 pass, 0 fail, 8 skipped |

Both "before" runs are on the current source with the old tests. They show that the stale expectations, not the code, were what failed.

## Mutation results (engineer; scratch copies, the real tree untouched)

I compared the scratch copies under `scratchpad/f4-private/r5a|r5b|r5c` with the real `src`. The mutants are as described.

| Evidence | Mutant | Expected | Result |
|---|---|---|---|
| ev:ev-mv43azjb-01f640ff | `src/services/saga.js` `readBeforeResend`: first line `if (op) return 'send';` (f2's FU-41(a) read reverted) | lost-response red | **red**: 9 tests, 1 fail, the RS-25 timeout subtest |
| ev:ev-mv43b3lz-01563942 | `src/services/admin.js` `refund_order`: `await runCall(ctx, queued.callId)` removed (never sends) | admin-basic red | **red**: 18 tests, 1 fail, `refund_order` (`notEqual 'refund_requested'` caught it) |
| ev:ev-mv43bm23-01f616d9 | `src/services/admin.js` `refund_order`: after `runCall`, a second `ctx.payments.refundCapture` with the same request id, straight to the provider | admin-basic red | **red**: 18 tests, 1 fail, `refund_order` |
| ev:ev-mv43b7zh-015445ff | first "send twice" attempt: `runCall` re-run on a reset call | admin-basic red | **survived** (18/18 pass). **Explained:** the refund start guard refuses a second start once the operation is `refund_failed`, so this mutant never actually sent twice. It was behaviourally equivalent at the provider. The engineer replaced it with the direct provider call above, which does send twice and is killed. |

**Disclosure.** The surviving mutant's source no longer exists: the engineer reused the `r5c` directory for the replacement mutant. Its description comes from the handoff and the evidence label, and its log shows 18/18 passing. I could not inspect its diff.

## Delivery-lead runs on `0c7b37b`

| Evidence | Command | Result |
|---|---|---|
| **ev:ev-mv43h435-01f07b7f** | `lost-response.test.js` alone (the engineer's command, verbatim) | **passed: 9 tests, 9 pass, 0 fail** |
| **ev:ev-mv43h9ea-01f7dc8a** | `admin-basic.test.js` alone (the engineer's command, verbatim) | **passed: 18 tests, 18 pass, 0 fail** |
| **ev:ev-mv43keu0-0102c57c** | `npm test` (`--timeout 1800`) | **failed (exit 1): 2267 tests, 2258 pass, 1 fail, 8 skipped, 0 todo; 140.6 s.** The failure is not in a rework-5 file; see below. |
| **ev:ev-mv43mxck-01694576** | `test/timing/planner-sec-b1.test.js` alone (cause check) | **passed: 3/3** |
| **ev:ev-mv43pho4-01ad5c59** | `npm test` (`--timeout 1800`), re-run once | **passed: 2267 tests, 2259 pass, 0 fail, 8 skipped, 0 todo; 114.3 s.** NFR5 posttest: 7619 requests, p50 3.2 ms, p95 70.7 ms; suite 114.4 s, ok. |

The counts match the engineer's green run, ev:ev-mv43e8b9-015088e3. The 8 skips are the existing fake-harness provider-contract cases, which this rework did not change.

### The one failure in ev:ev-mv43keu0-0102c57c

- **Test:** `test/timing/planner-sec-b1.test.js:58`, "SEC-B-1: the seeded catalog shape never reaches PLANNER_LIMIT and stays fast for stock 1 to 100,000 and quantity 100 to 100,000" (log line 6661).
- **Assertion:**
  - The test times each of 1,008 planner calls separately, by wall clock, and asserts that **every** call takes under 100 ms (line 70).
  - The failing call was `stock 100, qty 5000, maxPickups 3, budget 1000000, compat true`. It took 186.9 ms.
- **Cause: CPU contention.**
  - My run lasted from 17:26:18 to 17:28:38 UTC. For the whole of that time, the test-engineer's f4 verification command was running its own full `npm test`:
    - first ev:ev-mv43j15k-01209f8b, from 17:25:29 to 17:27:34;
    - then its re-run ev:ev-mv43mqlq-01b00d12, whose `npm test` started about 17:27:48. `ps` showed it at 17:28:56.
  - Each `npm test` runs `--test-concurrency=4`, and this machine has 4 CPUs. `uptime` right after my run showed load average 6.68.
  - A per-call wall-clock limit with no allowance for load is sensitive to that.
- **Not a rework-5 effect:**
  - Rework-5 changed neither the planner nor this test. `test/timing/planner-sec-b1.test.js` was last changed in `53bc0af` (phase B).
  - The test passed alone (ev:ev-mv43mxck-01694576) and in the re-run (ev:ev-mv43pho4-01ad5c59, ok 236).
- **The other run failed too.** The test-engineer's overlapping run ev:ev-mv43j15k-01209f8b also had 1 failure, but a different one: the known FU-33 uploads-retention timer race (`uploads-retention.test.js:677`, decision `dec-mv3tqbn4-01d43152`). Both failures happened only while two full suites shared the 4 CPUs.
- **Correction to my re-run's label.** The label of ev:ev-mv43pho4-01ad5c59 says "quiet machine (no concurrent suite)". That is inaccurate:
  - No second full `npm test` or browser suite was running.
  - The test-engineer did record two smaller runs during it: ev:ev-mv43nz3i-015ad25b (multi-process files ×4 at concurrency 4) and ev:ev-mv43ohq1-01bc3f1c (`contracts.test.js` alone).
  - The re-run passed anyway.
- **Suggested follow-up (not part of this rework):** the SEC-B-1 per-call 100 ms limit has no allowance for a loaded host, and the delivery has already seen concurrent suite runs. Its owner could relax it to a p95 or median bound, which the test already computes. The other option is a rule that full suites are not run concurrently for evidence. I report this to the orchestrator. I did not edit it.

## Acceptance criteria

| Criterion | Met | Evidence |
|---|---|---|
| `task:rework-5`: the two stale tests are updated to the spec behaviour, test-only | yes | `git show 0c7b37b -- test/` (two files only); handoff `ho-mv43etq7-01598938` |
| `phase:rework-5`: the RS-25 timeout trail reads before the capture re-send (FU-41a), and `refund_order` sends exactly one `so:<id>:refund:1` call; no source change | yes | the diff above; ev:ev-mv43h435-01f07b7f, ev:ev-mv43h9ea-01f7dc8a; no `src` diff since `d49482e` |
| A regression test fails before the fix and passes after it | yes | before: ev:ev-mv439cua-010718f4, ev:ev-mv439gxz-01147594; after: ev:ev-mv43btqg-01084c9e, ev:ev-mv43by2u-010c440b, and mine above. Mutants: ev:ev-mv43azjb-01f640ff, ev:ev-mv43b3lz-01563942, ev:ev-mv43bm23-01f616d9 (red) |
| The existing checks still pass | yes | ev:ev-mv43e8b9-015088e3 (engineer) and ev:ev-mv43pho4-01ad5c59 (mine): 2267 / 2259 / 0 fail / 8 skipped. The one failure in ev:ev-mv43keu0-0102c57c is explained above. |

## Lessons

- **`mem-sd-mv1audrd-013b7102`** (root resolution of a tool-call guard): the engineer recorded it as **not-applicable**.
- **Reason:** this task edits two test files and builds no hook or guard. I agree.

## Review

**A technical review is proportionate.** This is a test-only change to two existing tests: no source, schema, auth, payment-path or configuration file changed, and the behaviour it pins was already reviewed with f2. A security review is not needed for it. The reviewer should check:
- the two new expectations against the cited spec lines;
- the two observations above (the `notEqual` status assertion, and the FU-42/SEC-11 citation).

## Live suites and network

- No live suite was run: `RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` were unset.
- Network was 127.0.0.1 only, through `test/helpers/net-guard.js`.
