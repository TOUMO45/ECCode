# phase:f-compensation: security review, iteration 1 (FINAL)

**Verdict (security): APPROVE.** No blocking or major finding. One minor finding (SEC-F-1, a test gap on a money mapping whose
code is correct today) should be routed as a follow-up before delivery. Seven info items go to the follow-ups and the
verification report.

Reviewer: security-reviewer, run run-mv44kln2-0180671d. Gate: `phase:f-compensation`. Submission: `sub-mv44juz3-01ac72c7`.
- Handoffs: f1 ho-mv40suhb-012306c3; f2 ho-mv41a3s6-0138e24d; f3 ho-mv403lay-01fa3938 and ho-mv42ei0w-019037ae; f4 ho-mv43p246-01228012.
- Read: `.eccode/artifacts/phase-f/submission.md`, `.eccode/artifacts/plan/followups.md` ("Added after phase F"), the approved spec
  (Admin routes, Payment saga, Reconciler, Provider call protocol), and the phase E and rework-4 security drafts.
- **Who records:** the technical-reviewer records the gate. Every `review.recorded` event in `events.jsonl` is by
  technical-reviewer, including both for `phase:e-payments` (seq 1101 and 1187). This draft is input to its decision; I did not
  run `gate review`.

## Verdict in short

| Focus area | Result | Evidence |
|---|---|---|
| 1. No money moves backward or twice | **Met.** No double refund, double capture, void after capture, or refund of an uncaptured operation, under parallel admin calls, compensation, two reconcilers, takeover, and a forced reset with money in flight. | ev:ev-mv44uzzh-01744558, ev:ev-mv44xmul-01d64afc, ev:ev-mv452q7k-0170c0b2, ev:ev-mv45f6xa-01a86f74 |
| 1b. Rejected-refund mapping coverage (`calls.js` L296) | **SEC-F-1 (minor).** The gap is reproduced: mutant MB passes all 56 f2 tests. Only rework-5's `admin-basic` test kills it, and that test does not cover the compensation path. | ev:ev-mv45a1qw-01b3e8ca, ev:ev-mv45adl5-0146e187, ev:ev-mv45ahqj-01d67bc3 |
| 2. Admin fault routes (SEC-11) | **Met.** Admin-only, even under method, path, header and body tricks. Denied `refund_order` audit rows are durable. A forced reset voids first, resolves by reading, and lists everything left. Info: SEC-F-I1, I3, I5. | ev:ev-mv451665-01a9729f, ev:ev-mv44xmul-01d64afc |
| 3. Lease/epoch fencing, FU-49 | **Met.** A stale holder cannot send after a takeover. FU-49 is measured: consistent with F-TR-7 as written, with no fencing hole and no starvation. Cost noted in SEC-F-I2. | ev:ev-mv452q7k-0170c0b2 |
| 4. Supplier refusal / re-plan queue | **Met.** No cross-supplier or cross-café effect. The reason is bounded (after NFC) and rendered as text in Chromium. Info: SEC-F-I4, SEC-F-I6. | ev:ev-mv457l53-01b9bd8b, ev:ev-mv457rbc-01dec9c1, ev:ev-mv45fi73-01be9d51 |
| 5. Recovery UI honesty | **Met.** A failed refund never reads refunded. `failed_needs_attention` and "Contact the organiser" are shown. The admin text says "requested", never "returned". Stranded operations are listed. Info: SEC-F-I1, SEC-F-I7. | ev:ev-mv44uzzh-01744558 (M4, M4b), ev:ev-mv458yvn-01f5e741 |
| 6. Simulation honesty | **Met.** Every phase F payment fact is fake-only and labelled LIVE-DEPENDENT. LIVE-P1, LIVE-P2 and OQ-D5 stay open, with no live claim. One wording nit is in SEC-F-I1(c). | submission "What is REAL and what is SIMULATED"; followups item 18 |
| Plan commands f1-f4 | **All pass** on the submission tree. f4 ran inside the suite lock. | ev:ev-mv458gda-0103bee1, ev:ev-mv458xpq-0152b7bb, ev:ev-mv458yvn-01f5e741, ev:ev-mv45e3qc-011dac75 |

## Evidence (security-reviewer, gate phase:f-compensation, all after sub-mv44juz3-01ac72c7)

**Tree.** Every run below carries tree digest `a9aba38c…`, the digest of the submission's last `npm test`
(ev:ev-mv44j3fw-01fb2787).
- HEAD moved from `aab23e6` to `d53c304` during the review, through record-only commits. `git diff aab23e6..HEAD` over
  src/test/public/scripts/package.json is empty.
- All 61 submitted artifacts still match their recorded sha256 (ev:ev-mv45g2ab-014fd54e, run last).

**Safety.**
- Loopback only: every probe ran under `./test/helpers/net-guard.js`.
- `RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` were never set, and no live suite was run.
- The one full-suite run was inside `flock /tmp/rescuestock-suite.lock` (dec-mv43s14b-01addb18).
- No source or test file in the real tree was edited.
- Mutants and the browser probe ran in scratch copies, each in its own directory, with `node_modules` symlinked:
  - `sec-f/mut-MB/` (diff kept as `sec-f/mut-MB.diff`);
  - `sec-f/browser-copy/` (app code identical: `diff -rq` of src and public is part of the recorded command; one added test file).

**Probes.** They live in `/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/sec-f/`, with shared
set-up in `common.mjs`.
- The real void port is installed, as `src/main.js` L125 does.
- Each probe prints PASS/FAIL lines and "ALL EXPECTATIONS MET". A line marked `-GAP`/`-OBS`/`-INFO` passes when the gap or
  behaviour it documents is present.

| ev id | what | result |
|---|---|---|
| ev:ev-mv44uzzh-01744558 | **P-MONEY** (`p-money.mjs`) M1-M6 | ALL EXPECTATIONS MET |
| ev:ev-mv44xmul-01d64afc | **P-RESET** (`p-reset.mjs`) R1-R7 | ALL EXPECTATIONS MET |
| ev:ev-mv451665-01a9729f | **P-ADMIN** (`p-admin.mjs`) A1-A7 | ALL EXPECTATIONS MET |
| ev:ev-mv452q7k-0170c0b2 | **P-FENCE** (`p-fence.mjs`) F1-F3 | ALL EXPECTATIONS MET |
| ev:ev-mv457l53-01b9bd8b | **P-REFUSE** (`p-refuse.mjs`) S1-S7 | ALL EXPECTATIONS MET |
| ev:ev-mv457rbc-01dec9c1 | **P-RACE** (`p-race.mjs`): execute-first races | ALL EXPECTATIONS MET |
| ev:ev-mv45f6xa-01a86f74 | **P-CARRY** (`p-carry.mjs`): phase E items closed by F | ALL EXPECTATIONS MET |
| ev:ev-mv45f8im-01c9a052 | **P-HANDOVER** (`p-handover.mjs`) | ALL EXPECTATIONS MET (H2-OBS documents SEC-F-I7) |
| ev:ev-mv45fi73-01be9d51 | **Browser XSS** (`browser-copy/test/browser/sec-f-xss.test.js`, Chromium 1280x800) | 1/1 pass |
| ev:ev-mv45a1qw-01b3e8ca | Mutant MB against the f2 plan test files (reproduction) | **56/56 pass: the gap is reproduced** |
| ev:ev-mv45adl5-0146e187 | Mutant MB against rework-5 `admin-basic.test.js` | 17/18, 1 fail: killed (expected) |
| ev:ev-mv45ahqj-01d67bc3 | Mutant MB against P-MONEY | 5 FAIL (M4, M4b): killed (expected) |
| ev:ev-mv458gda-0103bee1 | f1 plan command, verbatim | 40/40 |
| ev:ev-mv458xpq-0152b7bb | f2 plan command, verbatim | 56/56 |
| ev:ev-mv458yvn-01f5e741 | f3 plan command, verbatim (frontend scan + all frontend unit tests) | 205/205 |
| ev:ev-mv45e3qc-011dac75 | f4 plan command, verbatim, inside the suite lock (`npm test && npm run test:browser`) | exit 0 (158 s); browser 14/14, 0 skipped. The `npm test` half passed (the `&&` chain reached the browser part); its counts are not in the recorded tail. |
| ev:ev-mv45g2ab-014fd54e | The 61 artifacts of the submission still have their sha256 | 61/61 |

## Findings

### SEC-F-1 (minor): no f2 test reaches the rejected-refund mapping; the compensation-path effects of a wrong mapping are unpinned

**Where.** `src/services/calls.js` L295-L297 (`APPLY.refund`, `outcome.kind === 'rejected'` → `refund_failed`). The submission
and followups item 19 disclose that no f2 test reaches it.

**Reproduction.**
- **The mutant.** Mutant MB (`sec-f/mut-MB.diff`) changes L296 so that a provider-rejected refund is recorded as `refunded`.
- **The f2 files miss it.** All five f2 test files, 56 tests, still pass against it (ev:ev-mv45a1qw-01b3e8ca).
- **What kills it.** Rework-5's `admin-basic.test.js` kills it (ev:ev-mv45adl5-0146e187), but only through the admin
  `refund_order` path.
- **What the mutant does on the compensation path.** My P-MONEY M4, run against the mutant (ev:ev-mv45ahqj-01d67bc3): B's
  capture is declined and A's compensation refund is rejected by the provider (`http_422:refund`, no money returned at the fake).
  The mutant then:
  - records A as `refunded`;
  - releases the reservation and writes restock rows;
  - shows the buyer `rescueStatus: cancelled` ("Captured payments are being refunded…") with A `refunded`.

  So the buyer is told the money came back when it did not, and the stock is restocked as if the purchase were unwound.

**Today's code is correct.** On the real tree:
- M4: A `refund_failed` / `INJECTED_UNPROCESSABLE`; reservation `reconciling` with `REFUND_FAILED` and no restock; buyer
  `failed_needs_attention` ("Contact the organiser").
- M4b: the same through `refund_order`.

Evidence: ev:ev-mv44uzzh-01744558.

**Impact.** This is a regression risk on a money-honesty path, not a present defect. The suite still kills MB, through one
admin-path test owned by another gate.

**Resolution condition.**
1. An f2-side test in `test/api/capture-compensation.test.js` (or `void-capture-race.test.js`) covers a compensation whose
   refund is **rejected** by the provider (e.g. fault `http_422:refund`). It asserts:
   - `refund_failed` with the provider issue;
   - the reservation stays `reconciling` with `escalation = REFUND_FAILED` and no restock row;
   - the buyer view reads `failed_needs_attention`.
2. That test turns red under mutant MB.

Owner: test-engineer or the f2 owner via a follow-up or rework. Not blocking this gate.

### Info

**SEC-F-I1. The forced reset's `stranded` list does not say which captured money is owed back** (ev:ev-mv44xmul-01d64afc
R2, R4, R5, R7).
- **(a) Captured entries look alike.** An operation `captured` with `cancel_requested_at` set reads exactly like a completed
  sale: same keys, `status: captured` (R7). That is an operation in the FU-34 window, or one whose compensation was not yet
  queued.
- **(b) Executing plans are not compensated.** A forced reset of an `executing` plan archives its captured operations as they
  are and does not refund them (R2, R4, R5: A stays captured and is listed). This is what SEC-11 specifies ("listed for
  manual clean-up"), and nothing is silent: each one is listed with provider ids in the response and the audit.
- **(c) The wording assumes the Sandbox.** The admin screen always says "Check each one in the PayPal Sandbox dashboard"
  (`public/js/views/admin.js` L130). With the fake provider there is no dashboard, and the reset has just deleted the fake's
  records.
- **Suggestion.** Add `planStatus` and `cancelRequested` (or `owedRefund`) to each stranded entry. Word the intro by provider.
  Alternatively, a forced reset first runs the compensation hook for captured+cancelled operations.
- Money impact is Sandbox-only by design.

**SEC-F-I2. FU-49, measured** (ev:ev-mv452q7k-0170c0b2 F1-F3).
- **The state.** A capture timed out (nothing applied). The reconciler read CREATED and restored A to `authorized` with its
  capture call `unknown`. Every later read fails.
- **What 10 ticks give.** `lease_epoch` +10, `saga.takeover` audit rows +10, two provider reads per tick, and **zero
  capture sends**. When the reads recover: exactly one re-send of `so:<A>:capture:1`, two captures in all, plan `executed`.
- **F-TR-7 as written: consistent.** F-TR-7 and the takeover rule speak of *operations* in `capture_pending`/`unknown`.
  Here the operation is `authorized`, because the provider showed CREATED. The F3 control shows a `capture_pending`
  operation still keeps the epoch constant over 8 ticks.
- **No fencing hole.** In F2 the holder's own pre-resend read is held while the lease lapses and a takeover (epoch + 1)
  re-sends and executes. The stale read then answers CREATED ("send"), yet the stale holder sends nothing: `sendCapture`'s
  start transaction runs G with the old epoch. It logs `saga.lease_lost`.
- **No starvation:** shown by the recovery above.
- **Cost during a provider outage, per affected plan.** One append-only audit row and one epoch per tick (5,760 a day at
  15 s). No escalation surfaces the plan: the operation is `authorized`, so derivation row 2 and metrics `unresolved` stay
  silent.
- **Suggestion.** On a failed pre-resend read, set `lease_until = now + back-off` instead of `now`. The verification report
  should state the F-TR-7 reading above.

**SEC-F-I3. Some `faults`/`refund_order` calls write no audit row** (ev:ev-mv44uzzh-01744558 M2-GAP).
- These are `refund_order` for an unknown or archived supplier order (404), and every 422 (validation).
- The spec says "Every `faults` and `refund_order` call writes an audit event with the actor and the target ids".
- The 409 refusals are durable (M1: three denied rows from two parallel losers and one late repeat; M2: two).
- The admin is trusted, so this is completeness only.

**SEC-F-I4. The admin `supplier_refusal` reason bypasses the supplier route's checks** (ev:ev-mv457l53-01b9bd8b S7-INFO).
- `applyFault` validates it with `str(1, 300)` only (`src/services/admin.js` L428). It therefore stores ESC/BEL controls and a
  blank reason, which `checkRefusalReason` refuses on the supplier route (S4: all 422).
- The buyer sees it as text.
- **Suggestion.** Use `checkRefusalReason` in `applyFault`.

**SEC-F-I5. Admin metrics `reconciler.unresolved` is 0 while an operation is `refund_failed`** (ev:ev-mv44uzzh-01744558 M4).
- `unresolved` counts only `unknown`, `*_pending` and `void_failed`; it is also 0 for the SEC-F-I2 plans.
- `operationsByStatus` does show `refund_failed: 1`.
- **Suggestion.** Count `refund_failed` and reservations with an `escalation` in `unresolved`, or list them in the verification
  report.

**SEC-F-I6. Bidi override controls are accepted in a refusal reason** (ev:ev-mv457l53-01b9bd8b S2, ev:ev-mv45fi73-01be9d51).
- **How.** `checkRefusalReason` refuses C0 and DEL but accepts U+202E. The server composes one sentence: "Supplier A refused the
  order: <reason>. No money was taken."
- **Effect.** An unterminated RLO in the reason therefore precedes the system's own trailing sentence, which UAX #9 would
  display reversed. I did not check this visually.
- **What is safe.** Markup is inert: in Chromium the payload `<img onerror>`, `<script>`, `<svg onload>` is shown literally on
  the buyer and supplier pages, `window.__xss` stays undefined, and there are no dialogs and no CSP or console problems.
- **What remains.** A supplier can write arbitrary text within 300 characters anyway (RS-17 shows it), so the residual is
  visual garbling of the system suffix.
- **Suggestion.** Refuse or strip U+202A-U+202E and U+2066-U+2069 in `checkRefusalReason`, or isolate the reason (FSI…PDI) when
  composing the message.

**SEC-F-I7. A refunded order can still be marked ready and handed over** (ev:ev-mv45f8im-01c9a052).
- **While the refund is in flight:** ready is 409 `HANDOVER_BLOCKED` for both orders (H1).
- **After the refund completed (`refunded`):**
  - supplier A's card reads `presentation: refunded` with `canMarkReady: true`;
  - `ready` → 200 and `handover` → 200, ending `collected`;
  - the buyer reads `purchase_confirmed`, "Order from Supplier A was refunded by the organiser".

  So the goods are released for a refunded payment (H2-OBS).
- **This matches the brief's literal guard.** The brief's guard (state table, confirmed → ready) blocks on `refund_*`, which
  does not match `refunded`. It also matches spec revision 2 row 7 (OQ-D2), which allows partial refunds.
- `src/services/orders.js` L27 (c3's) is not a phase F file, so this is a product decision, not a phase F defect.
- **Suggestion.** Decide whether a refunded order may still be collected. If not, add `refunded` to `HANDOVER_BLOCKING_PAYMENT`
  for that order only, and the card stops offering "Mark ready".

## (1) Money never moves backward or twice

**P-MONEY** (ev:ev-mv44uzzh-01744558):
- **M1. Concurrent `refund_order` on one captured order of an executed plan.**
  - Three parallel calls give exactly one 200 and two 409 `INVALID_STATE`.
  - One provider refund call and one refund, for `supplier_orders.total_cents` (4000).
  - A later repeat is 409, and five ticks change nothing.
  - Three durable `denied` audit rows plus one `ok` row. B stays captured.
- **M2. Preconditions.**
  - Authorized operation of an approved plan → 409, nothing queued.
  - Captured A of a plan still `executing` (B `capture_pending`) → 409, no refund.
  - Unknown id → 404.
- **M3. Compensation after a partial failure** (capture declined on B):
  - A captured once and refunded once; B voided once.
  - Two reconcilers × 4 ticks add nothing.
  - The reservation is released once, with one restock row per item.
  - `refund_order` on the refunded A → 409.
- **M4, M4b.** A rejected refund ends `refund_failed`, never `refunded`, and never escalates silently (see SEC-F-1).
- **M5. Void after capture** (`capture_lands_after_void_intent` on B during the compensation): B captured → refunded. Two
  completed captures, two refunds, one void attempt.
- **M6.** A refund call forced onto an `authorized` operation is never started, by either the handler or reconciler step 6.
  The refund guard requires `refund_requested`/`refund_pending` and a capture id.

**P-RESET** (ev:ev-mv44xmul-01d64afc), SEC-11:
- **R1. Unforced reset with money held.** 409 `RESET_BLOCKED`, nothing changed, and a durable `denied` audit row (written after
  the rolled-back transaction). Force without a reason → 422.
- **R2. Forced reset of an executing plan** (A captured, B `capture_pending`).
  - Both are listed in `stranded`, with provider ids, in the response and the audit.
  - Afterwards, six ticks with the lease lapsed: no takeover (epoch constant, no takeover row), no provider call at all, the plan
    never `executed`.
  - The stock stays exactly at the restored catalog, with ledger sums equal to the columns.
  - The request is 404 to the buyer, and `refund_order` on the archived A is 404. This is FU-48, confirmed fenced.
- **R3. Authorized operations.** Voided at the provider before the archive (2 sent voids, journal `succeeded`), nothing
  stranded.
- **R4. Capture applied at the provider with its answer held during the reset.** The reset's void is rejected, the read shows
  CAPTURED, and B is refunded before the archive (`so:<B>:refund:1` succeeded). The late capture answer changes nothing.
- **R5. Capture request held before the provider.** The reset voids B first, and the late capture is refused. B is never
  captured.
- **R6. An `unknown` refund** (`lost_response:refund`): the read-resolve pass resolves it to `refunded`, so it is not stranded.
- **By reading `calls.js` `startCall`.** A call or operation archived by a reset is never started again (`archived_at` checks
  inside the start transaction). Every path that could send after the archive goes through it: the saga capture, the
  reconciler's re-sends, and the refund queued by `resolveRejectedVoid`. A pass interrupted by the 30 s budget can still
  *record* a read after the archive, but cannot send money.

**Takeover, restart, return-crash.**
- f4's multi-process files (`rs26-restart`, `lease-takeover` A/B with SIGSTOP/SIGCONT, `return-crash` a/b/c) ran inside my f4
  plan command run (ev:ev-mv45e3qc-011dac75, exit 0).
- My in-process P-FENCE F2 adds the stale-holder-in-read case.
- P-CARRY C3 (ev:ev-mv45f6xa-01a86f74): an `unknown` capture that was in fact applied is never re-sent (one capture call for A),
  even when the reconciler's own read fails. This is SEC-E-1 recommendation 5 / FU-41(a), closed.

## (2) Admin fault routes

**P-ADMIN** (ev:ev-mv451665-01a9729f):
- **A1.** Anonymous 401, and customer (owner and stranger) and supplier 403, on reset and on every fault kind. Timeline and
  metrics are also 403. Nothing changed.
- **A2.** An admin session with a wrong CSRF token, a foreign Origin, or no token → 403.
- **A3/A4, over raw sockets as a customer with a valid CSRF token.** Every trick is 4xx and never reaches a handler, and nothing
  changed:
  - 405: GET, PUT, PATCH, DELETE, OPTIONS, HEAD;
  - 400: lowercase `post`, `//api/...`, absolute-form URI;
  - 404: trailing slash, `/api//admin`, case changes, `%66aults`, `;x=1`, `%00`, `%2F`;
  - 403: dot segments (normalised, so the role check applies), query and fragment;
  - 405 with no effect: `X-HTTP-Method-Override`, `X-Original-URL` and `X-Rewrite-URL`.

  Control: the same raw request with the admin session is 200.
- **A5.**
  - String, float, negative, huge or missing `supplierOrderId`, and an array or wrong-case `kind`: all 422.
  - Extra keys (`amountCents`, `__proto__`) never choose the amount: every refund is the full `total_cents`.
- **A6.** The test-only faults are 422 without `RS_TEST_HOOKS`.
- **A7.** After a forced reset, `refund_order` on the archived operation → 404, nothing sent.

## (3) Fencing and FU-49

See SEC-F-I2. F1-F3 in ev:ev-mv452q7k-0170c0b2.

## (4) Supplier refusal and the re-plan queue

**P-REFUSE** (ev:ev-mv457l53-01b9bd8b):
- **S1.** Supplier B refusing or confirming supplier A's order → 404, and a customer on the supplier route → 403. Nothing
  changed.
- **S2.** Two cafés hold A+B plans. Supplier A refuses cafe1's order:
  - cafe2's plan, reservation, authorizations, queue and void rows are byte-identical before and after;
  - cafe1's re-plan is B+E, without A;
  - the reason (markup + RLO) is stored verbatim, and a second refusal keeps the first reason.
- **S3.** cafe2 gets 404 for cafe1's request. cafe1 receives the reason as a JSON string.
- **S4.**
  - 301 code points, blank, NUL, BEL, ESC, DEL, empty, number, null or array → 422, nothing changed.
  - The bound applies after NFC: 150 × U+0958 + 1 → 422.
  - 300 astral code points (1200 bytes) are accepted.
- **S5.** One refusal voids cafe1's two authorizations once each, and 3 more ticks plus a repeated refusal add nothing.
- **S6 and P-RACE** (ev:ev-mv457rbc-01dec9c1), refuse vs execute in both orders, 22 rounds:
  - never both a refusal and a claim;
  - a refused order is never captured;
  - after the claim the refusal is 409 `ORDER_EXECUTED`;
  - a concurrent `stock_depletion` supersedes nothing after the claim.
- **Browser** (ev:ev-mv45fi73-01be9d51): see SEC-F-I6.

## (5) Recovery UI

- **Failed refunds are never shown as success.** A `refund_failed` operation reads "Refund failed — contact the organiser"
  (`public/js/components/compensation.js` L29). The view model is driven by the server's derivation row 2
  (`failed_needs_attention`, `CONTACT_ORGANISER`). This is confirmed through the real route in M4 and M4b.
- **Admin texts stay neutral.** The `refund_order` result text is "A refund was requested … not complete until PayPal confirms
  it" (`public/js/views/admin.js` L109), and it stays true when the refund then fails (M4b).
- **Stranded operations are listed** (`resetResultModel`, f3's `RS-30 … stranded` test, in ev:ev-mv458yvn-01f5e741). Wording:
  SEC-F-I1(c).
- **Text only.** No markup sink exists in `public/js`: `dom.js` sets text with `textContent` and refuses `on*`, `style` and
  `srcdoc`. The frontend scan passes (ev:ev-mv458yvn-01f5e741).

## (6) Simulation honesty

- Every phase F criterion is labelled fake-only in the submission. The LIVE-DEPENDENT facts phase F relies on are listed:
  `final_capture`, `AUTHORIZATION_ALREADY_CAPTURED`, PayPal-Request-Id retention over a takeover, capture DECLINED/PENDING,
  refund PENDING/FAILED/COMPLETED, the EXPIRED read after a void (FU-45, OQ-D5), void-after-capture answers, and the 29-day
  window.
- RS-32(b) is LIVE-P2 and not claimed. LIVE-P1, LIVE-P2 and OQ-D5 stay open.
- RISK-18's wording mismatch is disclosed (followups item 18).
- My probes are fake-only. The double-send protection across a takeover of a *frozen sender* (ARCH-26 variant B) rests on
  PayPal-Request-Id retention, which stays LIVE-DEPENDENT.

## Phase E security items phase F was to close

| Item | Status | Evidence |
|---|---|---|
| SEC-E-1 rec. 5 (FU-41a: read under the lease before re-sending an unknown capture) | **Closed** | P-FENCE F2, P-CARRY C3; f2's M6 killed (ev:ev-mv418etg-01b71dfe) |
| SEC-E-I3 (expired authorization void falsely escalated) | **Closed** (FU-45): B `voided` with `AUTHORIZATION_EXPIRED`, `void_failed` 0, reservation released, no "contact the organiser". The FU-45 limit still escalates a refused void of a CREATED authorization. | P-CARRY C1, C2 (ev:ev-mv45f6xa-01a86f74) |
| SEC-E-I4 (FU-34 window) | Backstop kept; f2 tests it (`F-TR-6: a webhook capture of a cancelled operation is refunded on the next tick, exactly once`), green in my f2 run. The reset-time view of the window is SEC-F-I1(a). | ev:ev-mv458xpq-0152b7bb |
| SEC-E-I1, SEC-E-I2, SEC-E-I5, SEC-E2-I1 | Not phase F's (FU-44 to g2/g3; accepted; `webhooks.js` unchanged) | — |
| SEC-11 (design) | **Closed** | P-RESET, P-ADMIN |

## Criteria (security view, for the technical-reviewer's record)

| Criterion id | Met | Proving section |
|---|---|---|
| task:f1-supersession-refusal-expiry | yes | `artifact:.eccode/artifacts/phase-f/submission.md#What the phase delivers`; my f1 run ev:ev-mv458gda-0103bee1; P-REFUSE, P-RACE |
| task:f2-compensation-takeover-admin | yes (SEC-F-1 follow-up) | `artifact:.eccode/artifacts/phase-f/submission.md#Criteria → task → tests → evidence`; ev:ev-mv458xpq-0152b7bb; P-MONEY, P-RESET, P-ADMIN, P-FENCE |
| task:f3-frontend-recovery | yes | `artifact:.eccode/artifacts/phase-f/submission.md#What the phase delivers`; ev:ev-mv458yvn-01f5e741; browser ev:ev-mv45fi73-01be9d51 |
| task:f4-restart-takeover-browser | yes | `artifact:.eccode/artifacts/phase-f/submission.md#What is REAL and what is SIMULATED`; ev:ev-mv45e3qc-011dac75 |
| phase:f-compensation | yes | `artifact:.eccode/artifacts/phase-f/submission.md#The phase's own acceptance criteria (plan.json, \`f-compensation\`)` |
| security | yes, with SEC-F-1 routed | this draft |

## What I did not test

- Real PayPal: every LIVE-DEPENDENT fact above.
- The bidi rendering of SEC-F-I6 visually.
- Node 22.5. My runs are on Node 22.22, as the submission discloses.
- The multi-process files ×N. They ran once inside the full suite; f4 ran them ×4 (ev:ev-mv43nz3i-015ad25b).
- A forced reset whose 30 s budget actually expires with a read in flight. That case was analysed by reading `startCall` only.

## Refusals

The guard refused several of my Bash commands. None concerned the real tree:
- in-place `sed`/`patch`-style edits of scratch files whose paths look like project files;
- one inline `python3` file write;
- two `eccode` calls piped into a script.

I redid each with the Write tool or a plain command. No eccode command recorded under another actor.
