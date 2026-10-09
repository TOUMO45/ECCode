# RescueStock

RescueStock helps a cafe rescue near-expiry stock. A customer describes what they need (text or a photo), the planner proposes the cheapest bundle purchase across suppliers, and the customer approves, pays and collects. It is a demonstration: the data is fake, the prices are test prices ("Test prices, not market prices"), and no real money moves.

> Status: first version of this README, written while the application is being built. It describes the designed behaviour (design specification revision 3). Parts that are not built yet are listed in the project plan, not here.

## What is simulated

Read this before you demo the application to anyone.

- **Payments are simulated by default.** `RS_PAYMENT_PROVIDER` defaults to `fake`: a built-in fake PayPal and a fake approval page labelled "Simulated payment approval — not PayPal". Nothing leaves your machine.
- **PayPal is Sandbox-only, and no real money ever moves.** The optional `paypal-sandbox` provider talks only to the PayPal Sandbox (`api-m.sandbox.paypal.com`). Any other PayPal host, including the live one, is refused at startup. Use Sandbox credentials only.
- **Request reading (extraction) uses the local `claude` command-line tool by default** (`RS_MODEL_PROVIDER` defaults to `cli`) under a per-call and a daily cost ceiling. If it is unavailable, the application falls back to a simulated reader or to manual entry, and labels the result as such. The direct Anthropic API provider is optional.
- **Suppliers, products, prices, stock and the seven demo accounts are seeded demo data.** Every such object carries a demo label.
- **Test mode.** With `RS_TEST_OFFLINE` set to 1 (the test harness does this) the user interface shows the banner "Test mode — local stubs, nothing is real".

## Requirements

- **Node.js 22.13 or newer.** RescueStock uses the built-in `node:sqlite` module, which Node 22.13 and later load without a flag. `package.json` declares `"engines": {"node": ">=22.13"}`.
- No runtime dependencies. The only development dependency is `@playwright/test`, used for the browser tests.

### Node floor and the 22.5 branch (Q9)

The floor is 22.13 today. `scripts/check-node.cjs` is a flag-free gate that every npm script runs first. On an older Node it prints "RescueStock needs Node >= 22.13 (found X). See README." and exits 1, before Node can reject a newer flag.

If the project owner decides to support Node 22.5 to 22.12 (open question Q9), the design has a second branch: `engines.node` becomes `>=22.5`, the gate checks 22.5, and every npm script and the manual start line gain `--experimental-sqlite` right after the second `node`. The multi-process tests then also need to pass on 22.5. That branch is not enabled; do not run on Node older than 22.13 until it is.

## Clean checkout: install, seed, start, test

```sh
npm install        # npm registry only; no other package source, no postinstall scripts of ours
npm run seed       # loads the demo data (idempotent; run it once on a new database)
npm start          # starts the server on http://127.0.0.1:3000
npm test           # unit, API, integration, evaluation, scan and timing tests
```

`npm start` runs this two-step line. You can run it yourself without npm:

```sh
node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning src/index.js
```

Run both steps, in that order. The first step is the Node-version gate. It has no flags on purpose, so that it works on any Node that can start.

Stop the server with Ctrl-C or SIGTERM; it shuts down gracefully (stops listening, closes the database).

### Browser tests (once per machine)

```sh
npx playwright install chromium
npm run test:browser
```

### Live suites (opt-in, never part of `npm test`)

- `npm run test:live-model` calls the real model and bills your account. It refuses to run unless `RS_LIVE_MODEL` is set to 1. Keep the daily budget (`RS_MODEL_DAILY_BUDGET_USD`) and call cap (`RS_MODEL_CALL_CAP_USD`) at their small defaults.
- `npm run test:live-paypal` runs against the PayPal Sandbox. It refuses to run unless `RS_LIVE_PAYPAL` is set to 1 and Sandbox credentials are present. Allow-list only `api-m.sandbox.paypal.com` and `www.sandbox.paypal.com` in any network policy. Provide the credentials as environment secrets (see below), not in a file that is committed. Merchant modes: one Sandbox credential set per supplier (A to E), or one `DEFAULT` set for all suppliers (single-credential mode; the user interface says so). A webhook URL is optional, because polling is the primary path.

## Configuration

All configuration comes from environment variables. `.env.example` lists every variable by name, with the non-secret defaults. The application does not read `.env` itself. To use a file:

```sh
cp .env.example .env
set -a; . ./.env; set +a; npm start
```

or, with the manual line and Node's own loader (the file must exist):

```sh
node scripts/check-node.cjs && node --disable-warning=ExperimentalWarning --env-file=.env src/index.js
```

`.gitignore` covers `.env`, `data/` and `reports/`. Never commit a real value.

Every secret line in `.env.example` is commented out and shows `<placeholder>`. This is deliberate. The configuration loader refuses any secret whose value is placeholder-shaped (angle brackets, `changeme`, `password`), including secrets the current mode does not use, and names the variable in the error. So a verbatim copy of `.env.example` starts with the defaults. Uncomment a secret line only after you replace the placeholder with a real value.

Secret variables: `ANTHROPIC_API_KEY`, `RS_ADMIN_PASSWORD`, `RS_DEMO_PASSWORD`, `RS_FAKE_WEBHOOK_SECRET`, and `RS_PAYPAL_<KEY>_CLIENT_ID`, `_CLIENT_SECRET` and `_WEBHOOK_ID` for KEY in A, B, C, D, E and DEFAULT. Length rules: `RS_ADMIN_PASSWORD` at least 16 characters, `RS_DEMO_PASSWORD` at least 12, `RS_FAKE_WEBHOOK_SECRET` at least 32 bytes. When `RS_FAKE_WEBHOOK_SECRET` is unset, a random key is generated once and kept in the database.

Other rules the loader enforces: `RS_SAGA_LEASE_MS` must be at least three times `RS_PAYPAL_TIMEOUT_MS`; `RS_PAYPAL_BASE_URL` and `RS_ANTHROPIC_BASE_URL` accept only their official hosts (a loopback stub only when `RS_TEST_OFFLINE` is 1); `RS_TEST_HOOKS` is refused with the Sandbox provider.

### Public deployment

HTTPS goes through an optional reverse proxy. Set `RS_PUBLIC_URL` to the https origin (this adds `Secure` to the session cookie) and `RS_TRUST_PROXY` to 1. Add extra Host header values to `RS_ALLOWED_HOSTS` if the proxy forwards a different one. For a publicly reachable demo:

- set `RS_ALLOW_SIGNUP` to 0, so strangers cannot register;
- keep `RS_MODEL_CUSTOMER_DAILY_SHARE` at its default 0.2, so one customer cannot use up the model budget;
- keep `RS_REGISTER_PER_IP_PER_HOUR` at its default (5). It limits registrations per client address per hour. Outside test mode the loader refuses a higher value;
- never raise `RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER`;
- leave the demo password unset (see below) and set `RS_ADMIN_PASSWORD`.

## Demo accounts

`npm run seed` creates seven demo accounts: `supplier-a` to `supplier-e`, `cafe1` and `cafe2`. The admin role signs in with the password given in `RS_ADMIN_PASSWORD`; the seed does not create it.

- With `RS_DEMO_PASSWORD` set, all seven demo accounts share it. That suits only a single-operator demo on a private machine.
- With it unset, each account gets its own random password. The seed prints them once to your terminal and stores only a hash. Note them down; running the seed again changes nothing and does not reprint them. To start over, stop the app and delete the database file.

## Operator note: demo runs and video retakes

A demo account may create 10 requests per day and hold 1 live reservation at a time. Between retakes:

- press "Abandon purchase" on an unfinished journey, or let the 30-minute reservation expire, so the next journey can reserve;
- use `cafe1` and `cafe2` alternately, or register a fresh customer;
- for a recording session on a private machine, start the server with `RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY` set to 100, or run the admin reset, which also clears the request-creation rate events (an admin-only, audited action);
- do not raise `RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER` on a publicly reachable deployment.

The user-run Sandbox journeys follow the same advice.

## Data, retention and backups

- Uploaded images are deleted after 7 days (`RS_IMAGE_RETENTION_DAYS`). Raw request text, extractions and demo accounts are kept until the request is deleted or the admin resets the demo.
- Files are created owner-only (directories 0700, files 0600). The database is `data/app.db`, uploads are under `data/uploads`.
- Backup (optional for a demo): `sqlite3 data/app.db "VACUUM INTO 'backup.db'"`.
- Several processes may share one database file on the same host.

## Operations

- **Health:** `GET /api/health` answers 200 with `{"status":"ok"}` when the database answers, 503 otherwise. `GET /api/config` shows the labels and mode without any secret.
- **Logs:** one JSON line per event on stdout, each with a request id. Only an allow-list of fields is logged; secrets and request text are never logged.
- **Rollback:** deployments are the previous commit plus the previous environment file. Database migrations only move forward and are checksummed, and the loader refuses a changed migration file. So before an upgrade, take a backup (above). To roll back, stop the server, check out the previous version, restore the backup taken before the upgrade, and start. For a quick risk reduction without a code rollback, use the switches: `RS_PAYMENT_PROVIDER` set to `fake`, `RS_MODEL_PROVIDER` set to `fake`, `RS_ALLOW_SIGNUP` set to 0.

## Licence

MIT. See `LICENSE` (copyright "RescueStock contributors").
