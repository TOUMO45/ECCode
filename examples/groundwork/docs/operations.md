# Operations: health, logs, shutdown, backup, rollback

Scope: a local, single-process demo run. There is no hosted deployment.

Release status: the third and final sealed holdout (`eval/holdout`, `hold3-*`) passed all metrics for both providers on its first and only evaluation (M1c 1/434 = 0.23%). This is measured evidence, not human acceptance: no user acceptance is recorded, and one false flag (`hold3-08`) remains open. See [eval-results.md](eval-results.md). All holdout run caps are now used (the operator extended them once); do not run `npm run eval --holdout` again, and live eval runs may be refused with exit 2. `eval/usage.log` holds 12 full non-holdout CLI tune runs against a cap of 8 (overrun by 4); the cap guard was a no-op until the rework-3 fix and now refuses further full tune runs (see eval-results.md).

## One command each

| Action | Command |
|---|---|
| Install | none (zero dependencies) |
| Test | `npm test` |
| Start | `npm start` (runs pending migrations, then serves) |
| Seed demo data | `npm run seed` |

Runtime is pinned by `engines.node` `>=22.5` in `package.json`. See the README for all environment variables and defaults.

## Health

`GET /api/health` needs no sign-in and returns `200`:

```
{"status":"ok","version":"1.0.0","schemaVersion":2}
```

It reads the schema version from the database, so a broken database connection makes it fail instead of returning `ok`. It does not report provider status: the Claude CLI and the Anthropic API are called only when a draft is generated, and failures there come back as a normal API error with a fallback option, not as a health failure. Quick check:

```
curl -fsS http://127.0.0.1:3000/api/health
```

## Logs and observability

With `GW_LOG=json` (default) each request writes one JSON line to stdout:

```
{"ts":"...","requestId":"2857641c36199ea6","method":"GET","route":"/api/health","status":200,"durationMs":3,"userId":null,"errorCode":null}
```

- `requestId` is also returned in the `X-Request-Id` header and in every error envelope, so a user-reported error can be matched to a log line.
- Latency is `durationMs`; errors are lines with `status >= 400` or a non-null `errorCode`. Unexpected server errors are logged with `level: "error"` and the error class only.
- There are no built-in counters or a metrics endpoint. Aggregate from the log, for example `jq 'select(.status>=500)'` on a captured log.
- Passwords, session tokens, the API key and note text are not logged. Sensitive actions (sign-in, draft generation, publish) are written to the audit log table in the database.
- Startup and shutdown emit `{"event":"startup",...}` and `{"event":"shutdown","signal":...}`.

## Graceful shutdown

On `SIGINT` or `SIGTERM` the process stops the session purge timer, closes the HTTP server, closes the database, logs the shutdown event and exits 0. Signal the node process itself: SIGTERM sent only to the `npm start` wrapper process was observed not to stop the server (it kept running), so a service manager should run `node --disable-warning=ExperimentalWarning src/index.js`. A second signal during shutdown is ignored. Verified by hand during writing of this document: SIGTERM produced the shutdown line above and a clean exit.

## Backup

Stop the server, then copy the database file together with `-wal` and `-shm` files if they exist:

```
cp data/groundwork.db* /safe/place/
```

Restoring is the reverse copy with the server stopped.

## Rollback

The application has no feature flags. Rollback is "run the previous version of the code", plus a database step if the new version added a migration.

1. Before upgrading: stop the server and back up the database (above). Record the current git commit (`git rev-parse HEAD`).
2. To roll back: stop the server and `git checkout <previous-commit>` (or restore the previous release directory).
3. Decide on the database:
   - If the new version did **not** add a migration file under `src/db/migrations/`, start the previous code against the same database. Nothing else to do.
   - If it **did** add a migration, the previous code refuses to start against the migrated database (it aborts when the database is newer than its migration files). Restore the pre-upgrade backup of the database instead. Data written after the upgrade is lost; export anything needed first. Migrations are forward-only; there are no down-migrations, and applied migration files must never be edited (a checksum check aborts startup).
4. Start (`npm start`) and check `curl -fsS http://127.0.0.1:3000/api/health`: `schemaVersion` must equal the previous version's number of migrations.
5. If the problem is only the AI provider, no rollback is needed: pick the fallback provider in the UI, or unset `ANTHROPIC_API_KEY` and `GW_ENABLE_FAKE`.

## Configuration and secrets

- All settings are environment variables with defaults, listed in the README. Invalid values stop startup with a message that names the variable, not its value.
- The only secret is `ANTHROPIC_API_KEY` (optional). Supply it through the environment of your service manager; never commit it. `.env` is git-ignored.
- The CLI provider runs `claude` with a restricted environment; `GW_CLI_ENV_PASS` lists extra variables to forward, so do not put secrets there unless the CLI needs them.
- Demo passwords come from `scripts/seed.js` (documented in the README). Change them with `scripts/set-password.js` before any use beyond a local demo.
