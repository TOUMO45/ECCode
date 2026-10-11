# Runbook: operations (start, stop, back up, roll back, recover)

This covers one host running one RescueStock server against one SQLite file. It is demonstration-grade operations, not a high-availability setup. Values are placeholders or defaults; set real secrets only through the environment (see the README, "Secrets").

## Start and check

```sh
npm run seed     # once per new database
npm start
```

Then check `GET /api/health` (200 `{"status":"ok"}` when the database answers, 503 otherwise) and `GET /api/config` (labels and mode, no secret). The `listening` log line shows the address. Logs are JSON lines on stdout, each with a `requestId`; the reconciler logs `reconcile.tick` with `requestId` of the form `sys-...`.

## Stop

Stop the server with Ctrl-C, `kill <pid>` (SIGTERM) or by closing its terminal (SIGHUP). All three stop listening, close the model adapter (which ends its `claude` child processes) and close the database. A second signal during the grace period is swallowed so it cannot kill a half-closed server.

**Never use `kill -9`**, and avoid anything that ends in it: the out-of-memory killer, and a container stopped after its grace period. In those cases no shutdown hook runs, and a model child process can be orphaned. Each orphan is bounded by the per-call budget flag (`RS_MODEL_CALL_CAP_USD`, default 0.05), and the server's reservation sweep settles the call's cost row at the cap after twice `RS_MODEL_TIMEOUT_MS` once the server runs again. After an uncatchable kill, check for a leftover process and end its group:

```sh
pgrep -af "claude -p"
```

Keep the terminal of a live run (`npm run test:live-model`) open until it ends, and stop it with Ctrl-C.

## Restart and crash recovery

Restart with the same environment and the same database file. Orders, payment operations and recovery progress live in SQLite. On start the reconciler runs once, then every `RS_RECONCILE_INTERVAL_MS` (default 15000): it marks stale intents unknown, reads provider state before it re-sends any call that may have been sent, takes over an expired execution lease, and completes or compensates the saga. A call that was queued but never started is not read first: it provably never reached the network. Several processes may share one database file on the same host.

Escalation: an operation unknown for `RS_UNKNOWN_ESCALATE_MIN` (default 15) minutes, or pending for `RS_PENDING_ESCALATE_MIN` (default 1440), makes the request read `failed_needs_attention`. Look at the administrator page: the metrics (`GET /api/admin/metrics`, with unresolved counts) and the timeline (`GET /api/admin/timeline?requestId=<id>`) show every audit, ledger, provider-call and webhook event, **including completed voids and refunds of plans that are no longer current**. The buyer's "If something fails" panel lists only the current plan's outstanding voids and refunds (decision FU-50).

## Demo reset (administrator only, audited)

The administrator page has a reset with an optional force flag and a reason of 10 to 500 characters. A plain reset is refused (409 `RESET_BLOCKED`) while any payment operation is unfinished. A forced reset voids authorized operations and tries to resolve unknown ones for up to 30 s, then archives everything and lists what it could not finish as stranded. That list is **as of the moment of archiving**: a capture that was in flight when the reset ran can still complete afterwards, and its refund is never sent because archived operations are not sent. With the PayPal Sandbox provider, check each stranded entry in the Sandbox dashboard and finish it by hand. With the fake provider the reset has cleared the simulated records, so there is nothing outside RescueStock to check.

## Back up

Optional for a demo. Take one before every upgrade:

```sh
(umask 077; sqlite3 data/app.db "VACUUM INTO 'backup.db'")
```

The `umask` keeps the copy from being world-readable. Uploads under `data/uploads` are separate files; copy that directory too if you need the photos. The backup contains request text, hashed passwords and payment identifiers: treat it as sensitive and keep it out of git (`data/` is ignored; so is `reports/`).

## Roll back

A deployment is the previous commit plus the previous environment file. Database migrations only move forward and are checksummed; the loader refuses a changed migration file. So:

1. Before the upgrade, take a backup (above).
2. To roll back: stop the server, check out the previous version, restore the backup taken before the upgrade (copy it over `data/app.db`, with the server stopped), and start.
3. Without a code rollback, reduce risk with the switches: `RS_PAYMENT_PROVIDER` set to `fake`, `RS_MODEL_PROVIDER` set to `fake`, `RS_ALLOW_SIGNUP` set to 0. Do not switch the payment provider while payments are unfinished; finish or reset them first (this interaction has not been tested).

## Configuration refusals

If the server exits at start with a configuration error, it names the variable (never the value). Common causes: a secret still shaped like a placeholder (`<...>`, `changeme`, `password`); `RS_ADMIN_PASSWORD` under 16 characters or `RS_DEMO_PASSWORD` under 12; `RS_SAGA_LEASE_MS` under three times `RS_PAYPAL_TIMEOUT_MS`; `RS_MODEL_TIMEOUT_MS` above 40000; a base URL that is not the official host; `RS_TEST_HOOKS` with the Sandbox provider; `RS_REGISTER_PER_IP_PER_HOUR` above 5 outside test mode.

## Node version

The start line runs a flag-free gate first and prints "RescueStock needs Node >= 22.13 (found X). See README." on an older Node. Node 22.5 to 22.12 is not supported (open question Q9; see the README).
