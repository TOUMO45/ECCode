# Security review: phase:rework-1 (sub-mv2zoxlo-019effce), version 1

Reviewer: security-reviewer. Run: run-mv2zpsfm-019ad5c6. Recording reviewer: technical-reviewer (I record no gate decision).
Scope:
- SEC-C-2 and SEC-C-3 from `phase-c-security-1.md`;
- the six items the delivery lead flagged in `.eccode/artifacts/rework-1/submission.md`;
- a search for regressions introduced by the general limit.

All checks were recorded with `--actor security-reviewer --gate phase:rework-1`. No project file was changed.

## Verdict

**I would not block. SEC-C-2 and SEC-C-3 are resolved; their resolution conditions are met and I re-ran my probes.**

The general limit adds two small regressions. Neither needs a rework before approval:
- **SEC-R-1 (minor):** authenticated reads now take the write lock, so a long write lock turns them into 503.
- **SEC-R-2 (info):** a cross-site page can spend a signed-in victim's budget with top-level navigations, but only if the victim's browser lets it open many popups.

There are also two info notes: SEC-R-3 (sign-out is counted) and SEC-R-4 (edge cases in the /64 key).

## Evidence

| ev id | what | result |
|---|---|---|
| ev:ev-mv2zvfkl-01bb9b32 | `npm test` on the rework tree | passed: 821 tests, 805 pass, 0 fail, 10 skipped, 6 todo; p95 61.8 ms over 2,578 calls |
| ev:ev-mv2zuhm9-0195be55 | `.eccode/drafts/sec-rw1-probe.mjs R1 R2 R3` | passed, every expectation met (the R3 REPRO included) |
| ev:ev-mv2zun9k-01058b91 | `.eccode/drafts/sec-rw1-xsite.mjs` (Chromium) | passed (= SEC-R-2 reproduced) |

## Resolution conditions

**SEC-C-2: met.** `throttleKey()` is in `src/auth/client-ip.js` lines 51–63, and `clientIp` uses it for both the socket address and the trusted hop. Results in ev:ev-mv2zuhm9-0195be55, section R1:
- **Key mapping:** 12 spellings map correctly:
  - full, upper-case, zero-padded, bracketed and zone forms of one /64 → `2001:db8:1:1::/64`;
  - a neighbouring /64 gets a different key;
  - `::ffff:203.0.113.51`, `::FFFF:…`, `::ffff:cb00:7133` and `0:0:0:0:0:ffff:cb00:7133` → `203.0.113.51`;
  - junk → null.
- **Pair limit:** 5 failures over 5 addresses of one /64, then the correct password from a 6th address in the same /64: 429 `signin_pair`.
- **Separation:** another /64 and an IPv4 client keep separate budgets (200, 200).
- **Mapped IPv4:** the dotted and hex mapped forms share the plain IPv4 budget (6th attempt 429).
- **Per-IP limit:** 21 attempts over 21 addresses of one /64 and 21 usernames: the 21st gets 429 `signin_ip`.

**SEC-C-3: met.**
- **Where it lives:** `src/auth/general-limit.js`, called in `createAccess` (`src/auth/rbac.js`) after the 401 check. It keys on `u:<id>`, uses kind `general`, and does delete, count and insert in one `db.tx`. A refused call is not inserted.
- **Flood (R2):**
  - calls 1–300 in one frozen minute pass; the 301st gets 429 `RATE_LIMITED`, `details.limit: "general"`, `Retry-After: 60`;
  - 50 more refused calls leave the row count at 300;
  - after the window the user is served again, and that user's expired rows are deleted;
  - another user is unaffected.
- **Planning keys are unaffected:**
  - the `plan:u:` count stayed the same across 350 general calls;
  - with the general limit raised to 1000, the 11th planning call still gets 429 `limit: plan`.
- **Unchanged confirm (`src/services/requests.js` lines 217–225):**
  - 300 identical confirms returned the same version every time and wrote 0 requirements rows, 0 audit rows and 0 re-plans;
  - a real change still writes a new version, and changing back writes another (1 → 2 → 3), so there is no stale short-circuit.
- **Does the 429 leak anything? No.** The error object has exactly `code, details, message, requestId`, and `details` is `{"limit":"general"}`. There are no counts and nothing about other users.
- **Can it lock a victim out?** Only with the victim's own authenticated requests, because the key is the session user and anonymous calls are not counted. The one cross-site route to that is SEC-R-2.
- **Under `busy_timeout = 0`:** the limiter's write fails into 503 `DB_BUSY` with `Retry-After: 1`. The transaction rolls back, so the 503 is **not** counted (R3: rows 0 → 0). See SEC-R-1 for the side effect.

## Findings

### blocking / major

None.

### minor

**SEC-R-1: every authenticated request, reads included, now needs the SQLite write lock, so a held write lock turns reads into 503 `DB_BUSY`.**
- **Where:** `src/auth/general-limit.js` lines 22–32, `db.tx` = `BEGIN IMMEDIATE` on every non-public call. Before the rework, a signed-in GET only read (WAL), and the session touch explicitly tolerates busy (`src/auth/sessions.js` lines 57–63: "a busy database must not fail an otherwise valid request").
- **Path:** another process holds the write lock longer than `busy_timeout`. In production `busy_timeout` is 5 s; a reconciler or migration step, or a stuck writer, could hold it that long. Every signed-in page read and every poll then fails, instead of being served from WAL.
- **Evidence:** ev:ev-mv2zuhm9-0195be55, section R3, with `busy_timeout 0` and `test/helpers/lock-holder.js` holding the lock:
  - `GET /api/requests` → `503 DB_BUSY retry-after=1`;
  - the public `GET /api/auth/session` → 200;
  - after release, the same read → 200;
  - the 503 was not counted.
- **Impact:** availability only. Reads now also queue behind writes across processes (p95 is still 61.8 ms in the suite).
- **Resolution (recommended, about 5 lines; can go to FU-20's owner or the next `src/auth` touch):** for `GET`/`HEAD`, `take()` fails open on a busy error, with a log line, the same way `sessions.resolve` already does. Keep fail-closed for state-changing methods, which would need the lock anyway. Add a test with the lock holder.

### info

- **SEC-R-2: a cross-site page can spend a victim's general budget.**
  - **Why it works:** `rs_sid` is `SameSite=Lax`, so the browser sends it on cross-site top-level GET navigations. The limiter counts those navigations, and authenticated GETs carry no Origin check.
  - **What I showed (ev:ev-mv2zun9k-01058b91, Chromium):**
    - with the limit lowered to 20 for speed, a page on `attacker.example` opened 25 popups to `/api/requests`;
    - 20 were counted against cafe1;
    - cafe1's own `GET` and its sign-out then got `429 general` (`Retry-After: 60`);
    - after 61 s it was served again.
  - **Controls:**
    - cross-site `fetch` with `credentials: 'include'` carried no cookie and counted 0;
    - re-navigating one popup counted only once.
  - **Why only info:**
    - at the default 300/min, this needs about 300 popups a minute, which a browser's popup blocker allows only if the victim has permitted popups for the attacker's site;
    - the effect lasts one window and has no lasting state.
  - **Cheap fix:** in `authorize`, before `identify`, refuse non-public `/api` requests with `Sec-Fetch-Mode: navigate` (403, not counted). The SPA only uses `fetch`. The PayPal return and cancel routes are public, so they are unaffected.
- **SEC-R-3: sign-out is counted.** `POST /api/auth/signout` (policy `session`) is subject to the limit, so a limited user cannot sign out for up to one window (R2 observation `429`; also seen in SEC-R-2). Suggestion: exempt sign-out, which only reduces privilege, from `limiter.take`.
- **SEC-R-4: shared /64 keys at the edges of `throttleKey`.**
  - `::1`, `::` and IPv4-compatible addresses (`::203.0.113.51`) all key as `0:0:0:0::/64`.
  - NAT64 `64:ff9b::/96` keys as one /64 (R1 info line), so all NAT64 clients would share one sign-in budget.
  - It does not matter in the documented deployments: loopback, or a proxy that forwards the client's real address.
  - Optional: map `64:ff9b::/96` to its embedded IPv4.

## The six items flagged by the delivery lead

1. **No sweep of old `u:<id>` rows (FU-20):** accept.
   - The table is bounded at `limit` rows per user per window, because refused calls are not inserted (R2: 300 after 350 calls).
   - Rows of idle users stay until FU-20's housekeeping runs.
2. **Role and CSRF failures of signed-in users count:** accept. This bounds a signed-in client's probing of other roles' routes. It does not create a cross-user lever; SEC-R-2 is about navigations, not this choice.
3. **"Unchanged" compares derived provenance and wording too:** accept the engineer's reading.
   - A provenance change only follows a new extraction, which has its own limit (10 per customer per 10 min).
   - So it cannot be used for write amplification.
   - It keeps the SEC-8 provenance history exact.
4. **Three adapted assertions:** I read the diff of `test/api/requests-plans.test.js` and `test/unit/auth/client-ip.test.js`. None weakens a criterion:
   - the planning counts now filter on `plan:%`;
   - "no `u:<id>` row" became "some `u:<id>` row, distinct from planning";
   - the IPv6 expectations became /64 keys, with new same-/64 and mapped-IPv4 cases.
5. **Test names TR-C-2:** no security bearing. This is the technical reviewer's call.
6. **Webhook limit left to e3:** agree. It is the same hand-off as SEC-C-6; e3 owns the 60 per IP per minute limit and signature-first handling. The general limit correctly skips the `signature` route.

## Not checked

- Multi-process overshoot of the general limit. I relied on the `db.tx` design and the engineer's one-transaction unit test, not a two-process probe.
- p95 under concurrent load beyond the suite's NFR5 figure.
- The planning-limit env bounds (TR-C-2). That is the technical reviewer's item; it is covered by `limits.test.js` inside ev:ev-mv2zvfkl-01bb9b32.

## Guard refusals

None in this follow-up. As before, there is no Edit tool: I wrote a separate Chromium script rather than editing the main probe, which is why SEC-R-2 is a second evidence record.
