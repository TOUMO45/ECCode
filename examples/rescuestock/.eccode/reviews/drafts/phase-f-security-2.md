# phase:f-compensation: security review, iteration 2 (FINAL)

**Verdict (security): APPROVE.**
- The TR-F-1 fix (`holdOperation`) is sound on every point I was asked to check.
- SEC-F-1 is resolved: the new test fails under my mutant MB.
- No new finding is above info.
- The routing of SEC-F-I1 and I3–I7 is accepted, with three conditions on the backend rework (end of this draft).

Reviewer: security-reviewer, run run-mv46p00q-01915afc. Gate: `phase:f-compensation`. Submission: `sub-mv46nmw5-019e21c8`
(responds to `rev-mv45ljos-01f00a5d`). Previous draft: `phase-f-security-1.md` (FINAL, approve).
- **Read:**
  - `.eccode/artifacts/phase-f/submission.md` › "Iteration 2";
  - `.eccode/artifacts/plan/followups.md` › "Added after the phase F review";
  - f2 reset handoff `ho-mv46cije-013aeaff` (commit `66206c9`);
  - decisions `dec-mv46ovf2-017bf12d` and `dec-mv46ovt6-01a662af`.
- **Who records:** the technical-reviewer records the gate, as for every gate so far. I did not run `gate review`.

## Evidence (security-reviewer, gate phase:f-compensation, all after sub-mv46nmw5-019e21c8)

**Tree.** Every run carries tree digest `57221f73…`, the submission's: the delivery lead's and f2's final runs have the same digest.
- The code is that of `66206c9`. HEAD `61d984a` adds records only; `git diff 66206c9..HEAD` over src/test/public/scripts/package.json is empty.
- All 61 artifacts match their recorded sha256 (ev:ev-mv470x6p-0139db5a, run last).

**Safety.**
- Loopback only, under `test/helpers/net-guard.js`.
- `RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` were never set.
- The full suite ran inside `flock /tmp/rescuestock-suite.lock`.
- No edit to the real tree.
- The mutant ran in a fresh copy, `sec-f/mut-MB2/`, with my kept diff `sec-f/mut-MB.diff`. The recorded command first checks that the copy's `test/` equals the tree's.

**Aborted run.** I aborted one run before it was recorded: my first f4 attempt piped `npm test` through `tee | tail`, which masks its exit status under `sh`. The f4 run below is the exact command.

**Probes.** They live in `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/sec-f/`. The new one is `p-hold.mjs`.

| ev id | what | result |
|---|---|---|
| ev:ev-mv46u1oo-0168894e | **P-HOLD** (`p-hold.mjs`) G1-G5: the TR-F-1 fix | ALL EXPECTATIONS MET |
| ev:ev-mv46uik6-017265d5 | Mutant MB (fresh copy `mut-MB2`) against the f2 plan test files | **59 tests, 1 fail** (`SEC-F-1: a compensation refund the provider REJECTS …`): killed |
| ev:ev-mv46vibc-0154eb16 | f1 plan command, verbatim | 40/40 |
| ev:ev-mv46vtrp-0129eda6 | f2 plan command, verbatim | 59/59 |
| ev:ev-mv46vupw-01a938e5 | f3 plan command, verbatim | 205/205 |
| ev:ev-mv470pi4-01854654 | f4 plan command, verbatim, inside the suite lock (`npm test && npm run test:browser`) | exit 0 (144 s); browser 14/14. The `npm test` half passed; its counts are not in the recorded tail. The delivery lead's ev:ev-mv46l0go-019aab68 has 2270/2262/0/8. |
| ev:ev-mv46w321-01176c2d | P-MONEY (iteration 1, unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv46w78y-0121b87a | P-RESET (unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv46w8yu-0153734e | P-ADMIN (unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv46wi06-018015a4 | P-REFUSE (unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv46wo98-01238c5b | P-RACE (unchanged) | ALL EXPECTATIONS MET |
| ev:ev-mv46wqho-01166b6e | P-CARRY (unchanged; C3 = an applied capture is never re-sent, now through the hold) | ALL EXPECTATIONS MET |
| ev:ev-mv46wsbq-01cbbf0a | P-HANDOVER (unchanged; still shows SEC-F-I7, which is routed) | ALL EXPECTATIONS MET |
| ev:ev-mv46wykb-01458a64 | P-FENCE (iteration 1, unchanged), reproduction | **fails only in F1, as the fix intends**: A is now held `unknown`, epoch 2 → 2 over 10 failing ticks, takeover rows 1 → 1, 0 sends. F2 (stale holder) and F3 (F-TR-7) still pass. |
| ev:ev-mv470x6p-0139db5a | The 61 artifacts of sub-mv46nmw5-019e21c8 still have their sha256 | 61/61 |

The browser XSS probe was not re-run: `public/` is unchanged, and the browser suite passed inside ev:ev-mv470pi4-01854654.

## (1) TR-F-1 / SEC-F-I2: `holdOperation` (`src/services/saga.js` L540-L560, called at L616)

**Reading the code.**
- It runs in one transaction.
- **Fence:** `fenceLease`, the same epoch and executor check as a call result; a stale holder gets `'lost'`.
- **What it selects:** the newest capture call of the operation that is `unknown`, token-less and not archived.
- **The move:** only when the fresh operation is `authorized` (CAS through `moveOperation`) does it move to `unknown` with `prev_status = authorized` and `unknown_since` = the call's original `unknown_since`.
- **Backstop:** the payment state table would refuse `captured/voided/refund_* → unknown` anyway, so a mutant that drops the CAS would throw and roll back rather than move money state backward.

**P-HOLD** (ev:ev-mv46u1oo-0168894e), real saga and reconciler on the fake:

| Asked | Result |
|---|---|
| **The FU-49 shape is held and escalates (G1)** | After the first reconciler read (CREATED) and a failing holder read, A is `unknown`, prev `authorized`, with the **original** `unknown_since` of the timed-out call.<br>Ten failing ticks: **epoch 2 → 2, takeover rows 1 → 1, one read per tick, no capture sent**.<br>The buyer reads `payment_authorized` at age 4 min, and **`failed_needs_attention` / CONTACT_ORGANISER** after `RS_UNKNOWN_ESCALATE_MIN` (15 min here), measured from the original timeout. Admin metrics `unresolved` = 1. |
| **No double capture after recovery (G1, G4, G5)** | G1: reads recover, then exactly one re-send of `so:<A>:capture:1`, two captures, plan `executed`.<br>G5: 20 seeds of random read failures (`getAuthorization` p = 0.5, `getOrder` p = 0.3) over 12 ticks, then 4 healthy ticks: every plan `executed`, **exactly one completed capture per authorization**, A sent at most twice (the timeout plus one re-send). |
| **A stale holder writes and sends nothing (G2)** | The holder's pre-resend read is held, the lease lapses, and a takeover (epoch + 1) re-reads, re-sends and executes. The stale read then returns either way:<br>- **failing** (the hold path);<br>- **CREATED** (the send path).<br>In both cases A, its call row and the plan are **byte-identical** before and after, nothing is sent (2 sends in all), and `saga.lease_lost` is logged. |
| **No backward move from a newer state (G3)** | During the legitimate holder's held read, A is moved to a newer state, and then the read fails. A keeps the newer state, never `unknown`, at the same epoch. The newer states:<br>- `captured`, by a **genuine signed** `PAYMENT.CAPTURE.COMPLETED` (`applied`);<br>- `voided`, by a signed `PAYMENT.AUTHORIZATION.VOIDED` (`applied`);<br>- `refund_pending`, by a direct writer. |
| **Reconciler restore vs hold: no lost update (G4)** | The holder's read and a second reconciler's CREATED read were both held and released in both orders:<br>- **hold then restore:** A `unknown`, then the CREATED read restores it, the takeover holder reads CREATED and re-sends once, A `captured`;<br>- **restore then hold:** A `authorized`, then `unknown`, then recovers.<br>In both orders: two captures, plan executed, at most one re-send, and each re-send only after a holder read showed CREATED. Both writers are CAS transactions on stored state, so neither can overwrite the other blindly. When a restore lands after a hold, the result is `authorized` backed by a provider read showing CREATED. The pre-resend read remains the gate. |

**SEC-F2-I1 (info): the epoch is bounded by successful reads, not constant.**
- When the reconciler's reads succeed and the holder's fail ("flapping"), each successful CREATED read allows one takeover.
- G5 shows epochs up to 7 (6 takeovers) in 12 ticks for some seeds; most stay at 2.
- This is what followups item 21 states. Every such takeover is backed by a fresh provider read. No send happened without a holder read showing CREATED, and no seed doubled a capture.
- No action is needed beyond item 21's wording.

**Conclusion.** SEC-F-I2 is closed, and TR-F-1's two conditions hold from the security side: the stuck state escalates, and the epoch no longer grows per tick on failing reads.

## (2) SEC-F-1: resolved

- **The test.** `test/api/capture-compensation.test.js` › `SEC-F-1: a compensation refund the provider REJECTS (http 422) …` pins every element of my resolution condition:
  - `refund_failed` with `INJECTED_UNPROCESSABLE`;
  - the call `failed` and sent once, with no refund at the fake;
  - the reservation `reconciling` with `REFUND_FAILED` and no restock row;
  - the buyer `failed_needs_attention`, with nothing reading `refunded`.
- **The mutant.** My mutant MB (the iteration 1 diff, applied unchanged to a fresh copy of the iteration 2 tree) turns exactly that test red: 59 tests, 1 fail (ev:ev-mv46uik6-017265d5). The engineer's ev:ev-mv45wwaa-0115c9c9 agrees.

## (3) No regression elsewhere

- All iteration 1 probes pass unchanged on the new tree. P-FENCE F1 is the exception, and it fails in the intended direction.
- The four plan commands pass, including the multi-process restart, lease-takeover and return-crash tests inside `npm test` (ev:ev-mv470pi4-01854654).

## (4) Routing of the info items (dec-mv46ovf2-017bf12d, dec-mv46ovt6-01a662af)

**Accepted from security.** No item is a money or authorization defect today; each was demonstrated as info. The routing names an owner and a review gate (backend rework after phase F approval), or a product default. **Three conditions** go on the backend rework, which security wants to review before delivery:

1. **FU-59 / SEC-F-I7 must block per order, not per plan.**
   - `handoverAllowed` (`src/services/orders.js` L51-L62) checks the payment state of *every* operation of the plan.
   - Simply adding `refunded` to `HANDOVER_BLOCKING_PAYMENT`, as the decision text reads, would also block the **sibling** orders of a partially refunded executed plan. That breaks spec revision 2 row 7 / OQ-D2 (the other supplier's goods remain collectable).
   - FU-59 itself says "for that order only". The rework's test must show both:
     - the refunded order gets 409 `HANDOVER_BLOCKED`;
     - its sibling can still be marked ready and handed over.
2. **FU-58 / SEC-F-I6 must apply to the supplier route itself**, in `checkRefusalReason`, not only to the admin path that FU-56 aligns with it.
   - Bidi override controls U+202A–U+202E and U+2066–U+2069 must be refused or stripped there, or the reason must be isolated when the server composes its sentence.
   - A test: an RLO reason is 422, or the stored or composed text is isolated.
3. **FU-54 / SEC-F-I1:**
   - `owedRefund` must be true exactly for a `captured` operation with `cancel_requested_at` set.
   - Each stranded entry also carries `planStatus`, so a partial capture of an `executing` plan is visible.
   - The fake-provider wording must not mention the Sandbox dashboard.
   - **FU-53** (stranded statuses are as of the archive; no epoch bump) is accepted for the verification report. It complements this: late in-flight completions are recorded but never sent (iteration 1 P-RESET R4/R5).

**FU-55 and FU-57** (the audit rows for 404/422, and `refund_failed` in `unresolved`) are fine as routed. Since TR-F-1 the FU-49 plans already count in `unresolved` (G1).

## Criteria (security view, for the technical-reviewer's record)

| Criterion id | Met | Proving section |
|---|---|---|
| task:f1-supersession-refusal-expiry | yes | `artifact:.eccode/artifacts/phase-f/submission.md#What the phase delivers`; ev:ev-mv46vibc-0154eb16 |
| task:f2-compensation-takeover-admin | yes | `artifact:.eccode/artifacts/phase-f/submission.md#Every finding → resolution → change → tests → evidence`; ev:ev-mv46vtrp-0129eda6, ev:ev-mv46u1oo-0168894e, ev:ev-mv46uik6-017265d5 |
| task:f3-frontend-recovery | yes | `artifact:.eccode/artifacts/phase-f/submission.md#What the phase delivers`; ev:ev-mv46vupw-01a938e5 |
| task:f4-restart-takeover-browser | yes | `artifact:.eccode/artifacts/phase-f/submission.md#What is REAL and what is SIMULATED`; ev:ev-mv470pi4-01854654 |
| phase:f-compensation | yes | `artifact:.eccode/artifacts/phase-f/submission.md#Iteration 2: response to rev-mv45ljos-01f00a5d` |
| security | yes | this draft; SEC-F-1 resolved, SEC-F-I2 closed, SEC-F2-I1 info, routing accepted with three conditions |

## What I did not test

- Real PayPal: every LIVE-DEPENDENT fact is unchanged from iteration 1.
- Node 22.5.
- The multi-process files ×N: they ran once, inside the locked suite.
- A hold racing a forced reset was not run. Reading the code: the archive leaves the epoch unchanged, but `holdOperation` selects only a capture call with `archived_at IS NULL`, so after the archive it finds none and writes nothing. In any case `startCall` refuses archived operations, so nothing can be sent (FU-53).
