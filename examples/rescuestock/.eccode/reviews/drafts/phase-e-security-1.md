# phase:e-payments: security review, iteration 1 (FINAL)

Reviewer: security-reviewer, run run-mv3vuj08-018c990d. Gate: `phase:e-payments`. Submission: `sub-mv3vs3h1-0181fd20`
(76 artifacts; handoffs e0 ho-mv37ojw0-01fb7411, e1 ho-mv38f42c-010fb379 / ho-mv38jhfn-01d2ca04 / ho-mv39x6r0-013c5688,
e2 ho-mv39qe6x-01666ddf, e3 ho-mv3aalih-011f4d67, e4 ho-mv3tpmcv-01dc0d69 / ho-mv3v3asc-01ce3c19, e5 ho-mv37hs3x-01066518 /
ho-mv3v9goy-01de8496, e6 ho-mv3uq93d-0114f12e). The technical-reviewer records the gate; this draft is input to its decision.

Status: FINAL.

## Verdict

- **No blocking finding.** I found no way for a buyer, another customer, a supplier, an admin or an unauthenticated caller to
  change an amount, move money twice, reach another customer's payment, forge a webhook, or read a secret or payer data.
  Every probe of those classes met its expectations (evidence below).
- **One major finding, SEC-E-1.** A late or out-of-order but **genuine** (validly signed) `PAYMENT.AUTHORIZATION.CREATED`
  event moves an operation from `capture_pending`, or from `unknown` whose previous state was `authorized`, back to `authorized`.
  - The spec maps this event "pending → authorized" only (spec.md L420).
  - Reproduced: a purchase whose capture is merely pending is compensated. The buyer is charged and then refunded, B is voided,
    and the plan ends `non_executable` (ev:ev-mv3w48uy-0190adfa S2).
  - Reproduced: a capture whose outcome is unknown is re-sent after a takeover with no successful read before it (S3).
  - Money was neither lost nor doubled in any run; the PayPal-Request-Id replay and `final_capture` held.
  - It is not attacker-exploitable (it needs PayPal's signature), so it is not blocking. It must be fixed before delivery.
- **One minor finding, SEC-E-2.** `GET /api/paypal/return` is a public route, so the general per-user limit does not apply. Each
  hit on the buyer's own unapproved order is one provider `getOrder` with the merchant's credentials: 400 hits gave 400 provider
  calls and no 429 (ev:ev-mv3wkmdf-014def88).
- **Info:** SEC-E-I1 to SEC-E-I5 below.
- **Decisions:**
  - FU-34 / dec-mv3vuigy-0109feb6 (webhook-made captures refunded one tick later): **accepted from security.** No money can be
    lost or doubled in the window (ev:ev-mv3wifuf-01eb0c2d).
  - dec-mv3abkne-01161cf3 (unmapped event type → 400): accepted.
  - dec-mv3abkv0-011839e9 (`RS_PAYPAL_WEBHOOK_ALGOS` from the environment): accepted.
  - dec-mv3vuiqw-01d3c5c9 (four info residuals): unchanged by this phase. SEC-E-2 is related to SEC-R-2 but distinct: provider
    calls, not the victim's budget.
  - dec-mv3vui7s-014f6e7c (FU-35): no security impact.
- **From security: approve the phase on two conditions.** These match the severity rules: a major is fixed before delivery, not
  necessarily before this gate.
  - SEC-E-1 is routed now to a named owner by a recorded decision. No phase F/G task owns `src/services/webhooks.js`; the same
    situation as FU-34.
  - It is fixed and re-verified before delivery.
  - SEC-E-2 should ride the same routing (`src/routes/paypal.js` / `src/services/payments.js`, e2's files).
  - If the orchestrator will not route SEC-E-1 before delivery, security's position is changes required.

## Evidence (recorded by security-reviewer on this gate, after the submission)

Every run used `PATH=/usr/local/bin:/usr/bin:/bin` and loopback only (the fake, its approval listener on 127.0.0.1, and the
paypal-stub on 127.0.0.1). Every in-process probe and every child process ran under `./test/helpers/net-guard.js`.
`RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` were never set to 1, the live suite was never run, and no PayPal host was contacted.

Tree: each run carries tree digest `5f628506…` (the submission's). The code is unchanged since `5e1895b`: no diff under
src/test/public/package.json up to HEAD `38145b5`. All 76 artifacts have the sha256 recorded at submission
(ev:ev-mv3wobh4-019e6eaa, run last).

Probe scripts live in the session scratchpad
`/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/` (`sec-e-*.mjs`, shared set-up
`sec-e-common.mjs`). Each prints PASS/FAIL lines and "ALL EXPECTATIONS MET"; for a REPRO line, PASS means the defect reproduced.

| ev id | what | result |
|---|---|---|
| ev:ev-mv3w0yzr-01677589 | e3 plan command, verbatim | passed: 96 tests, 96 pass, 0 fail, 0 skipped |
| ev:ev-mv3wmh76-0165d4b3 | e2 plan command, verbatim | passed: 92/92 |
| ev:ev-mv3wmvrj-0158f090 | e4 plan command, verbatim | passed: 71/71 |
| ev:ev-mv3wn4dx-01a09cac | `test/integration/rs20-two-process-execute.test.js` (two OS processes; NFR3 live refusals) | passed: 13/13 |
| ev:ev-mv3w48uy-0190adfa | **W-ORDER** (reproduction): late signed `PAYMENT.AUTHORIZATION.CREATED` | ALL EXPECTATIONS MET: S2 and S3 REPRO reproduce; S1 and S4 controls behave |
| ev:ev-mv3w6n02-01e20cac | **W-SEC**: webhook headers, splicing, merchant scope, per-IP limit, body cap, cert URL, unmapped type, payer data, time window, error echo | ALL EXPECTATIONS MET |
| ev:ev-mv3wasl0-0199c6ae | **P-AUTHZ**: RS-27 foreign token/order/plan/request, roles, CSRF scope, RS-19 amounts, stale plan | ALL EXPECTATIONS MET |
| ev:ev-mv3wcx8e-0176eb51 | **P-RACE**: concurrent create/return/cancel/abandon/execute/webhook/two reconcilers, money invariants | ALL EXPECTATIONS MET |
| ev:ev-mv3weypr-01b9ee01 | **P-HOSTS**: fake approval listener, Sandbox host pinning, base-URL allow-list, live files refuse | ALL EXPECTATIONS MET |
| ev:ev-mv3wgm5s-01f3cefb | **P-SECRETS**: Sandbox adapter vs stub, per-supplier, full flow, errors, webhook; secrets/payer scan | ALL EXPECTATIONS MET |
| ev:ev-mv3wifuf-01eb0c2d | **P-FU34**: the one-tick window of dec-mv3vuigy-0109feb6 through the real webhook route | ALL EXPECTATIONS MET |
| ev:ev-mv3wjn71-01f4dee7 | **P-FENCE**: frozen capture sender vs takeover; expired/29-day authorization at the claim | ALL EXPECTATIONS MET |
| ev:ev-mv3wkmdf-014def88 | **P-AMP** (reproduction): provider-call amplification through the public return route | ALL EXPECTATIONS MET (AMP-1 REPRO reproduces) |
| ev:ev-mv3wobh4-019e6eaa | the 76 submitted artifacts still have their recorded sha256 | passed: 76/76 |

I did not re-run `npm test` or `npm run test:browser`. The technical-reviewer runs them on the same tree, as asked by
dec-mv3u4zr4-0165c54d.

## Findings

### SEC-E-1 (major): a late `PAYMENT.AUTHORIZATION.CREATED` rolls a capture back to `authorized`

**Where.**
- `src/services/webhooks.js` L54: `'PAYMENT.AUTHORIZATION.CREATED': { target: 'authorized', lookup: … }` has no `from` list.
- The gate at L261–L263 then admits every edge into `authorized` that the payment table allows, including:
  - `capture_pending → authorized`, which `domain/states.js` allows for `PAYMENT.CAPTURE.DENIED`;
  - `unknown → authorized` when `prev_status` is `authorized` (or `capture_pending`).
- Spec, Interface Contracts › Webhooks (spec.md L420): "`PAYMENT.AUTHORIZATION.CREATED` (pending → authorized)".
- The e3 mapping table in `test/api/webhooks.test.js` L519–L541 has rows for `authorization_pending`, `approved`,
  `unknown(prev approved)`, `authorized`, `voided`, `created` and `unknown(prev refund_pending)`. It has none for
  `capture_pending` or for `unknown(prev authorized)`, so no test notices.

**Reproduction** (ev:ev-mv3w48uy-0190adfa). Each scenario uses its own fresh database, with orders A and B confirmed and
authorized. The event is signed with the fake's HMAC (webhook-signer.js), i.e. it is a genuine event.

- **S1, control:** fault `capture_pending` on A, then execute. When the capture completes, the plan is `executed`, both
  captured, no refund.
- **S2:** the same, plus a late `PAYMENT.AUTHORIZATION.CREATED` for A's authorization while A is `capture_pending`.
  - The event is answered 200 `applied` and A becomes `authorized`.
  - On the next tick the plan is taken over and compensated (`non_executable`, `CAPTURE_FAILED`). The void of A is rejected
    because the provider holds a pending capture; `resolveRejectedVoid` moves A to `capture_pending`. B is voided.
  - When the provider completes the capture, A is captured and refunded. One capture and one refund of the same amount.
- **S3:** fault `lost_response:capture` on A: the capture IS applied and A is `unknown(prev authorized)`.
  - The late event moves A to `authorized`; its capture call stays `unknown`.
  - On the next tick the reconciler's read fails (a `retryable` 429, injected by wrapping `getAuthorization` / `getOrder`), the
    plan is taken over, and the lease holder re-sends `so:1:capture:1`.
  - The fake answers it from the PayPal-Request-Id replay (`replayed = 1`); no second capture.
- **S4, control:** `authorization_pending → authorized` (the intended edge) still works.

**Impact.**
- **No attacker is needed, and none can use it.** It takes a validly signed event. PayPal may deliver such an event late: it
  retries for up to three days, and this route answers 503 whenever verification is unreachable.
- **(a)** A purchase that would have succeeded is cancelled: the buyer is charged and refunded, and the confirmed supplier orders
  read `cancelled_payment_incomplete`.
- **(b)** The read-before-resend layer of the "why no double capture" argument (spec Payment saga, layer 3; Step 6 "before any
  send, the new holder reads provider state") is skipped:
  - The saga treats an `authorized` operation with an `unknown`, token-less capture call as resendable
    (`src/services/saga.js` L552, L559).
  - The takeover query excludes only plans with `capture_pending`/`unknown` operations (`src/services/reconciler.js` L380),
    not plans with an `unknown` capture call.
  - Money is then protected only by layers 4–5: the same PayPal-Request-Id, and `final_capture`. Both are LIVE-DEPENDENT for
    the Sandbox (request-id retention, RISK-3/RISK-13).
- No money was lost or doubled in any run.

**Resolution condition.**
1. Give `PAYMENT.AUTHORIZATION.CREATED` a `from` of `['approved', 'authorization_pending']`. `approved` is kept because the
   event may beat the return handler's own answer. The existing `effective = prev_status` rule then still lets
   `unknown(prev approved | authorization_pending)` resolve.
2. Every other origin is flagged `TRANSITION_NOT_ALLOWED`: `capture_pending`, `unknown(prev authorized | capture_pending)` and
   the rest.
3. Add rows for `capture_pending` and `unknown(prev authorized)` to the e3 mapping table.
4. Re-run W-ORDER unchanged: its S2 and S3 REPRO lines must then FAIL, and S1/S4 must still pass.
5. Recommended, for f2 (owner of saga.js): defence in depth in `captureLoop`. Before re-sending a capture call that is
   `unknown`, read the authorization under the lease, as Step 6 of the spec says, rather than relying on the reconciler's step-2
   read of the same tick.
6. Owner: no F/G task owns `webhooks.js`, so this needs a decision naming one (as for FU-34).

### SEC-E-2 (minor): unthrottled provider reads through the public return route

**Where.**
- `src/routes/paypal.js` L31 registers `GET /api/paypal/return` with `policy: 'public'`.
- `src/auth/rbac.js` L14: "Public routes are not passed to this hook", so the 300/min general limit does not apply.
- `src/services/payments.js` L200 calls `getOrder` on every hit while the operation is `created`.

**Reproduction** (ev:ev-mv3wkmdf-014def88).
- One signed-in buyer made 400 return hits within one (pinned) minute on their own unapproved order: 400 provider `getOrder`
  calls, all 303, no 429.
- Control: 400 "try again" `paypal/create` calls are cut at 300 by the general limit.
- Anonymous hits make no call.

**Impact.**
- Availability, not money or data. One account (registration is open) can drive unbounded reads against the merchant's PayPal
  credentials for as long as its reservation lives (30 min). It can then repeat with a new request: 10 per day.
- PayPal's rate limit is per app/merchant, so in single-credential mode it throttles every buyer's payment calls
  (`retryable` → 503 / back-off).

**Resolution condition.**
- A test shows the return route bounded per identified user, for example:
  - apply the general limiter after `ctx.auth.identify` in `buyerRoute`; or
  - allow at most one `getOrder` per operation per few seconds, answering `check_failed` otherwise.
- The 300/min of "try again" (AMP-2) is within the documented general limit (delta 8); I raise no finding for it.

### Info

**SEC-E-I1. The offline webhook signatures are not bound to the merchant.**
- The fake's HMAC (`src/payments/fake.js` `fakeWebhookSignature`) and the stub's scheme sign
  `transmissionId|time|sha256(body)` with one secret. Bytes signed for merchant A therefore also verify under `/B`
  (W-SEC S4; P-SECRETS E-6b: the stub was called with B's webhook id and verified).
- Offline this is contained by the global dedupe on transmission id and by SEC-16 scoping: the event is `ignored` and nothing
  applies to A.
- Real PayPal binds `webhook_id` into the signed string, so cross-merchant rejection is **LIVE-DEPENDENT** (LIVE-P1 RS-24).
- Suggest that g2/g3 add `merchantKey` to the fake's signing string, so the offline model matches.

**SEC-E-I2. Duplicate oracle.**
- The duplicate check runs before verification. A forged body under an already-valid transmission id gets 200 `duplicate`
  (no verification, no row, no effect: W-SEC S11).
- This reveals only whether an id was seen. Transmission ids are not secret but are not guessable either. Accept.
- Dedupe is by transmission id, not event id. A PayPal retry with a new transmission id is re-applied, and the state CAS makes
  that a no-op (`ALREADY_IN_STATE`), except for the edge in SEC-E-1.

**SEC-E-I3. An expired authorization cannot be voided.**
- It stays `authorized` with `void_failed = 1` (P-FENCE F-2: A voided, B `EXPIRED` at the provider, B `void_failed`), so
  derivation row 2 escalates a case where no money is held.
- Disclosed as remaining issue 9 (f2). Suggest treating EXPIRED read back after a rejected void as settled.

**SEC-E-I4. The FU-34 window, judged** (ev:ev-mv3wifuf-01eb0c2d, through the real webhook route).
- A compensating plan's `capture_pending` operation is moved to `captured` by `PAYMENT.CAPTURE.COMPLETED`, with no refund
  queued.
- In the window:
  - a second COMPLETED event is `ignored`;
  - execute and abandon are 409;
  - `releaseIfSettled` answers `waiting`, so the reservation stays `reconciling` and nothing is restocked;
  - no capture is sent.
- The next tick, with two reconcilers at once plus another duplicate event, gives exactly one refund call row and one provider
  refund for the captured amount. The reservation is then released with one restock per item, and a further tick changes
  nothing.
- The backstop is a query on stored state, so the window survives a restart and closes at the next tick of any process.
- Money is neither lost nor doubled. Accept dec-mv3vuigy-0109feb6.

**SEC-E-I5. The return handler does not check that the reservation is unexpired before authorizing** (by reading:
`src/services/payments.js` L194–L232; the spec's steps 1–6 do not require it).
- An authorization can therefore be taken in the gap before the expiry pass. The next pass voids it (void rule on
  `RESERVATION_EXPIRED`).
- No money is captured. Not demonstrated separately; no action needed.

## Class by class (the brief's seven areas)

### 1. Amount integrity (RS-19)
**Met.** Evidence: ev:ev-mv3wasl0-0199c6ae, ev:ev-mv3wgm5s-01f3cefb, ev:ev-mv3wmh76-0165d4b3.

- **Tampered create body.** The body carried `amountCents: 1`, an EUR amount, `merchantKey: DEFAULT`, `supplierCode: C`, foreign
  return URLs, `requestId` and `attempt`.
  - The provider order still has `supplier_orders.total_cents`, USD, the order's own merchant (A) and the app's
    `RS_PUBLIC_URL` return/cancel URLs.
  - The PayPal-Request-Id is the server's `so:<id>:create_order:1` (AMT-1).
- **Return query** with `amount`, `currency`, `return=` and a forged `PayerID`: ignored. The 303 goes to the fixed SPA path, and
  the authorization equals the total (AMT-2).
- **Execute body** with `amountCents: 1`: each capture equals the authorization, the provider order and the supplier-order total
  (4000 / 4400). `payment_operations.amount_cents`, which refunds use, equals the total for every operation (AMT-3).
- **Sandbox wire.** Captures carry `final_capture: true` and USD. The refund body is the captured amount in USD (P-SECRETS E-5b).
- **Stale plan version.** After a price change supersedes the approved plan, `paypal/create` on its order is 409
  `PLAN_SUPERSEDED` with no provider call (AMT-4).
- **A second order.** An A13 re-create replaces `provider_order_id`, so the old token is 404 at return. An old PayPal order is
  never authorized, and intent AUTHORIZE moves no money without our authorize call.
- **Rounding and currency.** `toPayPalValue` is integer-only. Arguments are checked at the port (1..999,999,999 cents, USD only;
  `provider.js` L69–L98), the DB has a CHECK on currency, and `total_cents` is never updated after insert (no `UPDATE … total_cents`
  in `src/`).

### 2. Double spend and races
**Met, except SEC-E-1(b).** Evidence: ev:ev-mv3wcx8e-0176eb51, ev:ev-mv3wjn71-01f4dee7, ev:ev-mv3wn4dx-01a09cac,
ev:ev-mv3wmvrj-0158f090.

- **Create (R1).** Five concurrent creates give one `create_order` and one link.
- **Return (R1).** Five concurrent returns plus a cancel give one authorize.
- **Return vs abandon (R2, 4 rounds, both orders).** The plan is abandoned, at most one authorize per order, every CREATED
  authorization voided, no capture.
- **Execute vs abandon (R3, 4 rounds).** Exactly one wins: execute twice (2 captures, 0 voids) and abandon twice (0 captures,
  2 voids). The loser is 409.
- **Ten concurrent executes (R4).** One 202, nine 200 `{claimed:false}`, one capture per order.
- **Webhook + two reconcilers + abandon on a pending authorization (R5).** One void row, one void sent.
- **Lost authorize + abandon + two reconcilers (R6).** One authorization, one void.
- **The invariant** "no operation has both a sent capture and a void call" held in every race.
- **Two OS processes** (e6's rs20 file): 13/13.
- **Lease fencing (P-FENCE F-1).** A capture send is frozen past the lease.
  - The reconciler marks it unknown, reads (no capture yet), restores `authorized` and takes over (epoch 1 → 2). The new holder
    re-sends the same key and the plan executes.
  - The released stale send reaches the provider as a replay (`replayed = 1`, still one capture per authorization).
  - Its result is fenced: `provider.result_fenced` and `saga.lease_lost` are logged, and neither the operation row nor the
    call row changed. **A stale executor cannot record a result.**
- **Never capture after a void intent.**
  - The claim (one `BEGIN IMMEDIATE`) refuses any operation that is not `authorized`.
  - The capture start requires `G(now)` with plan `executing`.
  - Every path that sets `cancel_requested_at` on an executing plan also moves the plan off `executing` (compensation under G).
  - R3 and the invariant check confirm it.
- **The exception** is SEC-E-1(b): a capture re-send without a fresh read when a late event moved the operation out of `unknown`.

### 3. Authorization
**Met.** Evidence: ev:ev-mv3wasl0-0199c6ae, ev:ev-mv3weypr-01b9ee01.

- **RS-27.** Customer cafe2 used cafe1's token after cafe1 approved it at the (fake) PayPal page, so the order was APPROVED and
  not yet returned.
  - Return 404 and cancel 404, with zero provider calls, the operation row byte-identical, and no ok audit (AUTHZ-1).
  - cafe2 on cafe1's order, plan and request: create, receipt, execute, abandon and view all 404, no call (AUTHZ-4). Receipt on
    the executed order: 404 (AUTHZ-6).
- **Roles on the buyer payment routes.** Supplier and admin are 403 on return, cancel, create, execute and abandon; anonymous is
  303 to `/#/signin?notice=paypal-return` on return/cancel and 401 on create (AUTHZ-2, AUTHZ-5).
- **Tokens.** Malformed (empty, spaces, 65 chars, `../`, NUL, RLO) → 400; missing → 400; unknown → 404; a repeated `token`
  parameter is not a 500 (AUTHZ-3).
- **CSRF scope.**
  - `paypal/create` without the token or from another Origin, and abandon with a wrong token: 403, no provider call (CSRF-1).
  - The exemptions are exactly `GET /api/paypal/return`, `GET /api/paypal/cancel` (public, identify themselves) and
    `POST /api/webhooks/paypal/:merchantKey` (signature). POST on return, GET on create and PUT on the webhook are 405 (CSRF-2).
  - The two side-effecting public GETs are owner-scoped, need the unguessable token, and authorize only what PayPal reports
    APPROVED.
- **Fake approval listener (P-HOSTS).**
  - One CSP header, exactly `default-src 'none'; style-src 'self'; form-action 'self' <appOrigin>; frame-ancestors 'none'; base-uri 'none'`,
    and no script (L-1).
  - Host `evil.example`, `evil.example:<port>` and another port → 421 (L-2).
  - Only the three routes: other paths 404/400, wrong method 405 (L-3).
  - Redirects go only to the stored URLs; query and form fields are ignored (L-4). The approve body is capped at 4096 → 413 (L-5).
  - The stored URLs are the app origin (L-6).
  - It refuses to start with the Sandbox provider, on 0.0.0.0, on a public IP and on `localhost` outside test mode (L-7).
  - Config refuses `RS_FAKE_APPROVAL_HOST=0.0.0.0` (L-8).

### 4. Webhooks
**Met, except SEC-E-1.** Evidence: ev:ev-mv3w6n02-01e20cac, ev:ev-mv3w0yzr-01677589, ev:ev-mv3wgm5s-01f3cefb.

- **Header case:** no effect (S1).
- **Duplicated headers** (Node joins them with ", "):
  - `transmission-sig` (valid + garbage, or valid twice) → 400 `SIGNATURE_VERIFICATION_FAILED`;
  - `transmission-id` → 400 `TRANSMISSION_ID_INVALID` before any provider call;
  - `auth-algo` → 400 `AUTH_ALGO_NOT_ALLOWED` (S2).
- **Body splicing.** Trailing space, leading newline, BOM prefix, a second JSON value and a duplicate `event_type` key added to
  signed bytes: each 400, no transition (S3).
  - In the Sandbox adapter the raw bytes are spliced only after `JSON.parse` proves they are exactly one object, so the
    `webhook_id` cannot be overridden (`sandbox.js` L314–L338).
- **Merchant scope.**
  - A valid event re-posted under another key is a 200 `duplicate` with no row, and B is unchanged.
  - An event naming B's authorization posted to `/A` is `ignored` (SEC-16).
  - Archived operation → `ignored`.
  - Keys `X`, `default` and `a` → 404 with no row; encoded `..%2FA` and `DEFAULT%00` → 400 with no row (S4, S5).
  - In single-credential mode only DEFAULT is active (`merchants.js` L23–L35, by reading).
- **Per-IP limit.**
  - 60 then 429, even with a fresh `X-Forwarded-For` each time. `trustProxy` is off, and when it is on the *last* XFF hop is
    used (`client-ip.js` L65–L72).
  - A refusal writes no row, and the window slides (S6).
- **Body cap.** 65,536 bytes are read; 65,537 → 413, also chunked without Content-Length (S7).
- **Cert URL** (eight look-alikes: suffix, fragment, http, port, userinfo, `evilpaypal.com`, IP, `file:`):
  - each is refused with 400 `CERT_URL_INVALID` and no provider call;
  - a `paypal.com` URL is accepted and never contacted (net guard: 0 attempts) (S8).
- **Unmapped type** → 400 `EVENT_TYPE_NOT_MAPPED`, zero provider calls; `__proto__` and `constructor` → 400 (S9).
- **Payer data.** None of the payer markers in a valid, signed event (and in a forged one) reach the responses, log lines,
  `webhook_events` or `audit_events` (S10).
- **Dedupe only among valid rows.** A forged event first does not block the genuine one with the same transmission id (S11).
- **Time window.** An event 16 minutes old → 400 with no provider call (S12).
- **Error bodies** are `{code, message, requestId}` only, with no echo (S13).

### 5. Secrets and payer data
**Met.** Evidence: ev:ev-mv3wgm5s-01f3cefb, with d5's scan approach extended to payments.

- **Set-up.** Per-supplier mode with five fake credential sets with unique markers, against the stub. The flow:
  - provider errors: 401 on the token → 503; 400 with the stub's body marker → 502 `{issue: INJECTED_BAD_REQUEST}`;
    5xx → 503;
  - a failed order read → `check_failed`;
  - approve, return and authorize;
  - execute with B's capture declined: A captured then refunded, B voided;
  - a signed webhook with payer data, verified at the stub with merchant A's webhook id, and again under B.
- **Scan.** 56 log lines, 24 HTTP answers (headers and bodies) and every row of all 38 tables were searched for 29 markers:
  - 5 client ids, 5 client secrets, 5 Basic credentials, 5 webhook ids;
  - every access token the stub issued;
  - the 6 payer data values;
  - the stub's error-body marker.
- **Result: zero hits.** The scan is not vacuous: the stub did send payer data and the body marker to the adapter (S-1, S-1b).
- Config errors for a refused base URL never carry a credential value (P-HOSTS H-3).

### 6. Reconciler and saga
**Met, except SEC-E-1(b).** Evidence: ev:ev-mv3wifuf-01eb0c2d, ev:ev-mv3wjn71-01f4dee7, ev:ev-mv3wcx8e-0176eb51,
ev:ev-mv3wmvrj-0158f090.

- **Read-before-resend** holds on every reconciler path I read (`reconciler.js` `resolveAuthorize`, `resolveCapture`,
  `resolveVoid`, `resolveRefund`): every re-send follows a read and uses the same key.
  - P-FENCE F-1 shows the read (`get_authorization`) before the takeover's re-send.
  - The saga path in SEC-E-1(b) is the exception.
- **Unknown outcomes** are covered by e4's RS-25 tests (passed in my e4 run). P-RACE R6 covers a lost authorize with a racing
  cancellation: exactly one void.
- **Refund on a captured superseded order.**
  - The compensation path queues `refund:1` in the same transaction (P-SECRETS E-5: A refunded).
  - The webhook path waits one tick (SEC-E-I4): no loss or doubling; one refund across two reconcilers and duplicate events.
  - The admin `refund_order` uses the same UNIQUE key `so:<id>:refund:1` (`admin.js` L284), so a second refund cannot be
    queued.
- **29-day expiry.**
  - A fresh authorization is stored as expiring 29 days after creation (F-2b).
  - An already-expired authorization (fault `auth_expire`) makes execute 409 `AUTHORIZATION_EXPIRED` with no capture, and the
    other authorization is voided (F-2).
  - The 30-minute reservation TTL makes the 29-day boundary unreachable in normal use. The honour window is LIVE-DEPENDENT
    (RISK-13).

### 7. Live files and host pinning
**Met.** Evidence: ev:ev-mv3weypr-01b9ee01, ev:ev-mv3wn4dx-01a09cac.

- **The live files refuse without the flag.**
  - Each of the six `test/live/paypal/*.test.js` files exits 2 with empty stdout and the fixed message, with credentials set and
    `RS_LIVE_PAYPAL` in {unset, `0`, `''`, `true`, `yes`}: 30 runs, each under the net guard.
  - No credential value was echoed and no network attempt was made (LIVE-1).
- **The approval link host is pinned.** Outside test mode only `https://www.sandbox.paypal.com[:443]` is accepted. Refused
  (H-1):
  - `www.paypal.com` (live);
  - the suffix look-alike;
  - a path containing the host;
  - http;
  - port 8443;
  - userinfo;
  - `sandbox.paypal.com`;
  - `javascript:`;
  - loopback.
- In test mode only a loopback http link is accepted (H-1b).
- **Through the app:** a stub answering with a `www.paypal.com` link gives 502 `APPROVAL_HOST_INVALID`, and no link is stored or
  shown (H-4).
- **API base.** The adapter refuses `api-m.paypal.com` (also in test mode), look-alikes, and loopback without test mode (H-2).
  The config refuses the live host, and refuses loopback without `RS_TEST_OFFLINE=1` (H-3).
- **Frontend.** It navigates to the approval link only through `isNavigableUrl` (http/https only), via `location.assign`
  (`public/js/views/request-detail.js` L272–L273, by reading).

## What I did not test

- **Anything against real PayPal (LIVE-P1, LIVE-P2, OQ-D5).** Every guess the stub encodes stays unverified:
  - issue names, link rels, approvable statuses;
  - `final_capture` refusing a second capture under a new request id;
  - PayPal-Request-Id retention;
  - the verify-webhook request shape;
  - whether PayPal's signature binds the webhook id (SEC-E-I1);
  - real event ordering and retries (SEC-E-1's likelihood);
  - the honour window.
- **Multi-process races other than e6's two-process execute.** Return and webhook were raced in one process on one SQLite file.
  The CAS/UNIQUE logic is the same, but the SIGSTOP freeze hooks and f4's restart/takeover tests are phase F.
- **Admin forced reset and `refund_order`** with in-flight sagas (phase F files), beyond reading the refund key.
- **The browser journey and the e5 UI**, beyond reading the approval-URL navigation guard. Not re-run by me.
- **`npm test` and `npm run test:browser`** (the technical-reviewer runs them). The e0, e1, e5 and e6 plan commands, except
  e6's rs20 file.
- **TR-R4-3 (short transactions).** Not probed; `db.tx` refusing async callbacks was read only.
- **Mutation testing** of the payment code.

## Suggested security entries for the technical-reviewer's review JSON

Free-form criteria (met: true; each cites the evidence above and this draft's sections):
- `security-amounts`: section 1.
- `security-races`: section 2 (with SEC-E-1(b) open).
- `security-authz`: section 3.
- `security-webhooks`: section 4 (with SEC-E-1 open).
- `security-secrets`: section 5.
- `security-saga`: section 6.
- `security-live-hosts`: section 7.

Findings to fold:
- SEC-E-1 (major), with the evidence and the resolution condition above.
- SEC-E-2 (minor).
- SEC-E-I1 to SEC-E-I5 (info).
- FU-34 accepted from security (SEC-E-I4).

## Guard refusals during this review (verbatim; no eccode command was refused)

1. `PreToolUse:Bash hook error: This command changes directory (cd/pushd/popd) and then writes the relative path "sec-e-webhook-order.mjs", which the guard cannot bind to a file. Write it with a path relative to the project root in a command without cd, or use the Edit/Write tool so ownership can be checked.`
   Redone with an absolute scratchpad path. Correct refusal.
2. `PreToolUse:Bash hook error: security-reviewer reviews/designs but does not edit project files; write drafts under .eccode/artifacts/ or .eccode/reviews/drafts/.`
   A `sed -i` on a scratchpad file named through a shell variable. Redone with the literal absolute path and accepted. Correct
   by the no-shell-variable rule, though the target was outside the project.
3. `PreToolUse:Bash hook error: Inline python3 code in this command calls a file-writing API (open(p,'w') and the guard cannot see which files it would change. Use the Edit/Write tool for file changes so ownership can be checked, or save the script under your draft area (.eccode/drafts/), run it from there and declare its outputs.`
   Redone with `sed` on the literal scratchpad path. Correct refusal.
