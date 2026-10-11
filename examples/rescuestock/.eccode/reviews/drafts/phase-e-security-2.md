# phase:e-payments: security review, iteration 2 (FINAL)

Reviewer: security-reviewer, run run-mv3yeayh-0101211a. Gate: `phase:e-payments`. Submission: `sub-mv3ybm6f-0109db20`
(responds to `rev-mv3xhtuz-017cfbef`). Previous draft: `phase-e-security-1.md` (FINAL).
I read the submission's "Response to rev-mv3xhtuz-017cfbef (iteration 2)", the handoffs ho-mv3xpr5x-01f0502b (e2),
ho-mv3xwa94-016b9830 (e3) and ho-mv3y24kt-01968292 (e6), and decision dec-mv3yeak6-01af9b6d.
The technical-reviewer records the gate.

Status: FINAL.

## Verdict

- **SEC-E-1 (major): resolved on HEAD.**
  - My iteration-1 reproduction W-ORDER, re-run unchanged, no longer reproduces: its S2 and S3 REPRO lines fail and the S1/S4
    controls pass (ev:ev-mv3yh7mw-016dfc59).
  - The full matrix of 7 events × 19 operation states (133 pairs) went through the real route (ev:ev-mv3yinyk-01e69dcb). No
    event moves money state backwards; the only rank-lowering edge is `PAYMENT.CAPTURE.DENIED` `capture_pending → authorized`,
    where a denied capture moved no money.
  - `AUTHORIZATION.CREATED` applies only from `approved` and `authorization_pending`. Terminal states never move. A refused
    event leaves the row unchanged. A duplicate of every applied event under a new transmission id changes nothing.
  - Out-of-order sequences on real flows end consistent with the provider: COMPLETED before a late CREATED; DENIED then a late
    COMPLETED/PENDING; VOIDED, PENDING, DENIED and an unasked REFUNDED after a capture.
  - No path re-sends a capture without the reconciler's read.
- **SEC-E-2 (minor): resolved on HEAD** (ev:ev-mv3yjzu3-0155214d).
  - The limit is 30 per user per window on return and cancel together, taken before any lookup or provider call.
  - It cannot be evaded by alternating the two routes, by a second session of the same user, or by concurrency (40 at once: 30
    admitted). Anonymous hits are not counted and make no call.
  - Foreign and malformed tokens count against the caller only. With `RS_GENERAL_RATE_LIMIT=10` the limit is 10.
  - A normal two-supplier purchase (a cancel, a try-again, a return and two refreshes per approval: 7 hits) is never limited,
    also at limit 10.
  - My iteration-1 reproduction P-AMP, re-run unchanged, now shows 30 reads and 370 × 429 instead of 400 reads
    (ev:ev-mv3ylzph-011c25f3, expected to fail).
- **New finding SEC-E2-1 (minor): the record says something the code does not do.**
  - Decision dec-mv3yeak6-01af9b6d says "PAYMENT.AUTHORIZATION.CREATED **and every other webhook event** leave an operation in
    unknown untouched (stored flagged); only the reconciler resolves unknown operations."
  - The code resolves `unknown` from five events. The matrix shows six such edges, four of them reachable.
  - I find the code's behaviour safe (below). The decision text is what is wrong.
- **Info:** SEC-E2-I1 to SEC-E2-I3.
- **No regression in the earlier areas.** W-SEC, P-AUTHZ and P-RACE pass unchanged on HEAD (ev:ev-mv3ylo6f-01c83b32,
  ev:ev-mv3ylpyf-01aec48a, ev:ev-mv3ylwpw-0116d267).
- **P-FU34** (ev:ev-mv3ylxsp-0120d470): only W-2 fails, and only because a duplicate COMPLETED is now `flagged` instead of
  `ignored` (contract delta 26). The window still shows no refund, no release and no capture until the next tick, then exactly
  one refund and one release. FU-34 stays accepted.
- **From security: approve.** No blocking or major finding remains. SEC-E2-1 needs only the decision amended (or superseded) to
  state delta 27; it is a record fix, not a code change, and does not hold the gate if the orchestrator records it.

## Evidence (security-reviewer, this gate, after sub-mv3ybm6f-0109db20)

Tree digest `2956cda9…` on every run, the submission's. HEAD `b74b357`; the code is identical to `402a0ac`.
- Loopback only, under `./test/helpers/net-guard.js`.
- `RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` were never set.
- The eccode commands ran with the shell's PATH, because the guard refuses an inline PATH. No probe spawns anything but node.

The probes are under `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/`.

| ev id | what | result |
|---|---|---|
| ev:ev-mv3yh7mw-016dfc59 | W-ORDER (`sec-e-webhook-order.mjs`), iteration 1, unchanged | **failed as intended.** S1 and S4 PASS. Every S2/S3 REPRO line FAILs: the late CREATED is `flagged`, A stays `capture_pending` / `unknown`, the plan executes, there is no re-send and no refund. The "S2 money" line also fails, only because it was written for the defective path: it counts two captures, one per authorization, A and B. |
| ev:ev-mv3yinyk-01e69dcb | W-MATRIX (`sec-e2-matrix.mjs`): 133 (event, state) pairs, a duplicate of each applied event, sequences Q1–Q4 | passed, ALL EXPECTATIONS MET |
| ev:ev-mv3yjzu3-0155214d | P-RATE (`sec-e2-rate.mjs`): the SEC-E-2 limit | passed, ALL EXPECTATIONS MET |
| ev:ev-mv3ylzph-011c25f3 | P-AMP, iteration 1, unchanged | failed as intended: AMP-1 REPRO fails (30 reads, 370 × 429); AMP-2 and AMP-3 pass |
| ev:ev-mv3ylxsp-0120d470 | P-FU34, iteration 1, unchanged | failed only on W-2 (`dup=flagged`, delta 26); W-1, W-3, W-4 and W-5 pass |
| ev:ev-mv3ylo6f-01c83b32 | W-SEC, unchanged | passed |
| ev:ev-mv3ylpyf-01aec48a | P-AUTHZ, unchanged | passed |
| ev:ev-mv3ylwpw-0116d267 | P-RACE, unchanged | passed |
| ev:ev-mv3ykj9s-01ab97eb | e3 plan command, verbatim | passed: 117/117 |
| ev:ev-mv3ykvx7-01f42e31 | e2 plan command, verbatim | passed: 93/93 |
| ev:ev-mv3ykwaf-017a6e59 | the artifacts of sub-mv3ybm6f-0109db20 still have their recorded sha256 (run after the probes) | passed |

## (1) SEC-E-1 on HEAD

**Change** (`src/services/webhooks.js` L56–L69 and L266–L273).
- Every event has an explicit `from` list and a `fromUnknown` list. These are checked before the state table, which stays as a
  second gate.
- The `ALREADY_IN_STATE` shortcut is gone.
- `AUTHORIZATION.CREATED` has `from: ['approved', 'authorization_pending']` and `fromUnknown: []`.

**Applied edges in the matrix** (ev:ev-mv3yinyk-01e69dcb; every other one of the 133 pairs is `flagged` or, for
`CHECKOUT.ORDER.APPROVED`, `ignored`, and leaves the row unchanged):

| Event | From | To |
|---|---|---|
| CREATED | `approved`, `authorization_pending` | `authorized` |
| VOIDED | `authorized`, `unknown(authorized)` | `voided` |
| CAPTURE.COMPLETED | `authorized`, `capture_pending`, `unknown(authorized)`, `unknown(capture_pending)` | `captured` |
| CAPTURE.PENDING | `authorized`, `unknown(authorized)` | `capture_pending` |
| CAPTURE.DENIED | `capture_pending`, `unknown(capture_pending)` | `authorized` |
| CAPTURE.REFUNDED | `refund_pending`, `unknown(refund_pending)` | `refunded` |

**Properties checked on every pair (MX-1):**
- **P1:** no applied edge lowers the money rank, except DENIED → `authorized`.
- **P2:** CREATED only from `approved` / `authorization_pending`.
- **P3:** no terminal state moves.
- **P4:** a refused event leaves the row unchanged (all columns except `updated_at`).
- **P5:** each applied event, re-sent under a new transmission id, changes nothing. It is `flagged`, per delta 26.

**Out-of-order sequences** (real flows, fake provider):
- **Q1, after a completed purchase:** late CREATED, PENDING, VOIDED (after the capture), DENIED and an unasked REFUNDED are all
  `flagged`. A stays `captured`; the plan stays `executed`.
- **Q2, CAPTURE.COMPLETED before AUTHORIZATION.CREATED:** COMPLETED is applied, the late CREATED is `flagged`, and the plan
  resumes and executes. Two captures, no refund.
- **Q3, DENIED, then COMPLETED/PENDING for the denied capture:** DENIED is applied. The next tick compensates: A and B voided,
  plan `non_executable`. The late COMPLETED and PENDING are `flagged`, and A stays `voided`.
- **Q4, lost capture answer, so A is `unknown(prev authorized)`:**
  - CREATED is `flagged`, and A stays `unknown`.
  - CAPTURE.COMPLETED resolves A to `captured` without a read.
  - On the next tick the reconciler reads (`get_authorization`, `get_order`) and resolves the call. A's capture is never
    re-sent (`so:<A>:capture:1` absent from the trail), the plan executes, and there are 2 captures.

**The read-first resolution is not skipped in any way that can send money.**
- The S3 shape needs an operation that is `authorized` while its capture call is `unknown`. On HEAD a webhook produces that only
  through `PAYMENT.CAPTURE.DENIED` from `unknown(capture_pending)`.
- No code path writes `prev_status = 'capture_pending'`. The writers are:
  - `calls.js` L75, from approved, authorized or refund_pending;
  - `reconciler.js` L126 (`STATE_OF_CALL`);
  - `saga.js` L391 and L398, from authorized.
- That edge is therefore unreachable (SEC-E2-I1).
- The other webhook resolutions of `unknown` all move forward to the state the provider reports. Q4 shows the reconciler still
  reading before it touches the call.

### SEC-E2-1 (minor): decision dec-mv3yeak6-01af9b6d says more than the code does

**What disagrees.**
- The decision says no webhook event resolves an `unknown` operation.
- The code (`fromUnknown` lists), the e3 handoff ho-mv3xwa94-016b9830 and the submission's contract delta 27 all say only
  `AUTHORIZATION.CREATED` refrains. VOIDED, COMPLETED, PENDING, DENIED and REFUNDED resolve `unknown` from their listed
  prev_status values.
- The e3 mapping table pins this. For example: `PAYMENT.AUTHORIZATION.VOIDED: unknown (prev authorized, lost void) -> voided`
  is `applied`.
- Reproduced through the route: MX-2 lists six resolutions, four from prev_status values the code can produce; Q4 shows one on a
  real flow.

**Impact.**
- No money effect: each is forward and provider-reported, and Q4 shows the reconciler still reads before acting on the call.
- But the recorded decision states a safety property ("only the reconciler resolves unknown operations") that is false. The
  verification report and later owners (f2 under FU-41, f4) would rely on it.

**Resolution condition.** The orchestrator amends or supersedes dec-mv3yeak6-01af9b6d to say what delta 27 says:
- CREATED never resolves `unknown`;
- the other events resolve `unknown` only forward, from their `fromUnknown` lists.

Security accepts that rule. Alternatively, empty every `fromUnknown`; then re-run W-MATRIX, whose MX-2 line would fail.

### Info

**SEC-E2-I1. Two `fromUnknown` entries are dead.**
- `PAYMENT.CAPTURE.DENIED` and `COMPLETED` list `capture_pending` in `fromUnknown`, a prev_status nothing writes.
- If a later change ever wrote it, DENIED would recreate the SEC-E-1(b) shape: `authorized` with an `unknown` capture call.
- Suggest removing `capture_pending` from both `fromUnknown` lists, or let f2's FU-41 (read under the lease before re-sending an
  unknown capture) close it for good.

**SEC-E2-I2. A cross-site page can spend the buyer's 30 return/cancel hits for one window.**
- It does so with top-level navigations, which carry the SameSite=Lax cookie. The buyer's own return in that minute is then 429.
- The approval at PayPal survives, and the next window's hit authorizes once (P-RATE R7).
- This is the same class as the accepted SEC-R-2 (dec-mv3vuiqw-01d3c5c9). Not demonstrated in a browser.

**SEC-E2-I3. Late duplicates are now stored `flagged = 1` instead of `ignored`** (delta 26).
- No code reads `flagged` rows (grep of `src/`), so this is operator-visible noise only. Accept.

## (2) SEC-E-2 on HEAD

**Change.**
- `src/routes/paypal.js` L26 calls `takeReturnSlot(ctx, user.id)` after the anonymous redirect and the role check, before the
  token lookup.
- `src/services/payments.js` L183–L201: `min(30, RS_GENERAL_RATE_LIMIT)` per `RS_GENERAL_RATE_WINDOW_SEC`. It runs in one
  `BEGIN IMMEDIATE` on `rate_events` (kind `general`, key `pp:u:<id>`, separate from the general limiter's `u:<id>` and
  planning's `plan:u:<id>`). A refused hit is not recorded.

**P-RATE** (ev:ev-mv3yjzu3-0155214d):
- **R1:**
  - 30 hits are admitted, with 30 provider reads.
  - The buyer then approves at the PayPal page. Hit 31 is 429 `RATE_LIMITED` with `Retry-After` 60, no read, no authorize, and
    the operation stays `created`.
  - Cancel is also 429, and `buyer_cancelled_at` is not set.
- **R2:** alternating return and cancel: 30 admitted, the 31st 429.
- **R3:** a second session of the same user: 429.
- **R4:** 40 anonymous hits: all 303 to sign-in, no read, not counted. cafe2 is unaffected (404 for cafe1's token).
- **R5:** 40 concurrent hits across both routes: exactly 30 × 303 and 10 × 429.
- **R6:** cafe2's 30 foreign/malformed hits (15 × 404, 15 × 400) exhaust cafe2's count only. cafe1 is still admitted.
- **R7:** the next window authorizes once.
- **R8:** a normal purchase (7 hits, including a cancel and two refreshes per return) is never limited and executes, at limit 30
  and at `RS_GENERAL_RATE_LIMIT=10`.
- **R8b:** at that setting, the 11th hit is 429.

## (3) Everything else in the diff since sub-mv3vs3h1-0181fd20

The code diff `5e1895b..402a0ac` is exactly 7 files, +135/−29 (checked with `git diff --stat`). Nothing after `402a0ac` touches
src/test.

| File | Security reading |
|---|---|
| `src/services/webhooks.js` | Section (1). The second gate (`canTransition`) is kept. No new input reaches SQL: the column names are still constants. |
| `src/services/payments.js` | `takeReturnSlot` (section 2): prepared statements; the window comes from config. No new finding. |
| `src/routes/paypal.js` | Order: identify → 303 anonymous → 403 non-customer → limit → handler. Suppliers and admins are not counted, which is fine. |
| `test/api/webhooks.test.js` | 21 → 42 mapping rows. Two expectations were changed, not weakened: `ignored` → `flagged`, per delta 26. One ARCH-22 webhook test now starts from `approved` instead of `unknown(prev approved)`, since an unknown operation now goes through the reconciler (`void-rule-lost-authorize.test.js`, green in e4's suite on this tree per the submission). |
| `test/api/paypal-return-idempotent.test.js` | +1 SEC-E-2 test, matching my R1/R4/R7. |
| `test/browser/helpers/approval-roundtrip.js`, `journey-happy.test.js` | Stricter: the return/cancel log line must carry the session's `userId` and role `customer` (TR-E-3). This is a correctness strengthening only. I did not run the browser suite. |

## What I did not test

- Real PayPal: event ordering and retries, whether delivery reuses transmission ids, and webhook-id binding all stay
  LIVE-DEPENDENT.
- The browser suite.
- `npm test` (the technical-reviewer's run).
- The e4 plan command on this tree. Its files are unchanged since my iteration-1 run ev:ev-mv3wmvrj-0158f090.
- Multi-process races on the new limit; the `BEGIN IMMEDIATE` is the same pattern as the webhook and general limits.

## Refusals

None in this iteration: no eccode command and no Bash command was refused. Per the coordinator's note I did not set PATH inline on
an eccode command.
