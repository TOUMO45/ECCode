# Security review: phase B submission (phase:b-foundation), version 1

Reviewer: security-reviewer. Run: run-mv1h3f63-01201aad. Gate: `phase:b-foundation`, submission `sub-mv1h2gly-014b868a` (recording reviewer: technical-reviewer).
Inputs: the submission's 109 artifacts, `.eccode/artifacts/phase-b/submission.md`, the approved design `.eccode/artifacts/design/spec.md` (revision 3) and my design review `.eccode/reviews/drafts/design-security-1.md` (SEC-1..20).
Every check cited below was recorded against the submitted tree with `--actor security-reviewer --gate phase:b-foundation`. No project file changed during the review.

## Verdict

**I would not block the phase.** Every security property phase B owns holds when I run it:
- **Secrets.** The `Secret` wrapper resists JSON, `util.inspect` (including `customInspect:false` and `showHidden`), `format`, template strings, `structuredClone` and `Error.cause`. Placeholder refusal works for all 22 secret variables in four shapes. Error messages name the variable only.
- **Outbound hosts.** The PayPal and Anthropic allow-lists refuse every bypass shape I tried (21 values per variable, mixed accept and refuse), and loopback is accepted only under `RS_TEST_OFFLINE=1`, which also sets `testMode`.
- **HTTP boundary.**
  - The Host allow-list answers 421 for every bad host shape.
  - Request ids are pattern-checked.
  - The security headers and the exact CSP are on every response kind, and no `Access-Control-*` header is sent.
  - The 64 KiB cap holds both for a declared length and for chunked bodies.
  - Default deny answers 401 for all five non-public policies.
  - Static confinement refused 21 traversal, symlink, dotfile and NUL shapes.
  - The error envelope leaks no message, SQL or path.
  - SQLITE_BUSY becomes 503 with `Retry-After: 1`.
- **Database and scripts.**
  - The database and its WAL/SHM files are 0600 and `data/` is 0700.
  - The seed prints 96-bit random passwords once and never logs them.
  - Migrations refuse a changed file.
  - `db.tx` refuses nesting and promises.

There is **one major finding, SEC-B-1.** It concerns the planner's `PLANNER_LIMIT` cap, which customer- and supplier-shaped input can reach. A request that a single supplier could fill is refused, and each refused call holds the event loop for about 0.15–0.3 s. The route that exposes this (`POST /api/requests/:id/plan`, task c2) is not built yet, so nothing is exploitable in phase B. I do not block on it. It should either be fixed in `src/domain/planner.js` before c2 is dispatched, or be recorded as a risk with an owner when the gate is approved. The two minors (SEC-B-2 append-only bypass, SEC-B-3 deep-nesting 500) are each a one-to-ten-line fix and can go to c1/c2. The rest is info.

## Evidence

| ev id | what | result |
|---|---|---|
| ev:ev-mv1h4qzv-01f4c558 | `npm test` (phase B suite), offline under the net guard | passed, 364/364 |
| ev:ev-mv1idwc0-01c3fc7c | `.eccode/drafts/sec-phb-http.mjs`, raw-socket probes A–K (details below) | passed. It includes the SEC-B-3 reproduction expectation, `canonicalJson` throws RangeError |
| ev:ev-mv1hsot4-01da707f | The same probe run with `--slowloris` appended (an earlier revision of the file, same sections) | exit 1. Every boundary expectation passed; the only failure is the slow-header connection still open at 50 s (SEC-B-4) |
| ev:ev-mv1i7xgl-01c089fa | `.eccode/drafts/sec-phb-config-db.mjs` (details below) | passed, including the three SEC-B-2 REPRO lines and the recursive_triggers control |
| ev:ev-mv1i9q9c-01ca3c24 | `.eccode/drafts/sec-phb-planner-sweep.mjs` (reproduction): 5,400 API-shaped planner inputs plus the concrete SEC-B-1 case | exit 1 = reproduced. PLANNER_LIMIT after 135.2 ms; control with maxPickups 1: feasible, A, 301,000 cents, in 0.1 ms |
| ev:ev-mv1i9u6p-0136e358 | `.eccode/drafts/sec-phb-domain-scripts.mjs`: 3,000 random API-shaped planner inputs, explanation text sources (SEC-7/T10), seed script, Node gate | passed. 9 PLANNER_LIMIT, max 206.7 ms |
| ev:ev-mv1ibkqk-015a9f85 | `.eccode/drafts/sec-phb-slowloris.mjs`: slow-header and slow-body connections on fresh `createHttpServer` servers | passed. Headers closed at 30.0 s, bodies at 60.0 s, each answered with 400 |
| ev:ev-mv1idq7i-019ac792 | `.eccode/drafts/sec-phb-slowloris-app.mjs`: slow-header connection on the full app after a prior deep-nesting, 413 (declared and chunked), bare-CR, duplicate Content-Length or 431 request | passed. All closed at 30.0 s |
| ev:ev-mv1i7z1w-0130a20f | `.eccode/drafts/sec-phb-supply-chain.mjs`: package.json dependencies and lifecycle scripts, lockfile, `npm view` of @playwright/test, playwright and playwright-core 1.56.1 | passed. No runtime dependencies, exact pins all the way down, no install scripts, no lockfile |

What the multi-part runs cover:
- **HTTP probe (ev:ev-mv1idwc0-01c3fc7c):**
  - the route list and default deny;
  - the Host allow-list (11 values, HTTP/1.0, absolute-form);
  - the request id (8 shapes, duplicates, bare CR);
  - security headers on 200/404/405/400/500/421/static responses, and the CORS preflight;
  - the error envelope and DB_BUSY;
  - the body cap: declared and chunked, exactly 65,536 bytes, invalid UTF-8, 415, 422, `__proto__`, duplicate Content-Length, 20,000-deep nesting;
  - 21 static traversal shapes;
  - log-line integrity and server timeouts.
- **Config-db probe (ev:ev-mv1i7xgl-01c089fa):**
  - placeholder and length rules, and Secret redaction (12 renderings);
  - base-URL allow-lists (42 cases) and config guards (19 cases);
  - the log allow-list;
  - triggers, including the REPLACE bypass with its recursive_triggers control, and partial UNIQUE indexes;
  - `db.tx`, the migration checksum and file modes.
- **Domain-scripts probe (ev:ev-mv1i9u6p-0136e358), seed checks:** passwords, file modes, no plaintext in the database, re-run, shared password, placeholder.

**Memory:** searches for "secrets", "header", "sqlite" and "traversal" (project, and "secret" with `--scope all`) returned no records, so nothing was assessed or relied on.

## Findings

### major

**SEC-B-1: `PLANNER_LIMIT` is reachable with API-shaped input. A request that one supplier can fill is refused, and each refusal holds the event loop for about 0.15–0.3 s.**
- **Where:** `src/domain/planner.js`:
  - `MAX_SEARCH_NODES` is at line 27;
  - the node counter and throw are at lines 277–278 and 319–320;
  - `plan()` at lines 462–505 runs up to 1 + survivors + 3 searches, each with its own 2,000,000-node budget.
- **Path:**
  1. The catalog keeps its seeded shape: 5 bundles of 100 or 200 cups+lids, one per supplier. No route creates offers.
  2. Each supplier sets `onHand` to 100 through `PATCH /api/supplier/inventory`. This is a normal supplier action; the spec puts no upper bound on it.
  3. A customer confirms 10,000 cups + 10,000 lids (the range is 1–100,000), a budget of USD 100,000 (the range is 1–1,000,000), no deadline and maxPickups 5 (the range is 1–5).
  4. `plan()` explores multiplicity vectors up to 101^5 and throws `PlannerLimitError`, returning no plan. Supplier A alone covers the need: the same input with maxPickups 1 returns `A` for 301,000 cents in 0.1 ms.
- **Sweep result:**
  - PLANNER_LIMIT first appears at availability 30 per supplier when C is confirmed compatible (5,000 cups), and at 100 with the default compatibility.
  - At availability ≥ 500, about 164 of 540 inputs refuse.
  - The worst single call took 237.8 ms in the recorded run, and 301 ms in an earlier run.
- **Impact:**
  - **Correctness/availability:** ordinary demo actions (a supplier restocks, a customer asks for a few thousand cups) lead to "no plan" for a request that can be filled. The submission's note 6 calls the cap "unreachable for RS-FIX-1 and the NFR5 generator". That holds only at `on_hand = 1`.
  - **Denial of service:** `POST /api/requests/:id/plan` (spec line 347) runs the planner synchronously, and only the general limit of 300 requests per minute per user applies. One customer can therefore keep a single process's event loop busy about 45–90 s per minute (300 × 0.15–0.3 s), and self-registered accounts multiply that.
  - The cap does bound each call. I measured 2 M nodes ≈ 100 ms, so the theoretical worst case is about 0.9 s with 5 survivors. The cap does its own job, but the search below it is exponential in stock levels a supplier can legitimately set.
- **Evidence:** ev:ev-mv1i9q9c-01ca3c24 (reproduction, exit 1) and ev:ev-mv1i9u6p-0136e358 (random sweep).
- **Resolution:**
  1. Make the planner exact and fast on the API-reachable envelope:
     - the envelope is ≤ 5 offers, availability up to at least 100,000, quantities ≤ 100,000, maxPickups ≤ 5, any budget or deadline;
     - for example, enumerate supplier subsets (≤ 2^5) and solve each subset's minimum-cost cover by bounded DP over bundles, instead of a DFS over every multiplicity;
     - extend the oracle property test to that envelope, and add a timing test that asserts < 50 ms per call;
     - `sec-phb-planner-sweep.mjs` must then exit 0.
  2. Or the spec and API cap `onHand` and the quantities to an envelope proven safe by a test, and c2 maps `PLANNER_LIMIT` to a typed 422 with a user-facing message.
  3. In either case, c2 adds a per-customer rate limit on `POST /api/requests/:id/plan` and on re-plan drains, for example 10 per minute.
  4. If the gate approves before this is done, record it as a risk owned by backend-engineer and due before c2 dispatch.

### minor

**SEC-B-2: The append-only triggers on `audit_events` and `inventory_ledger` can be bypassed with `INSERT OR REPLACE` / `REPLACE INTO`.**
- **Where:** `src/db/migrations/001_core.sql` lines 54–55 and 61–62 (BEFORE UPDATE/DELETE triggers), and `src/db/connection.js` lines 29–32 (the PRAGMAs; `recursive_triggers` is left at its default, OFF).
- **Path:**
  - SQLite runs DELETE triggers for rows removed by REPLACE conflict resolution only when `recursive_triggers` is ON.
  - So `INSERT OR REPLACE INTO audit_events (id, …) VALUES (<existing id>, …)` silently rewrites an audit row. The same statement rewrites a ledger row's `delta_on_hand` from 1 to 500.
  - UPDATE, DELETE and `ON CONFLICT DO UPDATE` are refused as intended.
  - No phase B code issues REPLACE, so this is a defence-in-depth gap: one careless idempotent-insert statement in c/d/e code would break RS-38's append-only guarantee without any error.
- **Evidence:** ev:ev-mv1i7xgl-01c089fa printed:
  - `REPRO INSERT OR REPLACE rewrites an existing audit_events row … action now "REWRITTEN"`;
  - `REPRO plain REPLACE INTO also rewrites the audit row`;
  - `REPRO … inventory_ledger … delta_on_hand now 500`.
  
  Control in the same run: with `PRAGMA recursive_triggers = ON`, both rewrites are refused by the existing triggers, and plain appends still work.
- **Resolution:** add `db.exec('PRAGMA recursive_triggers = ON')` in `openDb`. This needs no migration change, so the spec's verbatim DDL stays intact. Add a REPLACE case per table to `test/unit/db/triggers.test.js`.

**SEC-B-3: A 40 kB deeply nested JSON body passes `readJsonObject` and makes `canonicalJson` throw RangeError, which becomes 500 INTERNAL.**
- **Where:** `src/http/body.js` lines 84–99 (no depth limit) and lines 110–119 (`canonicalJson` is recursive).
- **Path:**
  1. Send `{"a":[[[…]]]}` with 20,000 levels (40,006 bytes, under the 65,536-byte cap).
  2. `JSON.parse` accepts it.
  3. `canonicalJson`, which the spec uses for the reserve idempotency fingerprint, overflows the stack.
  4. The client gets 500 INTERNAL instead of a 4xx. The process survives and keeps answering.
- **Evidence:** ev:ev-mv1idwc0-01c3fc7c, section H. Its expectations pass: "canonicalJson … throws RangeError on a 40 kB nested body that readJsonObject accepted", and the server still answers afterwards.
- **Resolution:** reject bodies nested deeper than a small limit (for example 32) in `readJsonBody` with 400 `INVALID_JSON` or 422 `VALIDATION_FAILED`, and test it. Alternatively, make `canonicalJson` iterative with the same limit.

### info

- **SEC-B-4: slow connections (`src/http/server.js` lines 14–37).**
  - **Effective timeouts:** Node enforces `headersTimeout` and `requestTimeout` only on each `connectionsCheckingInterval` tick (default 30 s). On fresh servers a slow-header connection closed at 30.0 s and a slow body at 60.0 s, not at the configured 10 s and 30 s (ev:ev-mv1ibkqk-015a9f85, ev:ev-mv1idq7i-019ac792).
  - **Unexplained case:** after the long probe sequence, a header connection dripping one line per second was still open at 50 s (ev:ev-mv1hsot4-01da707f; the same happened in an unrecorded rerun). Fresh servers did not reproduce it after any single prior request kind I tried, so the cause is not isolated.
  - **No connection cap:** `maxConnections` is unset.
  - **Status code:** the `clientError` handler answers timeouts with `400 Bad Request` instead of 408.
  - **Suggestion:**
    - pass `connectionsCheckingInterval: 1000` to `createServer`;
    - set a `maxConnections` such as 512;
    - map `ERR_HTTP_REQUEST_TIMEOUT` to 408;
    - re-run `sec-phb-http.mjs --slowloris`.

    The README's reverse-proxy deployment also mitigates this.
- **SEC-B-5: pre-existing `data/` directories are not tightened (`src/main.js` lines 15–35).** A `data/` created earlier with 0755 stays 0755. The database files are still 0600 because of `umask 077` (ev:ev-mv1i7xgl-01c089fa, section G). The README's "Files are created owner-only (directories 0700 …)" is true only for directories the app creates. Suggestion: `chmodSync(dir, 0o700)` when the directory is owned by the current user, or a startup warning. The README's backup line (`VACUUM INTO 'backup.db'`) should say `umask 077` first.
- **SEC-B-6: supply chain (ev:ev-mv1i7z1w-0130a20f).**
  - There are no runtime dependencies, and the single devDependency is pinned exactly (`@playwright/test` 1.56.1 → `playwright` 1.56.1 → `playwright-core` 1.56.1, optional `fsevents` 2.3.2).
  - There are no install scripts, neither ours nor the published packages'.
  - No `package-lock.json` is committed, so `npm install` (including `clean-checkout.sh`) resolves without integrity hashes. Committing the lockfile would pin integrity.
- **SEC-B-7: password parameters.**
  - `scrypt$16384$8$1` follows the spec (spec line 109), but N=2^14 is below current OWASP guidance (2^17).
  - `RS_ADMIN_PASSWORD` accepts 16 spaces or 16 × "a", because only the length is checked (ev:ev-mv1i7xgl-01c089fa, info line).
  - Both are acceptable for a demo with 96-bit generated demo passwords. Raising N is a one-constant change in `scripts/seed.js` line 32, which c1's verifier must then match (submission note 3).
- **SEC-B-8: free text in the customer message (`src/domain/explain.js` lines 1–3 and 138–141).** The header says "nothing is free text", but `SUPPLIER_REFUSED` embeds the supplier's refusal text (≤ 300 chars), and `supplierLabel` uses `supplierName`. RS-17 requires showing the refusal reason, so this is not a defect. The comment should say so, and the UI must render the text with `textContent` (T11). Planner explanations carry no catalog text: three variants with injection strings in `productName` and `supplierName` produced none (ev:ev-mv1i9u6p-0136e358, section B).
- **SEC-B-9: client IP for c1's rate limits (`src/app.js` lines 53–62).** With `RS_TRUST_PROXY=1` the client IP is the last `X-Forwarded-For` entry, unvalidated and up to the 16 KiB header limit. That is the correct entry for a single proxy. c1 should validate it with `net.isIP` (falling back to the socket address) before using it as a throttle key.

## Checked and found sound (no finding)

- **Secrets (ev:ev-mv1i7xgl-01c089fa, ev:ev-mv1i9u6p-0136e358):**
  - the Secret wrapper (12 renderings, frozen, `reveal()` cannot be replaced);
  - placeholder refusal for 22 variables × 4 shapes;
  - the admin (16), demo (12) and HMAC (32 bytes) length rules;
  - ConfigError never echoes a value, also for non-secret variables;
  - `/api/config` carries labels and provider names only;
  - every secret line in `.env.example` is a commented-out `<placeholder>`;
  - `.gitignore` covers `data/`, `.env` and `.env.*` (except the example);
  - seed passwords are 16-char base64url (96 bits), printed once, never logged, and absent from the database files;
  - the shared `RS_DEMO_PASSWORD` is never printed;
  - a placeholder `RS_DEMO_PASSWORD` makes the seed refuse and name the variable only.
- **Log:**
  - keys outside the allow-list, Secret objects, arrays and functions are dropped;
  - C0/C1/U+2028 control characters are stripped and strings truncated at 120;
  - every event is one JSON line;
  - the raw path and inbound headers never reach a line.

  The extra `port` key is harmless.
- **HTTP (ev:ev-mv1idwc0-01c3fc7c):**
  - **Host check:** 421 with the full header set.
  - **Request id:** the pattern is enforced; invalid or duplicate ids are replaced; a bare CR cannot inject a header.
  - **Body:**
    - 413 for oversized bodies, declared and chunked;
    - 400 for malformed JSON, invalid UTF-8 and duplicate Content-Length;
    - 415 for a non-JSON type, and 422 for a non-object body;
    - no prototype pollution.
  - **Routing:** 405 with `Allow`. The only registered routes are the public health and config routes, and all five non-public policies answer 401 without an authorize hook.
  - **Static handler:** realpath confinement, dotfiles and symlinks out are refused, it serves GET/HEAD only, and the target is limited to 2,048 characters. `//` is answered 400.
  - **Responses:**
    - `approvalPageCsp` builds the exact spec string;
    - no CORS header is sent;
    - the 500 body is the catalog text only;
    - a domain AppError with an unknown code becomes 500 INTERNAL.
- **Database (ev:ev-mv1i7xgl-01c089fa, ev:ev-mv1idwc0-01c3fc7c):**
  - WAL, `foreign_keys` and `busy_timeout` are set, and the only interpolated SQL is the validated integer `busy_timeout`;
  - UPDATE, DELETE and UPSERT-update on both append-only tables are refused;
  - the partial UNIQUE `offers_one_current` and `price_cents >= 0` hold;
  - a migration changed by a single comment refuses startup;
  - `db.tx` rolls back the synchronous part of a promise-returning function;
  - SQLITE_BUSY becomes 503 with `Retry-After: 1`.
- **Config allow-lists (ev:ev-mv1i7xgl-01c089fa):**
  - PayPal and Anthropic refuse suffix, userinfo, path, case, port, scheme, live-host, IPv6 and 127.0.0.2 variants, and accept loopback only with `RS_TEST_OFFLINE=1`;
  - `RS_REGISTER_PER_IP_PER_HOUR` above 5 is refused outside test mode;
  - the lease must be ≥ 3× the PayPal timeout;
  - `RS_TEST_HOOKS` is refused with the Sandbox adapter;
  - `RS_FAKE_APPROVAL_HOST` must be 127.0.0.1 outside test mode;
  - `RS_PUBLIC_URL` must be origin-only;
  - `RS_TEST_OFFLINE=1` forces the fake extraction provider.
- **Scripts:**
  - `check-node.cjs` compares the version correctly and is silent on a supported Node (ev:ev-mv1i9u6p-0136e358).
  - `clean-checkout.sh` (read, not run):
    - executes nothing from untrusted input;
    - unsets `RS_*` by name without printing values;
    - excludes `.eccode/`, `data/` and `node_modules/`;
    - kills the server's process group, and removes its 0700 mktemp directory on exit;
    - deliberately does not run the seed.

## Not yet checked

- Concurrent multi-process migrate (the technical reviewer has `tr-phb-migrate-race.mjs`; I rely on its result).
- The test helpers (`net-guard`, `server-proc`, `app-harness`) beyond reading `net-guard.js`. These are test-only; `dgram` is not covered by the guard.
- Byte-identity of migrations 001–005 with the spec blocks. I rely on b1's ev:ev-mv1g5zww-0182816a and have not re-run it.
- The root cause of the 50 s slow-header observation (SEC-B-4).

## Guard refusals during this review

- **Backquote in a pattern:** a `grep` whose pattern contained a backquote was refused ("runs a command through a variable or substitution"). I used the Grep tool instead.
- **Command substitution:** a check that used `$(printf …)` was refused for the same reason. I re-ran the probe without it.
- **`$` in a grep pattern:** a grep pattern ending in `$` (`PASSED$`) was refused for the same reason. I changed the pattern.
- **Parallel bisection:** a background loop that ran the HTTP probe per section in parallel and redirected each output to the scratchpad was refused ("security-reviewer … does not edit project files"). It was not re-attempted; SEC-B-4's cause stays not isolated.
- **No Edit tool:** the Edit tool is not available in this session, so I rewrote my own draft files in full with Write.
