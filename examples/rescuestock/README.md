# RescueStock

**The problem.** A cafe is mid-service and runs out of cups or lids, or a supplier cancels the order it was counting on. It needs matching cups and lids, within a budget, before a deadline, from pickup points it can reach. Ringing around suppliers is slow, and a cup of the wrong diameter is useless with the lid you have.

**What RescueStock does.** The cafe describes the problem in English or Arabic, optionally with a photo of a package label. RescueStock turns that into structured requirements the cafe checks and confirms, computes the cheapest feasible bundle purchase across the participating suppliers, and says in plain words why it chose them and why it rejected the others. The cafe then approves the plan, the stock is reserved, and each supplier confirms. Payment is authorized at every supplier first, and money is captured only once every condition holds. If part of it fails, authorizations are voided or refunded and the cafe is told what happens next. If a supplier drops out, the cafe reviews and approves a replacement plan.

**Try it in one command** (fake payments, simulated model, nothing leaves your machine, Node 22.13 or newer):

```sh
npm install && npm run seed && RS_MODEL_PROVIDER=fake npm start
```

Then open http://localhost:3000 (use `localhost`, not `127.0.0.1`: without `RS_PUBLIC_URL` the simulated approval returns you to `http://localhost:<port>`, and the sign-in belongs to the host name you signed in on), sign in as `cafe1` with the password the seed printed to your terminal (it prints each account's password once), and enter:

> I need 200 cups and 200 lids, 250 ml, by 11:00 today. Budget $120, at most 2 pickups.

The sample text gives no cup diameter, so the form that opens asks for it: enter `90` in "Cup diameter (mm)", leave the other fields as they are, and confirm. With the seeded test prices the plan is suppliers A and B for USD 84.00; supplier C is rejected as incompatible (95 mm lids on 90 mm cups) and D as too late. Approve the plan, reserve the stock, and approve each payment on the clearly labelled "Simulated payment approval — not PayPal" page. To finish, each supplier must confirm its order: sign out, sign in as `supplier-a` and as `supplier-b` (their passwords are in the same seed output) and confirm the order each one sees (open "Confirm this order"). Back as `cafe1`, press "Complete purchase".

> **What is real and what is not.** All of the above runs on a built-in fake PayPal and a deterministic fake reader. The PayPal Sandbox adapter and the real-model adapters are built and tested against local stubs only. **They have never talked to PayPal or to a real model in this build.** The runs that would prove it are in the runbooks and need your credentials. See [Verified and not verified](#verified-and-not-verified).

## Contents

- [What is simulated](#what-is-simulated)
- [Verified and not verified](#verified-and-not-verified)
- [Requirements](#requirements)
- [Install, seed, start, test](#install-seed-start-test)
- [Configuration](#configuration)
- [Demo accounts](#demo-accounts)
- [Runbooks](#runbooks)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Operations](#operations)
- [Honest limits](#honest-limits)
- [How this was built](#how-this-was-built)
- [Licence](#licence)

## What is simulated

Read this before you demo the application to anyone.

- **Payments are simulated by default.** `RS_PAYMENT_PROVIDER` defaults to `fake`: a built-in fake PayPal and a fake approval page labelled "Simulated payment approval — not PayPal". Nothing leaves your machine.
- **PayPal is Sandbox-only, and no real money ever moves.** The optional `paypal-sandbox` provider talks only to the PayPal Sandbox (`api-m.sandbox.paypal.com`). Any other PayPal host, including the live one, is refused at startup. Use Sandbox credentials only.
- **Request reading (extraction) uses the local `claude` command-line tool by default** (`RS_MODEL_PROVIDER` defaults to `cli`) under a per-call and a daily cost ceiling. If it is unavailable, the application falls back to a simulated reader or to manual entry, and labels the result as such. The direct Anthropic API provider is optional. `RS_MODEL_PROVIDER=fake` forces the deterministic simulated reader.
- **Suppliers, products, prices, stock and the seven demo accounts are seeded demo data.** Every such object carries a demo label, and the interface shows "Test prices, not market prices".
- **Test mode.** With `RS_TEST_OFFLINE` set to 1 (the test harness does this) the user interface shows the banner "Test mode — local stubs, nothing is real".
- **Single-credential mode.** If you give the Sandbox provider one credential set (the `DEFAULT` set) instead of one per supplier, every demo supplier is paid to that one Sandbox account, and the interface says so ("All demo suppliers are paid to one Sandbox account").

## Verified and not verified

Verified here, on Linux with Node 22.22, by the automated suites against the **fake provider and a loopback PayPal stub**: the planner on the canonical fixture, extraction against the fake reader, reservation and oversell protection across processes, the payment saga, compensation and restart recovery against the fake, authorization rules, security scans, and browser journeys in Chromium. Run `npm test` and `npm run test:browser` yourself to reproduce.

**Not verified. Blocked on your credentials, allow-list and spend ceiling:**

- **PayPal Sandbox live runs (LIVE-P1, LIVE-P2).** The Sandbox adapter has only ever talked to the loopback stub. Real PayPal response shapes, the authorization status set, `final_capture`, `PayPal-Request-Id` replay and retention, webhook event names and signature verification against the real endpoint are open (OQ-D5). The RS-31(b) and RS-32(b) Sandbox journeys, with a human approving at PayPal's hosted Sandbox page, have not been run. Steps: [docs/runbooks/live-paypal.md](docs/runbooks/live-paypal.md).
- **The live model run (LIVE-M1).** No evaluation of a real model has been run. Every extraction result in the suites comes from the deterministic fake. The image input shape of the `claude` command-line tool is also unconfirmed against the real tool. Steps: [docs/runbooks/live-model.md](docs/runbooks/live-model.md).
- **Node 22.5 to 22.12** (open question Q9) is not supported; the branch is described below but not enabled or run.
- **Other platforms.** Only Linux with Node 22.22 was used. macOS and Windows are untested. The multi-process tests have run on Node 22.22 only.
- **No claim is made** about users, savings, supplier confirmations, successful live transactions or hackathon compliance. The demo data is fake.

## Requirements

- **Node.js 22.13 or newer.** RescueStock uses the built-in `node:sqlite` module, which Node 22.13 and later load without a flag. `package.json` declares `"engines": {"node": ">=22.13"}`.
- No runtime dependencies. The only development dependency is `@playwright/test`, used for the browser tests.
- `npm install` uses the npm registry only; nothing else is downloaded and RescueStock runs no install scripts of its own.

### Node floor and the 22.5 branch (Q9)

The floor is 22.13 today. `scripts/check-node.cjs` is a flag-free gate that every npm script runs first. On an older Node it prints "RescueStock needs Node >= 22.13 (found X). See README." and exits 1, before Node can reject a newer flag.

If the project owner decides to support Node 22.5 to 22.12 (open question Q9), the design has a second branch: `engines.node` becomes `>=22.5`, the gate checks 22.5, and every npm script and the manual start line gain `--experimental-sqlite` right after the second `node`. The multi-process tests then also need to pass on 22.5, and that run is the owner's. That branch is not enabled; do not run on Node older than 22.13 until it is.

## Install, seed, start, test

```sh
npm install        # npm registry only
npm run seed       # loads the demo data (idempotent; run it once on a new database)
npm start          # starts the server on http://127.0.0.1:3000
npm test           # unit, API, integration, evaluation, scan and timing tests
```

`npm start` runs this two-step line. You can run it yourself without npm:

```sh
node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning src/index.js
```

Run both steps, in that order. The first step is the Node-version gate. It has no flags on purpose, so that it works on any Node that can start.

Stop the server with Ctrl-C or SIGTERM; it shuts down gracefully (stops listening, closes the database and any model child process). Never use `kill -9` (see [docs/runbooks/operations.md](docs/runbooks/operations.md)).

`npm test` runs the `pretest` step (the Node gate and a clean `test/.out/`) first and the `posttest` step (`scripts/report-p95.js`, which fails if the API p95 latency is 300 ms or more) afterwards. It runs offline: a network guard refuses any outside connection. Run one full suite at a time: concurrent runs compete for CPU and can trip the timing checks.

`scripts/clean-checkout.sh` copies the tracked files to an empty directory and runs `npm install`, `npm test` and `npm start` there, then checks `GET /api/health`.

### Browser tests (once per machine)

```sh
npx playwright install chromium
npm run test:browser
```

### Live suites (opt-in, never part of `npm test`)

- `npm run test:live-model` calls a real model and bills your account. It refuses (exit 2) unless `RS_LIVE_MODEL` is 1 **and** a spend ceiling is set. See [docs/runbooks/live-model.md](docs/runbooks/live-model.md).
- `npm run test:live-paypal` runs against the PayPal Sandbox and needs a person to approve at PayPal's page for two of its checks. It refuses unless `RS_LIVE_PAYPAL` is 1 and Sandbox credentials are present. See [docs/runbooks/live-paypal.md](docs/runbooks/live-paypal.md).

Four more variables are read only by the live suites and the webhook route, never by the application's configuration. They are off by default and are not active lines of `.env.example`:

- `RS_LIVE_MODEL_CEILING_USD`: the most you are willing to spend on one live model run, an exact decimal from 0.01 to 5.00. It is required together with `RS_LIVE_MODEL=1`.
- `RS_LIVE_PAYPAL_HEADED`: set to 1 to run the two PayPal checks that need a person to approve at PayPal's page. Without it those checks are reported as skipped, never as passed.
- `RS_LIVE_PAYPAL_WEBHOOK_SAMPLE`: the path of one real Sandbox webhook event, for the live webhook check. Treat that file as sensitive.
- `RS_PAYPAL_WEBHOOK_ALGOS`: a comma-separated allow-list of PayPal webhook signature algorithms, for the case that PayPal does not use `SHA256withRSA`. Unset: `SHA256withRSA` only.

Never set `RS_LIVE_MODEL` or `RS_LIVE_PAYPAL` in a shell profile or a committed file.

## Configuration

All configuration comes from environment variables. `.env.example` lists every variable the application reads by name, with the non-secret defaults, and describes the few variables only the live suites read. The application does not read `.env` itself. To use a file:

```sh
cp .env.example .env
set -a; . ./.env; set +a; npm start
```

or, with the manual line and Node's own loader (the file must exist):

```sh
node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning --env-file=.env src/index.js
```

`.gitignore` covers `.env`, `data/` and `reports/`. Never commit a real value.

### Secrets

Secret variables: `ANTHROPIC_API_KEY`, `RS_ADMIN_PASSWORD`, `RS_DEMO_PASSWORD`, `RS_FAKE_WEBHOOK_SECRET`, and `RS_PAYPAL_<KEY>_CLIENT_ID`, `_CLIENT_SECRET` and `_WEBHOOK_ID` for KEY in A, B, C, D, E and DEFAULT. Length rules: `RS_ADMIN_PASSWORD` at least 16 characters, `RS_DEMO_PASSWORD` at least 12, `RS_FAKE_WEBHOOK_SECRET` at least 32 bytes. When `RS_FAKE_WEBHOOK_SECRET` is unset, a random key is generated once and kept in the database.

How to set them safely:

- Put them in the environment of the process: your platform's environment secrets, or a hidden prompt in your own terminal (examples in [docs/runbooks/live-paypal.md](docs/runbooks/live-paypal.md)).
- Never paste a secret into a chat, an issue, a commit, a screenshot or a command line (command lines land in shell history and in the process list).
- A `.env` file is acceptable only on your own machine; it is ignored by git.

Every secret line in `.env.example` is commented out and shows `<placeholder>`. This is deliberate. The configuration loader refuses any secret whose value is placeholder-shaped (angle brackets, `changeme`, `password`), including secrets the current mode does not use, and names the variable in the error, never the value. So a verbatim copy of `.env.example` starts with the defaults. Uncomment a secret line only after you replace the placeholder with a real value.

### Other rules the loader enforces

- `RS_SAGA_LEASE_MS` must be at least three times `RS_PAYPAL_TIMEOUT_MS`.
- `RS_PAYPAL_BASE_URL` and `RS_ANTHROPIC_BASE_URL` accept only their official hosts (a loopback stub only when `RS_TEST_OFFLINE` is 1).
- `RS_TEST_HOOKS` is refused with the Sandbox provider.
- `RS_MODEL_TIMEOUT_MS` is bounded to 1..40000, because the browser gives up on an extraction after 45 s.
- `RS_EXPLAIN_REPHRASE` is reserved: it is parsed but has no effect in version one. Opt-in rephrasing of explanations is built and unit-tested, but no route calls it, and the explanations you see are deterministic templates.
- Rate limits you can tune: `RS_PLAN_RATE_LIMIT` (default 10) per `RS_PLAN_RATE_WINDOW_MIN` (default 10) minutes for planning requests, and `RS_GENERAL_RATE_LIMIT` (default 300) per `RS_GENERAL_RATE_WINDOW_SEC` (default 60) seconds per signed-in user. Above a limit the answer is 429 with `Retry-After`.

### Public deployment

HTTPS goes through an optional reverse proxy. Set `RS_PUBLIC_URL` to the https origin (this adds `Secure` to the session cookie) and `RS_TRUST_PROXY` to 1. Add extra Host header values to `RS_ALLOWED_HOSTS` if the proxy forwards a different one. For a publicly reachable demo:

- set `RS_ALLOW_SIGNUP` to 0, so strangers cannot register. Five self-registered accounts from one address can otherwise spend the default USD 1.00 daily model budget (the budget gate bounds the damage, not the number of accounts);
- keep `RS_MODEL_CUSTOMER_DAILY_SHARE` at its default 0.2, so one customer cannot use up the model budget (or lower `RS_MODEL_DAILY_BUDGET_USD`);
- keep `RS_REGISTER_PER_IP_PER_HOUR` at its default (5). It limits registrations per client address per hour. Outside test mode the loader refuses a higher value;
- never raise `RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER`;
- leave the demo password unset (see below) and set `RS_ADMIN_PASSWORD`.

## Demo accounts

`npm run seed` creates seven demo accounts: `supplier-a` to `supplier-e`, `cafe1` and `cafe2`. The administrator signs in as `admin` with the password given in `RS_ADMIN_PASSWORD`; the seed does not create it, and the admin role stays disabled without it.

- With `RS_DEMO_PASSWORD` set, all seven demo accounts share it. That suits only a single-operator demo on a private machine.
- With it unset, each account gets its own random password. The seed prints them once to your terminal and stores only a hash. Note them down; running the seed again changes nothing and does not reprint them. To start over, stop the app and delete the database file.

## Operator note: demo runs and video retakes

A demo account may create 10 requests per day and hold 1 live reservation at a time. Between retakes:

- press "Abandon purchase" on an unfinished journey, or let the 30-minute reservation expire, so the next journey can reserve;
- use `cafe1` and `cafe2` alternately, or register a fresh customer;
- for a recording session on a private machine, start the server with `RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY` set to 100, or run the admin reset, which also clears the request-creation rate events (an admin-only, audited action);
- do not raise `RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER` on a publicly reachable deployment.

The user-run Sandbox journeys follow the same advice.

## Runbooks

| Runbook | Use it to |
|---|---|
| [docs/runbooks/live-model.md](docs/runbooks/live-model.md) | Run the opt-in live model evaluation (LIVE-M1) with a spend ceiling, and find its report |
| [docs/runbooks/live-paypal.md](docs/runbooks/live-paypal.md) | Set up the PayPal Sandbox, run the live checks (LIVE-P1) and the two Sandbox browser journeys (RS-31(b), RS-32(b), LIVE-P2) |
| [docs/runbooks/operations.md](docs/runbooks/operations.md) | Stop, restart, back up, roll back and recover; what to check after an unclean kill |
| [docs/submission/](docs/submission/) | Hackathon submission drafts and the checklist you complete yourself. Drafts only; nothing has been submitted |

## Architecture

One Node process, no runtime dependencies, SQLite as the single source of truth:

- **HTTP and UI.** `node:http` with an own router, and a vanilla ES-module single-page app in `public/` (no build step; the DOM is built with `textContent` only). Three small dashboards: customer, supplier, administrator.
- **Planner.** A pure, exact planner over integer cents. It is checked against a brute-force reference on random catalogs. Explanations and rejection codes are templates over planner output, not model prose.
- **Extraction.** A provider contract with three adapters: the `claude` CLI, the Anthropic API and a deterministic fake. Output is schema-validated and grounded in the request text; the buyer confirms every field. Model output never sets permissions, amounts, suppliers or plan versions.
- **Inventory and reservations.** Conditional updates inside `BEGIN IMMEDIATE` transactions with a `reserved <= on_hand` constraint, so two customers racing for the last bundle cannot both win, even across processes.
- **Payment saga.** Authorize at each supplier, capture only after every condition holds. A lease epoch fences a stalled process; every PayPal call is recorded before it is sent; after a lost response the reconciler reads provider state before any re-send. Compensation voids or refunds and keeps its status honest.
- **Providers.** A `PaymentProvider` contract with the fake (state kept in the same SQLite file) and the PayPal Sandbox adapter (credential per supplier, hosted approval link, so no client id reaches the browser). Polling is the primary path; webhooks are verified through PayPal when you have a public URL.
- **Honest statuses.** Plan, reservation, payment, fulfilment and the derived rescue status are separate state machines with explicit transitions.

The full design specification is part of the project record under `.eccode/artifacts/design/spec.md`.

## Security model

- **Authentication.** Server-side sessions in an `HttpOnly` `SameSite=Lax` cookie, scrypt password hashing, rotation on sign-in, throttled sign-in and registration.
- **Authorization.** Default-deny role policy table (a route without an entry refuses to start). Customers see only their own requests and orders; suppliers change only their own inventory; the demo reset and fault tools are administrator-only and audited.
- **Request integrity.** Session-bound CSRF header token, Origin check, Host allow-list, no CORS headers, a strict Content-Security-Policy and other security headers, hand-written validators, prepared SQL statements only, and image uploads checked by magic bytes with a 5 MiB cap.
- **Money.** The amount PayPal holds always comes from the server-approved plan, never from the browser. Retries are idempotent; a captured amount is never captured twice.
- **Secrets.** Read from the environment only, wrapped so they print as `[redacted]`, never logged, never sent to the browser, never passed to the model child process. Configuration errors name the variable, never the value.
- **Prompt injection.** Text from photos, requests and the catalog is data. It cannot change permissions, amounts, suppliers or plans.
- **Outbound hosts.** Only the PayPal Sandbox and the Anthropic API hosts are accepted, plus loopback in test mode.
- **Privacy.** See below. A photo you upload is stored and sent to the model provider byte for byte, **including any metadata such as an EXIF location**. Strip metadata first if that matters.

The security reviews and the threat list are in the project record; none of this has been tested against the live PayPal Sandbox.

## Operations

- **Health:** `GET /api/health` answers 200 with `{"status":"ok"}` when the database answers, 503 otherwise. `GET /api/config` shows the labels and mode without any secret.
- **Logs:** one JSON line per event on stdout, each with a request id. Only an allow-list of fields is logged; secrets and request text are never logged.
- **Metrics:** in-process counters and latency figures for the administrator at `GET /api/admin/metrics`, and an event timeline at `GET /api/admin/timeline` (also shown on the administrator page).
- **Rollback:** deployments are the previous commit plus the previous environment file. Database migrations only move forward and are checksummed, and the loader refuses a changed migration file. So before an upgrade, take a backup (below). To roll back, stop the server, check out the previous version, restore the backup taken before the upgrade, and start. For a quick risk reduction without a code rollback, use the switches: `RS_PAYMENT_PROVIDER` set to `fake`, `RS_MODEL_PROVIDER` set to `fake`, `RS_ALLOW_SIGNUP` set to 0.

### Data, retention and backups

- Uploaded images are deleted after 7 days (`RS_IMAGE_RETENTION_DAYS`). Raw request text, extractions and demo accounts are kept until the request is deleted or the administrator resets the demo.
- Files are created owner-only (directories 0700, files 0600). The database is `data/app.db`, uploads are under `data/uploads`. `npm start` tightens an existing `data/` and `data/uploads/` owned by the current user to 0700.
- Backup (optional for a demo), run under `umask 077` so the copy is not world-readable:

  ```sh
  (umask 077; sqlite3 data/app.db "VACUUM INTO 'backup.db'")
  ```

- Several processes may share one database file on the same host.

## Honest limits

- **Demonstration scope.** One city (Amman, time zone Asia/Amman), USD only, pickup only, English interface, five demo suppliers with one bundle each. No delivery, no real marketplace, no currency conversion.
- **Nothing live was exercised.** See [Verified and not verified](#verified-and-not-verified).
- **Model quality is unmeasured.** The deterministic fake proves the plumbing and the safeguards, not how well a real model reads Arabic, English or photos. Text inside an image cannot be checked server-side beyond the grounding rules.
- **"If something fails" shows the current plan only.** It lists outstanding voids and refunds of the current plan with their outcome. Completed voids of a closed plan are not listed there (decision FU-50); the buyer sees the refusal reason and that the new plan needs approval. The administrator can see past operations in the timeline.
- **Refunded orders.** An order whose own payment was refunded cannot be marked ready or handed over: the supplier gets 409 `HANDOVER_BLOCKED`, because the money went back to the cafe. The sibling orders of a partly refunded plan are unaffected and can still be marked ready and handed over. The other blocking payment states (unknown, capture pending, refund requested, refund pending, refund failed) still block every order of the plan.
- **Forced reset.** A forced administrator reset reports stranded payments as of the moment it archived them. With the Sandbox provider, finish those in the PayPal Sandbox dashboard by hand.
- **Unhandled kills.** `kill -9`, the out-of-memory killer and a container killed after its grace period can orphan a model child process. Each is bounded by the per-call cap. See the operations runbook.
- **Real PayPal behaviour may differ** from the stub and the fake in details listed under the Sandbox runbook; the fake models PayPal as the integration research understood it.
- **Webhooks** need a public HTTPS URL that you provide. Polling is the primary path and works without one.
- **Demo-grade operations.** One host, one SQLite file, no automatic backups, no high availability.
- **Lockfile.** `package-lock.json` lacks the optional macOS-only `fsevents` entry (a dependency of Playwright), so an install on macOS fetches `fsevents` without an integrity pin from the lockfile. Linux installs are unaffected (decision dec-mv4eaw35-013b929e).

## How this was built

The project owner directed the build and set the goals, scope and credibility rules. The code, tests and documents were produced by a team of AI agents working under the ECCode delivery toolkit, with separate agents reviewing the work against a written specification. The project record under `.eccode/` shows each task, review and decision. That process does not replace your own checks: run the tests, and run the live runbooks with your credentials before you rely on any Sandbox behaviour.

## Licence

MIT. See `LICENSE` (copyright "RescueStock contributors").
