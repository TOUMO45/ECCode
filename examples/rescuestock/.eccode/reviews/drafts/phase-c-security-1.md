# Security review: phase C submission (phase:c-core-flow), version 1

Reviewer: security-reviewer. Run: run-mv2y8zz9-014fd931. Gate: `phase:c-core-flow`, submission `sub-mv2y7tlh-017e22c9` (recording reviewer: technical-reviewer; this draft is input to that review, I record no gate decision).
Inputs: the submission's 139 artifacts, `.eccode/artifacts/phase-c/submission.md` (FU-13..FU-19, deviations), my design draft `design-security-1.md` (SEC-1..20) and phase B draft `phase-b-security-1.md` (SEC-B-1..9).
Every check below was recorded with `--actor security-reviewer --gate phase:c-core-flow` on the submitted tree (tree `7eba8a75…`). No project file was changed. My probe scripts live in `.eccode/drafts/` only, run the app in-process on temp databases, and record no latency samples.

## Verdict

**I would not block phase C.** Every property phase C owns held when I attacked it:
- **Authentication:**
  - cookie flags, plus `Secure` when the public URL is https;
  - session ids stored as sha256 only;
  - idle and absolute expiry enforced;
  - rotation on sign-in AND on register (SEC-20), and planted ids are never adopted;
  - sign-out kills the id for GET and POST;
  - the throttle behaves exactly as SEC-1 asked: the pair limit is hard, cross-IP pressure only delays, the admin can still sign in from another IP, and unknown and known users get the same status and the same timing.
- **CSRF:** seven refusal shapes; the Origin check runs before identification; the pre-login token is HMAC-bound and expires after 2 h.
- **Authorization:**
  - a 76-cell matrix: 19 non-public routes × anonymous/customer/supplier/admin;
  - the `signature` policy is confined to the webhook route;
  - customer isolation (RS-27) with no side effect in 10 tables;
  - supplier isolation (RS-28).
- **Money and state:**
  - RS-12 tamper refusals; client totals are ignored;
  - RS-16 idempotency scoped per user and per plan, before and after the key purge;
  - the SEC-2 count cap holds under a parallel race;
  - `reserved <= on_hand` and ledger sums hold throughout;
  - supersession, refusal, requirements change and expiry never leave stock reserved, or an order open, on a dead plan;
  - the RS-37 reset guard holds, and a forced reset archives.
- **Frontend:** a real Chromium rendered hostile supplier and customer strings as literal text, with no script run and no CSP violation.

There are **no blocking or major findings**:
- **Three minors.**
  - SEC-C-1: one reservation can hold every compatible bundle, and no expiry pass runs yet. Recorded as RISK-20 (owner backend-engineer).
  - SEC-C-2: IPv6 addresses are keyed individually.
  - SEC-C-3: the absent general limit (FU-15) lets one customer write about 300 requirement versions a minute.
- **Four info items.**

None needs a phase C rework if the technical reviewer carries the resolution conditions into FU-14/FU-15, e4 and d4/e5 as stated below.

## Evidence

| ev id | what | result |
|---|---|---|
| ev:ev-mv2yb2r4-016452c4 | `npm test`, the phase C suite, run by me on the submitted tree | passed: 804 tests, 788 pass, 0 fail, 10 skipped, 6 todo (matches the submission); NFR5 p95 128.8 ms |
| ev:ev-mv2z05jg-016641ca | `.eccode/drafts/sec-phc-probe.mjs`, sections S1–S13 (S13 launches Chromium) | passed, every expectation met, 148.6 s. It includes the REPRO lines for SEC-C-2, SEC-C-3 and SEC-C-4 |
| ev:ev-mv2z1ypi-01dceb2e | `.eccode/drafts/sec-phc-hoard.mjs`: the SEC-C-1 reproduction | passed (= reproduced) |

What the probe covers, per section of ev:ev-mv2z05jg-016641ca:
- **S1, sessions:**
  - cookie flags;
  - `Secure` under an https `RS_PUBLIC_URL`;
  - sha256-only storage;
  - fixation by a planted 43-char id;
  - rotation on sign-in and register;
  - sign-out for GET and POST;
  - idle expiry: a 59 min gap is ok, 60 min is dead;
  - absolute expiry: alive at 715 min and dead at 770 min while active every 55 min;
  - a disabled user;
  - SEC-13: a foreign Host gets 421.
- **S2, CSRF:**
  - no token, a wrong token, another user's token, a pre-login token on a session route, `Origin: https://evil.example`, `Origin: null`, and a suffix-trick Origin: all 403 and no row written;
  - an anonymous request with a foreign Origin gets 403 before the 401;
  - sign-in without a token, with a foreign Origin, with a tampered nonce, or with a token older than 2 h: 403;
  - a `text/plain` body gets 415;
  - no `Access-Control-*` header on a preflight.
- **S3, throttle:**
  - 5 wrong attempts from one IP: the 6th from the same IP with the correct password gets 429 `signin_pair` (Retry-After 900);
  - the admin from another IP gets 200;
  - 20 failures from 4 IPs: the admin from a 5th IP gets 200 after 10.05 s (delay only);
  - five case and space variants share one budget (SEC-9);
  - an unknown user gets 401×5 then 429, the same as a known user;
  - per-IP: the 21st attempt across 21 usernames gets 429 `signin_ip`;
  - X-Forwarded-For: the last hop is the key, a non-IP hop falls back to the socket address, `::ffff:` collapses to IPv4, and with trust off a rotating XFF changes nothing;
  - timing medians: unknown user 50.3 ms, known user with a wrong password 50.0 ms.
- **S4, register:**
  - CRLF and other control shapes in the username and display name, a U+2028/U+0085 display name and a short password: all 422, with no budget consumed;
  - `role`/`supplierId` in the body are ignored;
  - `ADMIN` gets 409;
  - the 5-per-IP-per-hour cap holds;
  - without `RS_ADMIN_PASSWORD` the admin row is disabled and sign-in gets 401.
- **S5, routes:**
  - the full router list × 4 callers;
  - an unregistered method gets 405;
  - a `signature` route at any other path, or GET on the webhook path, gets 403 and the handler never runs.
- **S6, customer isolation:**
  - foreign ids on GET, confirm, plan, approve and reserve: 404;
  - row counts unchanged in requirements, planning_runs, plan_versions, plan_approvals, reservations, idempotency_keys, rate_events, supplier_orders, audit_events and replan_queue;
  - a foreign id and a nonexistent id get an identical answer;
  - sequential requests 1..40 and plans 1..20 all get 404.
- **S7, supplier isolation:**
  - another supplier's order on confirm, refuse, ready or handover: 404, nothing changed;
  - lists are scoped, and SQL text in `?status=` gets 400;
  - a PATCH mixing own and foreign products gets 403 and nothing changes;
  - lowering on-hand below reserved gets 409 `RESERVED_STOCK`.
- **S8, money and state:**
  - the RS-12 tamper refusals, with a string total getting 422;
  - the stored approval total equals the server total, and order totals equal it at reserve;
  - RS-16 and F-TR-1, before and after the key purge;
  - a per-user key scope;
  - the SEC-2 parallel race leaves one active reservation;
  - supersession: see "Checked and held";
  - the requirements change cancels a confirmed order and releases the reservation;
  - expiry happens exactly once, with `expire` ledger rows and cancelled orders;
  - FU-8: the 10th planning call gets 429;
  - RS-37: the reset is blocked, a forced reset without a reason gets 422, a forced reset archives and lists the stranded operations.
- **S9:** flooding measurements (SEC-C-3).
- **S10, input and output:**
  - text length, NUL and type checks;
  - SEC-B-3: a 40-deep body gets 422;
  - id shapes all get 400;
  - SEC-8: provenance is server-derived;
  - timeline query injection gets 422, and an unknown fault kind gets 422;
  - a refusal reason containing a newline, a forged JSON log line, U+2028 and markup is accepted but appears in neither the log lines nor `audit_events`;
  - a C0 control gets 422;
  - log lines stay one JSON object each;
  - a username with a newline is not logged;
  - no stack, path or SQL in error bodies.
- **S11, dom.js and public/\*\*:**
  - the href, attribute and URL guards (SEC-C-4);
  - RS-29 scan: 34 files, no secret or client-id shapes;
  - no `innerHTML`, `eval`, `localStorage` or `.href=` sinks.
- **S12:** the exact CSP with no `unsafe-*`; `/api` responses are `no-store`.
- **S13, Chromium:**
  - setup: a buyer registered with display name `<img src=x onerror="window.__xss=1">`; a supplier refused with `<img … __xss=2><a href="javascript:…">`;
  - the customer request page and the supplier orders page both show the strings literally;
  - `window.__xss` stayed null; there were zero `<img>`, zero `javascript:` links, no dialogs and no CSP reports.

**Memory:** searches for "csrf", "session", "idor" and "throttle" returned no records. Nothing was retrieved, so nothing was assessed.

## Findings

### blocking

None.

### major

None.

### minor

**SEC-C-1: One reservation can hold every compatible bundle (the SEC-2 cap counts reservations, not stock), and no expiry pass runs in a live server until e4.**
- **Where:**
  - `src/services/reservations.js` lines 127–131: the cap is `active.length >= config.maxLiveReservationsPerCustomer`, a row count.
  - `src/main.js` lines 54–76 and all of `src/`: nothing calls `expireDueReservations` (`src/services/reservations.js` line 271), which the code says "the reconciler calls every tick". The reconciler is task e4.
- **Path:**
  1. The attacker self-registers (5 accounts per IP per hour).
  2. One request asks for 500 cups and 500 lids, maxPickups 5, a large budget and a 12:00 deadline.
  3. The planner returns A+B+D+E, every bundle compatible with 250 ml / 90 mm. C's lids are 95 mm.
  4. Approve, then reserve: 201, with one reservation, inside the cap of 1.
  5. The canonical RS-FIX-1 customer (cafe1) now gets no feasible plan.
  6. After the TTL plus 5 minutes the hold is still `active` and cafe1 still has no plan, because nothing expires it. Only an admin reset or a supersession frees the stock.
- **Impact:** availability of the core flow for every customer with a compatible need, by one free account, with no payment. This is the SEC-2 attack in one reservation instead of five. Once e4 runs expiry, it is bounded to 30-minute holds that can be repeated. The design accepted holds of that length, which is why this is minor and not major.
- **Evidence:** ev:ev-mv2z1ypi-01dceb2e printed:
  - `qty 500: A,B,D,E total 21900`
  - `ONE reservation (within the cap of 1) holds A, B, D and E | 200 201 held A,B,D,E`
  - `canonical RS-FIX-1 customer (cafe1) now gets no feasible plan`
  - `reservation active (expires_at 2026-10-20T06:30:00.000Z), cafe1 plan none`

  The count cap itself holds, including under a parallel race (ev:ev-mv2z05jg-016641ca S8).
- **Resolution:** recorded as **RISK-20** (medium, owner backend-engineer).
  - **Required, in e4:** the running server executes the expiry pass on every reconciler tick. A test must show that a reservation past its TTL expires in a running server process, not only through a direct call.
  - **Recommended, a product decision for the technical reviewer and the user:**
    - a cap inside the reserve transaction on the bundles one reservation may take per supplier, or on its share of a supplier's on-hand;
    - or a short TTL (for example 10 min) until the first PayPal approval.
  - Record the decision either way.

**SEC-C-2: The throttle keys IPv6 per full address, so one /64 gives unlimited fresh pair and per-IP budgets.**
- **Where:**
  - `src/auth/client-ip.js` lines 14–26 (`normalizeIp` returns the full lower-cased IPv6 address);
  - consumed by `src/auth/throttle.js` lines 42–63.
- **Path:** a client reaches the app over IPv6, either directly or through a proxy with `RS_TRUST_PROXY=1` that appends the client's IPv6 address. Every address in its /64 is then a new key:
  - 5 guesses per (username, address);
  - 20 per address across usernames.

  The cross-IP stage only delays, by design (SEC-1). Each delayed request sleeps on its own and is not serialised, so concurrency removes most of the slowdown. That last point follows from the code (`await auth.sleep(...)` per request, `src/routes/auth.js` line 71); I have not measured it.
- **Impact:**
  - Online guessing against self-registered customers is bounded only by scrypt CPU (about 50 ms per attempt). The minimum customer password is 10 characters, and its content is not checked.
  - Seeded accounts (96-bit passwords) and the admin (≥ 16 characters) are not at practical risk.
  - The same lever lets an attacker hold many 10-second delayed sign-ins open against `MAX_CONNECTIONS = 512` (`src/http/server.js` line 17). That is not demonstrated.
- **Evidence:** ev:ev-mv2z05jg-016641ca S3 printed `8 failures from 8 addresses of one IPv6 /64 never hit the pair or IP limit | 401,401,401,401,401,401,401,401 then correct -> 200`. The submission lists this as a deviation and offers the /64 change "if the security reviewer asks". **I ask for it.**
- **Resolution:**
  - `normalizeIp`, or a separate `throttleKey`, maps IPv6 to its /64 prefix for the sign-in and register throttles. IPv4 and `::ffff:` addresses stay as they are.
  - A test shows that 5 failures spread over 5 addresses of one /64 make the 6th attempt get 429.
  - The change is about 5 lines in `src/auth/**` and can ride on the FU-15 rework, which already opens `src/auth/rbac.js`.

**SEC-C-3: Without the general limit (FU-15), one customer can write about 300 requirement versions and 300 audit rows a minute, and reads are unthrottled.**
- **Where:**
  - `src/auth/rbac.js`: no general limit in `authorize`;
  - `src/services/requests.js` lines 193–243: every confirm inserts a new requirements version (lines 217–223), even when the values match the previous one; `sameRequirements` only gates supersession.
- **Path:** a signed-in customer (self-registration is on by default) loops `POST /api/requests/:id/confirm` on their own request.
- **Impact:** unbounded database growth and write load from one free account. At the spec's own 300 per minute, that is still about 432,000 requirement rows per customer per day. Reads such as `GET /api/requests/:id` are cheap but unthrottled, and any customer can keep the single event loop busy.
- **Evidence:** ev:ev-mv2z05jg-016641ca S9 printed:
  - `300 confirms in one frozen minute -> 300 requirements versions + 300 audit rows, none limited | +300 requirements (248700 bytes of fields_json) … 562 ms`
  - `600 RequestView reads … none limited | 489 req/s sequential`

  The anonymous surface is bounded:
  - sign-in returns a cheap 429 after 20 attempts per IP, without running scrypt;
  - `GET /api/auth/csrf` is stateless (1,627 req/s, no write).
- **Resolution:**
  1. FU-15 lands before phase E, as the submission proposes, with a test that the 301st request in a minute gets 429 `limit: general` and that planning keys (`plan:u:`) are not counted.
  2. A confirm whose values equal the latest version returns that version without inserting a new one. This is about 3 lines in `confirmRequirements` and costs no limit budget.
  3. Merge with FU-14 if the orchestrator prefers one rework.

### info

- **SEC-C-4: `dom.js` lets same-origin-looking URLs resolve off-origin.**
  - **Where:** `isAllowedUrl`, `public/js/dom.js` lines 23–27. It accepts any value that starts with `/` but not `//`.
  - **What gets through:** browsers' URL parsing treats `/\evil.example/x`, and `/` followed by TAB or LF then `/evil.example/x`, as protocol-relative, so the link goes to `http://evil.example/x`.
  - **Exposure today:** none. Every `href` in `public/**` is a constant or a numeric hash (`#/requests/<id>`), and the scan found no `.href=` sinks. This becomes reachable once a server-supplied URL is rendered, for example by e5's PayPal approval link.
  - **Evidence:** ev:ev-mv2z05jg-016641ca S11: `"/\\evil.example/x" -> allowed -> evil.example | "/\t/evil.example/x" -> allowed -> evil.example`.
  - **Suggestion:** refuse any URL containing `\` or a C0 control character or whitespace, or resolve with `new URL(v, location.href)` and require the same origin unless an absolute http(s) URL is intended. Add a unit test. Owner: the next frontend task that touches `dom.js` (d4 or e5).
- **SEC-C-5: proxy trust is all-or-nothing and is set by the operator.**
  - **Both failure modes:**
    - With `RS_TRUST_PROXY=0` behind a reverse proxy, every client shares the proxy's address. Twenty failed sign-ins from anyone then lock out every user for 15 minutes (`signin_ip`).
    - With `RS_TRUST_PROXY=1` and no proxy, the client chooses its own throttle key through `X-Forwarded-For`.
  - **Evidence for the behaviour:** ev:ev-mv2z05jg-016641ca S3 shows XFF ignored when trust is off, and the last hop used when it is on.
  - **Current state:** README line 84 tells proxied deployments to set the flag.
  - **Suggestion:** log one startup warning when `RS_PUBLIC_URL` is https and `RS_TRUST_PROXY=0`. Owner: g2 (docs) or e1 (config).
- **SEC-C-6: e3 inherits an unauthenticated route.**
  - **Hand-off for e3:** the `signature` policy works as the routing contract says. `POST /api/webhooks/paypal/:merchantKey` reaches its handler with no session and no CSRF (ev:ev-mv2z05jg-016641ca S5).
  - **What e3 must deliver:**
    - signature verification before any write;
    - the spec's 60 requests per IP per minute limit on that route (design SEC-6);
    - the cheap pre-checks before any provider call.
  - **Who carries it:** the phase E reviewer re-checks this.
- **SEC-C-7: carry-overs re-checked in code.**
  - **Remediated since phase B:**
    - SEC-B-2: `PRAGMA recursive_triggers = ON` is set (`src/db/connection.js` line 72);
    - SEC-B-4: `connectionsCheckingInterval`, `maxConnections = 512` (`src/http/server.js`).

    I read these; I did not re-run the slow-connection probes.
  - **Unchanged:** SEC-B-7, scrypt N = 2^14 (`src/auth/password.js`). Acceptable for this demo, as noted in phase B.

## Checked and held

Probe sections refer to ev:ev-mv2z05jg-016641ca unless noted.

- **SEC-1** (throttle keyed on (username, IP), cross-IP pressure delays only):
  - the 6th attempt from the same IP with the correct password gets 429 `signin_pair` (by design);
  - an attacker cannot lock the admin out from another IP: 200 after 5 failures, and 200 after a 10.05 s delay at 20 failures from 4 IPs;
  - the delay does not leak existence, because unknown usernames are reserved and counted identically: same 401×5 then 429;
  - timing: unknown user 50.3 ms, known user with a wrong password 50.0 ms (S3).
- **SEC-9:** `lower(NFC(trim))` keying; case and space variants share one budget; the lookup is case-insensitive (S3).
- **FU-11 / SEC-B-9:**
  - XFF is ignored unless `RS_TRUST_PROXY=1`;
  - with trust on, the last hop is used, validated by `net.isIP`, and anything else falls back to the socket address;
  - IPv4-mapped addresses collapse to IPv4 (S3).
- **SEC-20:** register destroys the incoming session; no `Access-Control-*` header on any answer, including a preflight (S1, S2).
- **SEC-13:** a foreign Host gets 421 (S1).
- **Sessions:**
  - 256-bit random ids, sha256 at rest;
  - `HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`, plus `Secure` under https;
  - idle 60 min and absolute 12 h, both enforced;
  - fixation-proof: a planted id is never adopted;
  - sign-out kills the id for GET and POST;
  - a disabled user's sessions are gone (S1).
- **CSRF:**
  - the session token is bound per session and compared with `timingSafeEqual`;
  - the pre-login token is HMAC-bound and lasts 2 h;
  - the Origin check runs before identification;
  - `null` and suffix-trick Origins are refused;
  - `text/plain` gets 415 (S2).
- **api.js:**
  - it adds `X-CSRF-Token` to every non-GET request;
  - its single retry on `CSRF_FAILED` is safe, because the server refuses a bad token in the access hook (or in `guardPreLogin`) before any effect;
  - the token lives in memory only.

  (Code reading of `public/js/api.js` lines 117–134, plus the S2 server behaviour.)
- **Registration and admin bootstrap:**
  - the role is fixed to customer; validation runs before the throttle;
  - the 5-per-IP-per-hour cap holds;
  - CRLF and other control characters are refused in the username and display name;
  - `admin` stays reserved (disabled when `RS_ADMIN_PASSWORD` is unset), and `ADMIN` gets 409 (S4).
- **Default deny:**
  - all 19 non-public routes × anonymous/customer/supplier/admin: anonymous 401, wrong role 403 `FORBIDDEN`;
  - the admin `faults` and `reset` routes are unreachable for non-admins (RS-30);
  - the `signature` policy works only on `POST /api/webhooks/paypal/:merchantKey`; any other route declaring it gets 403 and its handler never runs (S5).
- **RS-27:**
  - foreign request and plan ids get 404 on every customer route, with no side effect across 10 tables;
  - a foreign id and a nonexistent id get identical answers;
  - sequential probing reveals nothing;
  - lists are scoped (S6).
- **RS-28:**
  - another supplier's order gets 404 on confirm, refuse, ready and handover;
  - order lists are scoped;
  - a mixed PATCH gets 403 and nothing changes (S7).
- **RS-12:** a tampered hash or total gets 409 `PLAN_CHANGED`; the stored approval and order totals come from the server (S8).
- **RS-16 / F-TR-1 / SEC-4:**
  - the same key replays the same reservation;
  - the same key on another plan gets 422, both before and after the key purge;
  - keys are scoped per user (S8).
- **SEC-2** (count cap), inside the `BEGIN IMMEDIATE`: a parallel race leaves exactly one active reservation. The two-process version is covered by c6's RS-14 tests in ev:ev-mv2yb2r4-016452c4.
- **Stock, ledger and expiry:**
  - `reserved <= on_hand` holds everywhere, and lowering on-hand below reserved gets 409;
  - the ledger's `delta_reserved` sums equal `inventory.reserved`;
  - expiry runs exactly once, when called (S7, S8).
- **Supersession and the void rule:**
  - a price change supersedes the plan of an unconfirmed order: orders cancelled, reservation released;
  - a confirmed order keeps its plan and its approved total, per spec "Supersession › Selection";
  - a requirements change cancels even a confirmed order and releases the reservation;
  - no active reservation, and no awaiting or confirmed order, is ever left on a superseded or non-executable plan (S8).
- **RS-37:** the reset is refused while an operation is live; a forced reset needs a reason, archives without DELETE and lists the stranded operations (S8).
- **FU-8:** the planning limit gives 429 `limit: plan` with Retry-After (S8).
- **Input handling:**
  - unknown fields are dropped and types and ranges enforced;
  - request text is 1–4000 characters with no NUL;
  - the depth limit is 32 (SEC-B-3);
  - ids must match `^[1-9]\d{0,14}$`;
  - timeline cursor and limit are validated;
  - SQL is parameterised: every `${}` inside `prepare` is a constant column list or a `?` placeholder list (Grep over `src/`);
  - the error envelope carries no stack, path or SQL (S10).
- **SEC-8:** provenance is derived on the server; a client `provenance` is ignored (S10).
- **SEC-7, untrusted supplier text:**
  - the refusal reason (newline, a forged JSON line, U+2028, markup) never reaches logs or `audit_events`;
  - `sanitizeDetail` drops free text, and C0 controls get 422;
  - a sign-in username with a newline is not logged (S10).
- **XSS:**
  - `dom.js` refuses `on*`, `style`, `srcdoc`, namespaced attributes, `javascript:`/`data:`/`vbscript:`/`mailto:` and protocol-relative URLs;
  - there are no HTML sinks in `public/**`;
  - in Chromium, hostile supplier and customer strings render as text, no script runs, and the CSP reports no violation (S11, S13).
- **RS-29:** no secret or client-id shapes in the 34 files of `public/**` (S11).
- **RS-34 labels** (code reading of `src/config.js` `buildLabels`, `public/js/components/banner.js`):
  - the banner is driven by server labels (`simulatedPayments`, `simulatedExtraction`, `testMode`, `merchantMode`);
  - when the config cannot be loaded it warns rather than staying silent.
- **sessionStorage reserve keys:**
  - stored under `reserve:<planVersionId>`;
  - not secret; the server scopes keys per user (S8);
  - a key left in one tab after sign-out cannot replay or affect another user's reservation.

## Not checked

- Two-process races and DB_BUSY: I relied on c6's RS-14 tests passing inside ev:ev-mv2yb2r4-016452c4 and did not re-run them separately.
- Whether concurrent delayed sign-ins (SEC-C-2) can exhaust `MAX_CONNECTIONS`: reasoned from the code, not measured.
- The slow-connection remediation (SEC-B-4): code read, not re-probed.
- The admin fault kinds' effects on the fake adapters (`fake_paypal`, `fake_model`): only access control and validation were checked; the adapters are phase E/D.
- SEC-12, the fake approval listener, and the PayPal return/cancel routes: not built in phase C (e1/e2).
- `api.js` retry and `poll.js` behaviour inside a browser: code reading only. The browser journey ran in the suite.
- Timing beyond medians of 12 samples per arm.

## Guard refusals during this review

- **`sleep` before reading output:** a `sleep 45; cat <output>` was refused ("use Monitor with an until-loop"). I read the background task's output file once it had finished.
- **Backquote in a pattern:** a Bash `grep` whose pattern contained a backquote was refused ("runs a command through a variable or substitution"). I used the Grep tool instead.
- **No refusal, just a constraint:** this session has no Edit tool, and the brief bars inline file-writing programs, so I never tried in-place edits. I rewrote my probe file and this draft in full with Write.
