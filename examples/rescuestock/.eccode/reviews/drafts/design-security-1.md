# Security review: RescueStock design specification (revision 1)

Reviewer: security-reviewer. Run: run-mv1c7dmr-01d56fb8. Gate: design (recording reviewer: technical-reviewer).
Target: `.eccode/artifacts/design/spec.md`, sha256 `ea9c0c68c84ee761210a4271b4a5148a90623c54a085dab8281b3e73d4595b2c` (submission sub-mv1c60sc-01174690). Contract: `.eccode/artifacts/architecture/brief.md`. Every check below ran against this exact hash, which each log prints.

## Verdict
**I would not block the gate.** The money and authorization core holds:
- Amounts come only from `supplier_orders.total_cents`.
- Approval needs `planHash` and `expectedTotalCents`.
- Owner scope is applied in SQL, and the PayPal return/cancel handlers do their owner check before any provider call.
- Webhook dedupe counts only valid signatures.
- Claim, lease epoch and `send_token` fence the saga.
- The PayPal base URL and approval host are allow-listed.
- The CLI runs with `--safe-mode` and `--tools ""`.
- Model output reaches only proposals that the buyer confirms.

My structural walk found no mutating route without an authentication rule, a CSRF rule and an idempotency rule. It found no orphan error code, and the only side-effecting GETs are the two owner-checked PayPal routes (ev:ev-mv1chwe5-0199c200, passed).

Three **major** findings should be fixed in a spec revision before approval, or recorded as risks with owners (`eccode risk add`) if the gate approves as is:
- **SEC-1:** anonymous lockout of the admin, supplier and customer accounts.
- **SEC-2:** one customer can hold all stock.
- **SEC-3:** a loopback PayPal stub runs under `npm start` labelled "PayPal Sandbox" (RS-34).

Each fix is a few lines of spec. The minor and info findings can be taken into the implementation plan.

## Evidence recorded
| ev id | what | result |
|---|---|---|
| ev:ev-mv1chwe5-0199c200 | Spec walk (`.eccode/drafts/sec-design-spec-walk.mjs --structural`). Checks that each of the 23 mutating routes has a matching RBAC group, the CSRF rule (webhook exempt, signature only) and an idempotency rule. Also checks that all 44 catalog codes are produced (by name, by HTTP status in a route row, or by router/body.js) and that the only side-effecting GETs are PayPal return/cancel. | passed |
| ev:ev-mv1chwnv-0109783d | Spec probes H1–H15 (`--probes`). Each hypothesis is tested against the exact spec text and quoted. | exit 1 = 15/15 gaps confirmed (reproduction) |
| ev:ev-mv1cj3km-010da2d1 | Executable model (`.eccode/drafts/sec-spec-model.mjs`). Runs the spec's own DDL, SQL statements and rules in node:sqlite to trace H1 (cross-plan key replay), H2 (admin lockout) and H6 (stock hoarding). | exit 1 = all three reproduce (reproduction) |
| ev:ev-mv1cj3v5-01bb449f | `claude --help` on CLI 2.1.295: `--safe-mode` disables CLAUDE.md, hooks, MCP and plugins; `--tools ""` disables all tools; the other pinned flags exist. | passed |

Memory: searches for "webhook", "idempotency", "prompt injection" and "SameSite" returned one record, `mem-sd-mv1audrd-013b7102`. It is about the ECCode guard's nested root, and I assessed it does-not-apply (evidence ev:ev-mv1chwe5-0199c200). It is not used as evidence.

## Findings

### major

**SEC-1: An anonymous caller can lock any known account out of sign-in, admin included.**
- **Section:** Interface Contracts › Authentication › Throttle; Security T8.
- **Path:**
  1. Usernames are public: `admin`, `supplier-a` … `supplier-e`, `cafe1`, `cafe2` (Provisioning).
  2. The attacker fetches `GET /api/auth/csrf` (public).
  3. The attacker sends 5 `POST /api/auth/signin` with wrong passwords for `admin`, from one IP. That is under the 20-per-IP limit.
  4. `login_failures` now holds 5 rows for `admin`. The spec says: "a sign-in is refused with 429 when the username has ≥ 5 failures in the last 15 min … refused **before** the password is checked, so the correct password is also refused."
  5. The real admin, from any IP and with the correct ≥ 16-char password, gets 429.
  6. Five more requests every 15 minutes keep the lock indefinitely.
- **Impact:** the same works against `supplier-a..e`, which stops supplier confirmations. The plans then cannot pass `COMMITMENT_MISSING`, reservations expire and the void rule fires, so a live demo can be stalled at the cost of 40 requests per 15 min. The per-username hard lock adds little protection for admin anyway: a ≥ 16-char password under scrypt is not brute-forceable at 20 attempts per IP per 15 min.
- **Evidence:** ev:ev-mv1cj3km-010da2d1 printed `attacker (1 IP, 5 requests): 401,401,401,401,401 | real admin, other IP, correct password: {"status":429,"code":"RATE_LIMITED"} | after the next 5-guess cycle: 429`. Spec text quoted in ev:ev-mv1chwnv-0109783d (H2).
- **Resolution:** key the hard refusal on (username, IP) pairs, keeping a per-IP global limit. Per username across all IPs, apply a progressive delay or a much higher threshold that still checks the password (for example, a correct password succeeds after a delay instead of being refused). Change T8's test from "6th attempt with the correct password → 429" to "6th attempt from the same IP → 429; the correct password from another IP → 200". Count failures for unknown usernames too, so 429-versus-401 does not enumerate accounts.

**SEC-2: One customer can hold every supplier's stock, repeatedly, without paying.**
- **Section:** Background Processing › Reservation; Seed; Authentication › Provisioning (`RS_ALLOW_SIGNUP` default 1); Security › Rate limiting.
- **Path:**
  1. The attacker self-registers (5 accounts per IP per hour).
  2. They create 5 requests and confirm the fields manually, so no model call or budget is needed.
  3. They plan, approve and reserve each one with a fresh `Idempotency-Key`.
  4. Each seeded supplier has `on_hand = 1`. The conditional `UPDATE inventory SET reserved = reserved + ? … WHERE … reserved + ? <= on_hand` succeeds for the attacker. Every other customer's reserve then fails with `OUT_OF_STOCK`, their plan becomes `non_executable (OUT_OF_STOCK)` and a re-plan is queued.
  5. After the 30-minute TTL the stock returns and the attacker reserves again.
- **Limits that don't stop it:** nothing caps live reservations per customer. No payment step is needed to hold stock. The only limit is "300 requests/min per user".
- **Evidence:** ev:ev-mv1cj3km-010da2d1 printed `attacker reserves each supplier bundle: 201,201,201,201,201 | live reservations held: 5 | victim reserve: {"status":409,"code":"OUT_OF_STOCK"}`. Spec text in ev:ev-mv1chwnv-0109783d (H6).
- **Resolution:** add a per-customer cap on live (`active`) reservations, for example 1 by default (`RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER`), refused with 409 or 429 and a catalog code. Add a per-customer daily limit on request creation. Assert both in an API test. Optionally shorten the TTL until the first PayPal approval.

**SEC-3: A loopback PayPal stub runs under `npm start` and is labelled "PayPal Sandbox", not "Simulated" (RS-34).**
- **Section:** Security T18; Interface Contracts › Conventions › Labels; Frontend › Labels; PayPal wire mapping (approval host "or the loopback stub").
- **Path:**
  1. The operator, or anyone preparing screenshots, sets `RS_PAYMENT_PROVIDER=paypal-sandbox` and `RS_PAYPAL_BASE_URL=http://127.0.0.1:<port>`, pointing at `test/helpers/paypal-stub.js` or any local imitation. T18 accepts this base URL.
  2. The adapter id is `paypal-sandbox`, so every payment object carries `provider:"paypal-sandbox"`, `simulated:false`, `sandbox:true`.
  3. The UI shows "PayPal Sandbox — no real money". The "Simulated" banner is absent, because no fake adapter is active.
  4. The approval link points at the stub page on 127.0.0.1, which the approval-host check accepts.
- **Impact:** a simulated payment flow is presented as Sandbox evidence, which is exactly what RS-34 forbids. The labelling test also asserts the Sandbox labels against this stub (Testing Strategy › E2E).
- **Evidence:** ev:ev-mv1chwnv-0109783d (H5), quoting "PayPal base URL must be `https://api-m.sandbox.paypal.com` or `http://127.0.0.1:<port>` / `http://localhost:<port>`" and "With the Sandbox adapter, every payment element shows "PayPal Sandbox — no real money"". The spec has no rule that limits loopback to tests or labels it.
- **Resolution:**
  - Accept a loopback `RS_PAYPAL_BASE_URL` (and a loopback approval host) only when `RS_TEST_OFFLINE=1` or `RS_TEST_HOOKS=1`; `npm start` refuses it at startup.
  - Or keep it, but then set `simulated:true`, `sandbox:false`, show the "Simulated" banner, and use a distinct label such as "Sandbox adapter → local stub (Simulated)".
  - Add a config test and a labelling test for each case.

### minor

**SEC-4: An `Idempotency-Key` reused on a different plan replays the first plan's reservation instead of returning 422.**
- **Section:** Conventions › Idempotency; Reservation step 1.
- **Path:** the scope is "(user id, route template, key)" and the body hash is "sha256 of the canonical JSON of the parsed body (`{}` when empty)". The reserve body is always `{}`. So customer C calling `POST /api/plans/9/reserve` with the key already used for plan 7 matches the stored row. They get plan 7's 201 body with `Idempotent-Replayed: true`, plan 9 is never reserved, and no 422 is returned.
- **Why it matters:** the SPA keys per plan, so normal use is unaffected, but programmatic and retrying clients are misled. Once the key row is purged after 24 h, the UNIQUE `reservations.operation_key = res:<customerId>:<key>` collides, and the spec maps SQLITE_CONSTRAINT to an unspecified "typed error".
- **Evidence:** ev:ev-mv1cj3km-010da2d1 printed `reserve plan 9 with the same key: {"status":201,"replayed":true,"body":{"reservation":{"id":107,"planVersionId":7,…}}}`. Text in ev:ev-mv1chwnv-0109783d (H1).
- **Resolution:** put the concrete path (or the plan id) in the scope or the hashed material, so reuse on another plan gives 422 `IDEMPOTENCY_KEY_REUSED`. Specify the error for an operation-key collision after purge (422 `IDEMPOTENCY_KEY_REUSED`), and test both.

**SEC-5: The `.env.example` placeholder passes as a secret, and all demo accounts share one password.**
- **Section:** Deployment › Environment variables; Authentication › Provisioning; Webhooks (fake HMAC).
- **Path:**
  - `RS_DEMO_PASSWORD` needs ≥ 10 characters, and the literal `<placeholder>` has 13. An operator who runs `cp .env.example .env` and starts with `--env-file=.env` seeds every supplier and customer account with a password published in the repository. Anyone can then sign in as `supplier-a..e` or `cafe1/2`.
  - `RS_FAKE_WEBHOOK_SECRET` has no length or placeholder rule, and its behaviour when unset is unspecified. With `<placeholder>`, anyone can HMAC-sign a fake `PAYMENT.CAPTURE.REFUNDED` or `PAYMENT.AUTHORIZATION.VOIDED` and drive allowed transitions on fake operations. That is simulated money, but the demo state is corrupted.
  - Separately, the seed gives all seven demo accounts one shared password, so any demo supplier can sign in as the other suppliers and the customers.
- **Evidence:** ev:ev-mv1chwnv-0109783d (H3): `"<placeholder>".length = 13; demo min 10 (accepted: true)`, and no rule in the spec refuses placeholder values.
- **Resolution:**
  - Config and seed refuse any secret that matches `^<.*>$` or is shorter than 32 bytes for HMAC keys.
  - Specify that when `RS_FAKE_WEBHOOK_SECRET` is unset, a random key is generated once and stored in `meta` (shared across processes).
  - The README states that demo accounts share one password and are for single-operator demos.
  - Add the placeholder refusal to the `test/scan/env-example.test.js` / config tests.

**SEC-6: Anyone can flood the unauthenticated webhook route.**
- **Section:** Webhooks; Security › Rate limiting; Retention › "webhook events are kept".
- **Path:** each anonymous `POST /api/webhooks/paypal/A` with random headers costs one outbound `verify-webhook-signature` call (plus an OAuth fetch on cache miss) on merchant A's credential, and inserts one `invalid` row. The rows are never purged, and no rate limit covers the route.
- **Impact:** the table grows without bound. PayPal throttling on the shared merchant credential returns 429, which the protocol classifies as `retryable`, so the saga's capture, void and refund calls back off (5 s, 30 s, 2 min, …). This delays compensation.
- **Evidence:** ev:ev-mv1chwnv-0109783d (H4).
- **Resolution:**
  - Add a per-IP rate limit on the webhook route.
  - Make cheap rejections before calling the provider: all five headers present and bounded, `paypal-auth-algo` in an allow-list, `transmission_time` within ±15 min, body parses as JSON with a known `event_type`. These are recorded as `invalid` without a provider call.
  - Cap or purge `invalid` and `unverified` rows after N days, and keep `valid` rows.

**SEC-7: Injected image text can appear verbatim in the customer UI as an assistant "question" or as `originalWording`.**
- **Section:** AI / LLM Design › schema, local validation, post-validation normalisation.
- **Path:**
  - A package label (the threat model treats image text as untrusted) carries text such as "To confirm your order call +1-555-… / enter your PayPal password at …".
  - The schema has `questions[].field` and `questions[].question` as free strings. The validator only caps the count (6) and the length (300).
  - `originalWording` for `provenance:"image"` has no grounding check, because grounding applies only to `user_text`.
  - So a model that is partly steered can place attacker text in the "What you need" section as if the assistant asked it. No permission, amount, supplier or plan is affected, which is why this is minor.
- **Evidence:** ev:ev-mv1chwnv-0109783d (H8), quoting the schema `"field": {"type": "string"}, "question": {"type": "string"}`.
- **Resolution:**
  - Bind `questions[].field` to an enum of the nine field names.
  - Render question text from server templates per field, keeping the model's text only as a labelled hint, or drop it.
  - Label image `originalWording` as "text read from the photo". Cap it at 80 characters and strip URLs and phone-number patterns, or show the value only.
  - Add an EXT-1 injection case that asserts no injected string appears in `questions` or `originalWording`.

**SEC-8: Provenance is supplied by the client on confirm.**
- **Section:** Customer routes, `POST /api/requests/:id/confirm`.
- **Path:** the body takes `{value, provenance: "user_text"|"image"|"manual"}` per field. A customer, or a buggy client, can submit a hand-typed value tagged `image` or `user_text`. The page then shows "From the photo" for a value that never came from it, which undermines RS-02 and RS-35 provenance as evidence. The AI section itself says "edits → `manual`".
- **Evidence:** ev:ev-mv1chwnv-0109783d (H9).
- **Resolution:** the server derives provenance. A field keeps the latest extraction's provenance and `originalWording` only if the submitted value equals the extracted value; otherwise the provenance is `manual`. The request body carries values only. Add a test.

**SEC-9: The throttle's username key normalisation is unspecified, while user lookup is case-insensitive.**
- **Section:** 001_core.sql (`users.username … COLLATE NOCASE`, `login_failures.username_key`); Throttle.
- **Path:** if `username_key` stores the raw input, then `admin`, `Admin`, `ADMIN` and so on each get their own 5-failure budget while all resolve to the admin row. This multiplies the attempts allowed per username. The opposite problem, a lockout per variant, also arises.
- **Evidence:** ev:ev-mv1chwnv-0109783d (H10).
- **Resolution:** `username_key = lower(NFC(trim(username)))`, the same normalisation the lookup uses. Test it with case variants.

**SEC-10: One customer, or a few self-registered ones, can exhaust the shared daily model budget for everyone.**
- **Section:** AI / LLM Design › Runtime controls; Security › Rate limiting.
- **Path:**
  - The budget is global ("today's spend = Σ … for the Asia/Amman day", default USD 1.00) and each call reserves the cap (0.05).
  - One account may extract 10 times per 10 min, which is 60 per hour. That reaches USD 1.00 within hours at the stated $0.004–0.02 per call.
  - Five self-registered accounts (5 per IP per hour) reach it within minutes. In-flight reservations of 0.05 each block other callers sooner still.
  - With CLI concurrency 2 per process and a 5 s wait, one customer's calls also push others into `PROVIDER_BUSY`.
  - Cost stays bounded, so the control works as designed. The finding is about fairness and availability, and the degraded manual path is labelled.
- **Evidence:** ev:ev-mv1chwnv-0109783d (H13).
- **Resolution:** add a per-customer daily share (for example ≤ 20 % of the budget) and a per-customer concurrency of 1. Optionally, recommend `RS_ALLOW_SIGNUP=0` for any public deployment in the README.

**SEC-11: A forced reset strands authorized holds and unresolved captures.**
- **Section:** Admin routes › Reset.
- **Path:** an admin runs `POST /api/admin/reset {force:true, reason}` while operations are `authorized`, `capture_pending` or `unknown`. The rows get `archived_at`, and "Archived operations are ignored by the reconciler". So Sandbox authorizations are never voided (they stay held until expiry), and an `unknown` capture that actually succeeded is never refunded. The brief permits a forced reset, so this is minor: it is Sandbox and admin-only.
- **Evidence:** ev:ev-mv1chwnv-0109783d (H14).
- **Resolution:**
  - Before archiving, a forced reset queues voids for `authorized` operations and does one read-resolve pass for `unknown` and `*_pending` ones.
  - Or the reset response and audit event list every stranded operation (id, status, provider ids) so they can be cleaned up by hand.
  - The audit event for each `refund_order` and `faults` call should also name the actor and target ids; the spec states this for reset only.

**SEC-12: The fake approval listener has no contract.**
- **Section:** Components (`payments/fake.js`); Runtime units; Deployment (`RS_FAKE_APPROVAL_HOST/PORT`).
- **Path:** the spec gives no routes, methods, authentication, order-id entropy, redirect rule or label for the second listener. An implementer could:
  - use sequential fake order ids, so anyone on the host could approve or cancel another customer's fake order;
  - redirect to a URL taken from the query string (an open redirect);
  - or render a page that imitates PayPal without saying "Simulated" (RS-34).
- **Evidence:** ev:ev-mv1chwnv-0109783d (H15).
- **Resolution:** specify:
  - `GET /approve/:fakeOrderId` renders a page labelled "Simulated payment approval — not PayPal";
  - `POST` approve and cancel actions;
  - fake order ids of 128-bit random hex;
  - redirects only to the `return_url` / `cancel_url` stored in `fake_paypal_orders`;
  - bound to `RS_FAKE_APPROVAL_HOST` (loopback by default) and refused when `RS_PAYMENT_PROVIDER=paypal-sandbox`.

### info

- **SEC-13 (Conventions › CSRF, Origin check):** the Origin check accepts "`http(s)://<Host>`" and nothing validates the Host header. A DNS-rebinding page can therefore reach the 127.0.0.1 listener same-origin, but only with its own cookies (anonymous surface: register, sign-in, the SEC-1 lockout, `GET /api/config`). Suggest a Host allow-list derived from `RS_PUBLIC_URL` plus `localhost` and `127.0.0.1`. (ev:ev-mv1chwnv-0109783d H11)
- **SEC-14 (Data Design; Deployment):** no file-mode rule for `data/app.db` (scrypt hashes, session hashes, PII text) or `data/uploads/`. Suggest `0700` directories and `0600` files at creation. `.gitignore` should cover `.env` as well as `data/`. (H12)
- **SEC-15 (Security T25 vs AI › CLI adapter):** the stdout cap is stated as 1 MiB in one place and 8 MiB in the other. Pick one, so the resource bound is testable. (H7)
- **SEC-16 (Webhooks step 3):** "Map `event_type` to an operation by resource id" should also require `operation.merchant_key = :merchantKey`, `provider` = the active adapter and `archived_at IS NULL`. This keeps a valid event on one merchant's URL from moving another merchant's or an archived operation.
- **SEC-17 (AI › rephrase; Security T10):**
  - The rephrase guard rejects new numbers and supplier codes but cannot detect swapped comparisons or negations ("A+E beats A+B"). This is acceptable, since it is opt-in, labelled and meets the brief.
  - Specify that the rephrase input carries only codes and numbers, never supplier or product names or `refusal_reason` (supplier free text). Otherwise T10's "catalog text never reaches the model" does not hold when rephrasing is on.
  - T10's test says "supplier sets a product name", but no route lets a supplier edit names. Say how the test plants the string (seed or a direct DB fixture).
- **SEC-18 (Saga › Why no double capture):** a sender frozen between call start and network send resumes and sends without re-checking the lease (this cannot be made atomic). Layers 4–5 (`PayPal-Request-Id` replay and `final_capture` refusing a second capture) are still marked **verify** (OQ-D5). Until the live Sandbox run confirms them, RS-20/RS-26 on Sandbox rest on the fake's model of PayPal. Keep this explicit in the evidence table.
- **SEC-19 (AI › Anthropic adapter):** `RS_ANTHROPIC_BASE_URL` is unrestricted while `x-api-key` is sent to it. Extend T18's allow-list idea (`https://api.anthropic.com` or loopback under test flags).
- **SEC-20 (Authentication):** say that `POST /api/auth/register` also destroys any incoming session (rotation, as sign-in does). Say that no route emits `Access-Control-Allow-*` headers, and assert both in `auth.test.js`. CSRF safety of the pre-login token depends on the absence of CORS.

## Checked and found sound (no finding)
- **Amount tampering (T5):** payment bodies are ignored, the amount comes from `supplier_orders.total_cents`, and the stub test asserts the outbound body.
- **IDOR (T1, T2):** owner scope is in SQL. Return/cancel look up by `provider_order_id` joined to the session customer, and answer 404 before any provider call.
- **SameSite=Lax:** a cross-site top-level GET to `/api/paypal/return?token=T` needs the victim's own PayPal order id, which is not leaked (`Referrer-Policy: no-referrer`). It only advances an order that PayPal reports `APPROVED`, and is idempotent (CAS plus UNIQUE `so:<id>:authorize:1`). All non-GET routes need the header token, which a cross-site form cannot set.
- **Webhooks:** dedupe counts only `valid` transmission ids, so a forged event cannot pre-empt a genuine one. Transitions are CAS through `states.js`. `CHECKOUT.ORDER.APPROVED` never authorizes. `cert_url` is never fetched by us.
- **Money paths:** Sandbox-only base URL and approval-host allow-lists; `RS_TEST_HOOKS` is refused with the Sandbox adapter; `FAULTS_UNAVAILABLE` for fake faults on real adapters.
- **Uploads and output:** magic bytes plus declared type; size cap while streaming; 128-bit random names in a fixed directory; owner check before reading the body; served with `nosniff` and `CSP: sandbox`; no `innerHTML`; strict CSP; no SVG.
- **AI isolation:**
  - The CLI env allow-list excludes `RS_*` secrets and `ANTHROPIC_API_KEY`.
  - `--safe-mode` disables CLAUDE.md, hooks and MCP, and `--tools ""` disables all tools (ev:ev-mv1cj3v5-01bb449f).
  - The model sees only the system prompt, the delimited request text and the image, with no secrets in its context.
  - Model output never reaches permissions, amounts, supplier choice, plan version or role: the planner, money and payments read only confirmed requirement columns.
  - Budget is reserved before the call and there is a per-call cap.

## Guard refusals during this review
- An inline `python3` edit of my own draft script was refused ("calls a file-writing API"). I rewrote the file with the Write tool instead.
- A `grep` whose pattern contained a backquoted `` `POST `` was refused as "runs a command through a variable or substitution". I read the file with the Read tool instead.

Neither refusal blocked any check.
