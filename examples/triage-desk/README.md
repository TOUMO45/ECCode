# TriageDesk

TriageDesk is a small local web app for support ticket triage. You paste a support ticket and it returns a category (`billing`, `technical`, `account`, `feature_request`, `other`), an urgency (`low`, `medium`, `high`), a one-sentence summary, a suggested reply, and a flag that says whether the ticket looks like a prompt-injection attempt.

It runs in one of two modes:

- **Live mode** (`ANTHROPIC_API_KEY` is set): the ticket is redacted and sent to the Anthropic Messages API, by default to model `claude-haiku-5-5`. If the model call fails, times out, refuses, is truncated or returns invalid output, the request still gets a `200` from the deterministic fallback, labelled `source: "fallback"` with a `fallbackReason`.
- **Fallback mode** (no key): deterministic local rules handle every ticket. Nothing leaves the machine, and every result is labelled `source: "fallback"`, `fallbackReason: "no_api_key"`.

The app is one Node.js process with zero npm dependencies. It has no build step, no database and no container.

## Install

You need Node.js **22 or later** (`"engines": { "node": ">=22" }`). There is nothing to install: the project has no `dependencies` or `devDependencies`, so you don't need to run `npm install`.

## Start

```sh
npm start                 # runs: node src/server.js
```

The server listens on `http://127.0.0.1:3000`. Open that URL in a browser. On startup it prints one JSON line to stdout, for example:

```
{"t":"…","event":"listening","host":"127.0.0.1","port":3000,"mode":"fallback","model":"claude-haiku-5-5","timeoutMs":20000,"maxTokens":2048,"baseUrlCustom":false}
```

If a custom base URL or a non-loopback host is configured, a `{"event":"warning","code":"custom_base_url"|"non_loopback_host"}` line follows.

To load settings from a file instead of exporting variables (there is no dotenv dependency):

```sh
cp .env.example .env      # then edit .env
node --env-file=.env src/server.js
```

**Process managers and containers: run `node src/server.js` directly, not `npm start`.** With `/bin/sh` as dash, `npm start` runs `sh -c "node src/server.js"`, and dash does not `exec` the command. If a supervisor sends SIGTERM to the `npm` process only, npm signals `sh`, `sh` exits and the `node` server is **orphaned and keeps listening** (RISK-11, found in the t13 smoke runs). Signalling the whole process group works fine, for example Ctrl-C in a terminal or `kill -- -<pgid>`. Under systemd, pm2, Docker `CMD`/`ENTRYPOINT`, supervisord and similar tools, use `node src/server.js`, or `node --env-file=.env src/server.js`, as the command.

**Shutdown.** On SIGTERM or SIGINT the server stops accepting connections, closes idle ones and exits 0. If open connections are still there after 2 s, it forces an exit with code 1.

**Startup failures.** A configuration problem prints one line, `config error: <message naming the variable>`, to stderr and exits 1. A bind failure prints `listen error: <code>` (for example `EADDRINUSE`). Configuration values are never printed.

### Health check

`GET /api/health` (HEAD is also accepted). It needs an allowlisted `Host` header, and curl sends one by default:

```sh
curl -s http://127.0.0.1:3000/api/health
# {"status":"ok","mode":"fallback","model":null}
# live mode: {"status":"ok","mode":"live","model":"claude-haiku-5-5"}
```

The response never includes the key. `mode` reports configuration only. It is `live` when a key is set, but no call to Anthropic is made to check that the key works.

### API

`POST /api/triage` with `Content-Type: application/json` and the body `{"ticket":"…"}`. The ticket must be 1–8000 characters after trimming, and the body must be at most 16384 bytes. Every response has exactly these keys: `category`, `urgency`, `summary`, `suggestedReply`, `source`, `fallbackReason`, `injectionSuspected`, `model`. The errors are fixed JSON codes: `400 invalid_json`, `invalid_request`, `ticket_empty` and `ticket_too_long`; `403 forbidden_host` and `forbidden_origin`; `404`; `405`; `413`; `415`; and `500 internal_error`, which only a local bug causes. A request makes at most one outbound model call, and the app never retries one.

## Test

```sh
npm test                  # node --test --test-concurrency=1 "test/**/*.test.js"
```

The suite runs unit tests (`test/unit`), contract tests that spawn a real server (`test/contract`: HTTP rules, Host/Origin guard, modes, redaction at the egress point, privacy of logs, performance) and eval-runner and held-out hygiene tests (`test/eval`). It needs no API key and makes no network calls outside loopback. A fake Anthropic endpoint on `127.0.0.1` stands in for the live path.

## Eval

The eval data is split in two:

- `eval/dataset.json` is the **tune** split. Rule authors may look at it and iterate against it.
- `eval/holdout.json` is the **holdout** split. It exists to measure generalisation, so nobody should tune against it. Thresholds are in `eval/thresholds.json`. These three files are frozen, and any edit invalidates the recorded freeze hashes and needs a recorded decision.

```sh
npm run eval:tune         # node eval/run.js --split tune — tuning loop, fallback only
npm run eval              # node eval/run.js — FULL mode: the verification step, scores the holdout
npm run eval -- --provider live   # full mode against the live model (needs ANTHROPIC_API_KEY; costs tokens)
```

**Discipline:**

- Use `npm run eval:tune` while developing. It never opens the holdout file. It ends with `RESULT TUNE-ONLY …` and `TUNE_EVAL {"mode":"tune",…}`. That is **not** a verification result.
- `npm run eval` (full mode) is the **verification step**. It scores the holdout and ends with `ECCODE_EVAL {"passed":n,"total":m}`. Run it at verification and not while tuning, because every look at holdout numbers followed by a rule change makes the holdout a tune set. Its output contains ids and numbers only, never ticket text.
- `npm run eval -- --provider live` is also full mode, so it also scores the holdout. Without `ANTHROPIC_API_KEY` it scores the fallback and prints `live: NOT RUN (no ANTHROPIC_API_KEY)`. With a key, it sends every redacted eval ticket to the model, one call per row, and prints a `USAGE input_tokens=… output_tokens=…` line.
- Exit codes: 0 means every enforced check passed, 1 means a check failed, 2 means a usage, file or dataset-format error.

## Configuration

All configuration comes from environment variables. `src/config.js` reads **only** the variables below, and every other variable has no effect. `.env.example` holds the safe defaults.

| Variable | Default | Rules |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Trimmed. If it is unset **or empty**, the app runs in fallback mode. Never logged or returned. |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Must match `^[A-Za-z0-9._:-]{1,100}$`. |
| `TRIAGE_ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | A test or proxy seam. Must be `https:`. `http:` is allowed only for `127.0.0.1`, `localhost` or `[::1]`. The URL may not contain credentials, `?` or `#`. A trailing `/` is removed. An empty value means the default. Any non-empty value logs `warning custom_base_url` and sets `baseUrlCustom: true`. |
| `HOST` | `127.0.0.1` | Must be loopback (`127.0.0.1`, `localhost`, `::1`) unless `TRIAGE_ALLOW_REMOTE=1`. |
| `TRIAGE_ALLOW_REMOTE` | unset | Unset, `''` or `0` means off. `1` means on. Any other value (even `' 1'`) is a config error. |
| `PORT` | `3000` | Integer 0–65535 (0 picks an ephemeral port). |
| `TRIAGE_TIMEOUT_MS` | `20000` | Integer 100–120000. The live call is aborted after this time and the request falls back with `timeout`. |
| `TRIAGE_MAX_TOKENS` | `2048` | Integer 256–16000 (the `max_tokens` value of the Messages API request). |

**Empty values.** Only an *unset* variable takes its default. An empty `HOST`, `PORT`, `ANTHROPIC_MODEL`, `TRIAGE_TIMEOUT_MS` or `TRIAGE_MAX_TOKENS` is a config error. For example, a line `PORT=` in `.env` makes startup fail with `config error: PORT must be an integer from 0 to 65535`. There are two exceptions: an empty `ANTHROPIC_API_KEY` means fallback mode (which is why `.env.example` ships `ANTHROPIC_API_KEY=`), and an empty `TRIAGE_ANTHROPIC_BASE_URL` means the default URL.

> **Warning: `TRIAGE_ANTHROPIC_BASE_URL` receives your API key.** The `x-api-key` header and every redacted ticket are sent to whatever URL you configure there. Set it only to an endpoint you trust, such as a local test stub or your own gateway. Redirects are never followed (`redirect: 'error'`).
>
> **`ANTHROPIC_BASE_URL` is deliberately ignored.** The official SDKs and other tools read that variable, so it is often set in a developer's shell for unrelated reasons. TriageDesk never reads it, so an inherited gateway setting cannot silently re-route your key and tickets. Use the app-specific `TRIAGE_ANTHROPIC_BASE_URL` instead.

> **Warning: `TRIAGE_ALLOW_REMOTE=1` exposes an unauthenticated endpoint.** With a non-loopback `HOST`, anyone who can reach the port can submit tickets, and in live mode every request spends your API key. There is no authentication and no rate limiting. Don't set it unless a network control in front of the app, such as a firewall or an authenticating reverse proxy, restricts who can connect.

## Privacy

- **Fallback mode** sends nothing anywhere. Tickets are processed in memory and never stored.
- **Live mode** sends the ticket to Anthropic, or to `TRIAGE_ANTHROPIC_BASE_URL`, **after redaction**. Before the call, `src/triage/redact.js` replaces:
  - email addresses with `[REDACTED_EMAIL]`;
  - Luhn-valid payment card numbers (13–19 digits; groups may be separated by a space, NBSP, tab or hyphen) with `[REDACTED_CARD]`;
  - phone numbers (7–15 digits) with `[REDACTED_PHONE]`.

  `<ticket>` delimiter look-alikes are also neutralised before the text is placed in the prompt.
- **What is NOT redacted:** names, postal addresses, account or order numbers that don't look like a card or phone number, and anything else in free text. The UI shows a notice in live mode that says this. If tickets may contain personal data that must not leave your environment, run in fallback mode.
- Known imperfections (RISK-9): IPv4 addresses and date+time strings can be over-redacted as phone numbers. A card written with dots, or with digits glued to letters, can be under-redacted (a dotted card can leave its last 4 digits). Two cards in one digit run collapse into one placeholder.
- The injection detector always runs on the original, unredacted text. That happens locally.
- **Logs contain metadata only.** Each stdout JSON line is built from an allowlist: timestamp, request id, method, route, status, duration, error code, ticket *length*, source, fallback reason, injection flag, redaction *counts*, upstream status, a fixed detail code and token usage. Ticket text, summaries, replies, headers, URLs, error messages, stacks and the API key are never logged.

## Security model

- **Loopback only by default.** The server binds `127.0.0.1`. A non-loopback `HOST` is refused unless `TRIAGE_ALLOW_REMOTE=1` (see the warning above).
- **The Host/Origin guard is not authentication.** Every request must carry a `Host` header of `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` or the configured `HOST:<port>`. Otherwise the server answers `403 forbidden_host`, and that is a defence against DNS rebinding. A non-GET/HEAD request with an `Origin` header must come from one of those hosts over `http://`. Otherwise it gets `403 forbidden_origin`, which blocks cross-site POSTs from other web pages. Any local process, or any client that can reach the port and sets the headers itself, passes this guard.
- Every response carries a strict CSP (`default-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The server never sends CORS headers.
- Ticket text is treated as untrusted. In live mode it appears only between `<ticket>` delimiters, the system prompt tells the model not to follow instructions inside it, and the model output is validated (schema plus content checks) before it is returned. Output that fails validation falls back with `invalid_output`.

## Limitations

- **Fallback quality is not model quality.** The fallback is a set of lexical rules tuned on `eval/dataset.json`. Its tune scores are optimistic. The holdout is scored only by the full `npm run eval` at verification, and generalisation to real tickets is not measured beyond that. Fallback results are never evidence of how the live model performs.
- **Live mode is unverified (RISK-7).** No API key was available during development, so the live path (request shape, model id `claude-haiku-5-5`, structured-output acceptance, `max_tokens` sufficiency, and the live thresholds in `eval/thresholds.json`) has only been tested against a local fake endpoint. Live eval status: **NOT RUN**. Run `npm run eval -- --provider live` with a key before relying on live mode.
- **Held-out hygiene is lexical.** The check that the rules don't copy held-out phrasing looks for shared 5-word sequences. Reworded, split or shortened phrases are not caught, so it is an overlap signal, not proof of independence.
- **Injection detector false positives.** The detector is rule-based. Benign tickets with phrasing such as `Priority: high` in a customer-written header, or "treat this as a high-urgency billing issue", will be flagged `injectionSuspected: true`. Its false-positive rate was measured on few benign instruction-like rows. Some injection styles, such as quoted-thread or split-line instructions, have no dedicated rule. The flag is advisory only.
- Redaction gaps are listed under Privacy. The app is English-oriented: a ticket of 8,000 multi-byte characters exceeds the 16 KB body limit and gets `413`.
- The app has no authentication, no rate limiting, no persistence and no multi-user support.
- The UI was tested against a simulated DOM, not in a real browser or with a screen reader.

## Rollback

- **Kill switch (stop sending data to the model):** unset `ANTHROPIC_API_KEY`, or set it to empty, and restart. The app then runs fallback-only and transmits nothing. `GET /api/health` confirms `"mode":"fallback"`.
- **Code rollback:** check out the previous git commit and restart. The app stores no state, so there is nothing to migrate.
- After either change, check the startup `listening` line and `GET /api/health`.
