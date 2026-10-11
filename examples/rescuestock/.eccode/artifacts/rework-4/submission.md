# phase:rework-4: submission

Author: delivery-lead. Gate: `phase:rework-4`. Date: 2026-10-11.

## Why this rework exists

- **Opened by:** the orchestrator, after the user raised `limits.maxReworks` to 4 and `limits.maxRuntimeMinutes` to 2400.
  - The user made both changes in commits `d5e3695` and `1efcab5` (GitHub web editor).
  - Decision `dec-mv3sg8cv-0146d001` records them. The rework was opened at event #882.
- **Findings covered:**
  - **FU-23 / TR-D-3.** Raised by the phase D technical review `rev-mv33xoyz-0143dd56`. The security draft `phase-d-security-1.md` widened it in section F (probe ev:ev-mv33e5qp-017ba56b, decision `dec-mv330std-0165d9be`).
  - **SEC-R-1** (minor). Raised by the rework-1 security review `.eccode/reviews/drafts/rework-1-1.json`. Decision `dec-mv39rg82-01a682bc` added it to this rework.
- **Task:** one task, `rework-4` (backend-engineer), done in two claims:

| Claim | Run | Base commit | Handoff | What it delivered |
|---|---|---|---|---|
| 1 | `run-mv3sg9va-01216cd5` | `46046ed` | `ho-mv3swih9-01bb4f5b` | migration 006; `model_spend` foreign key `ON DELETE SET NULL`; RS-39 id-reuse tests; migrate-006 test; version-6 updates to two db tests; the limiter's fail-open for GET/HEAD |
| 2 | `run-mv3sxdwo-01014097` | `507da7e` | `ho-mv3t23oc-01dfb735` | the access hook passes method, log and requestId to the limiter (SEC-R-1 goes live); the hook test is no longer todo; the gate test fixture for the new foreign key |

- **Ownership as recorded:** `src/db/migrations/**`, `test/unit/db/**`, `test/api/id-reuse.test.js`, `src/auth/general-limit.js`, `test/unit/auth/**`. The extension added `src/auth/rbac.js` and `test/unit/ai/gate.test.js` (see "Scope extension").

## Scope extension (between the two claims)

- **Why:** claim 1 found two edits it needed outside its files. Its handoff lists them under remainingIssues:
  1. **`src/auth/rbac.js` line 64 was not wired.** It still called `limiter.take(ctx.user.id)` with no method. The limiter treats a call that names no method as state-changing, so SEC-R-1 had no effect in the app. This was not a regression: the app behaved exactly as before.
  2. **`test/unit/ai/gate.test.js` (line 102) turned red.** Its NFR6 reserve-before-call test calls `gate.run` with `requestId: 7`, but no rescue request 7 exists. The new `model_spend.request_id` foreign key refuses that insert.
- **What the orchestrator did:**
  - `task reset rework-4` (event #903);
  - `rework extend rework-4 --files src/auth/rbac.js test/unit/ai/gate.test.js` (event #904). Both files had been owned only by approved tasks (c1, d1).
- **Claim 2 then made:**
  - the one-line rbac change;
  - removed the `todo` option of the hook test;
  - added a two-line fixture insert of rescue request 7 for the test's customer. No assertion of `gate.test.js` changed (`git diff 46046ed -- test/unit/ai/gate.test.js`: +2/-0).

## Disclosure: `filesChanged` of the second claim

- **The engine refused the first version of the second handoff.** That version listed all nine files, but six of them had been committed by the orchestrator's snapshot commit `507da7e`. That commit is the second claim's base, so git shows those six files as unchanged since the claim.
- **Effect on the record:**
  - `filesChanged` of `ho-mv3t23oc-01dfb735` names only that claim's three files: `src/auth/rbac.js`, `test/unit/auth/general-limit-busy.test.js` and `test/unit/ai/gate.test.js`.
  - Its `completedWork` names all nine.
  - The first claim's handoff `ho-mv3swih9-01bb4f5b` declares the other six. `general-limit-busy.test.js` appears in both claims.
- **Combined declared set:** the nine files below. Every one is an artifact of this submission.
- **Git cross-check:** `git diff --stat 46046ed` over the rework's ownership shows exactly these nine files, +660/-24.

| File | Claim | Change |
|---|---|---|
| `src/db/migrations/006_autoincrement_ids.sql` | 1 | new, 114 lines |
| `src/auth/general-limit.js` | 1 | +43/-5 |
| `src/auth/rbac.js` | 2 | 1 line |
| `test/api/id-reuse.test.js` | 1 | new |
| `test/unit/auth/general-limit-busy.test.js` | 1, 2 | new (claim 1); todo removed (claim 2) |
| `test/unit/db/migrate-006.test.js` | 1 | new |
| `test/unit/db/migrate.test.js` | 1 | updated for version 6 (the extra test migrations now use 007) |
| `test/unit/db/open-race.test.js` | 1 | expects `[1..6]` |
| `test/unit/ai/gate.test.js` | 2 | +2 lines (fixture row) |

## Delivery-lead runs on the current tree

| Evidence | Command | Result |
|---|---|---|
| **ev:ev-mv3t3hzo-014c57e6** | the green set from `ho-mv3t23oc-01dfb735`, verbatim (id-reuse, migrate-006, migrate, triggers, open-race, connection, general-limit-busy, general-limit, rbac, gate) | **passed: 120 tests, 120 pass, 0 fail, 0 skipped, 0 todo**. Same count as the engineer's ev:ev-mv3sy1ir-013d720a. |
| **ev:ev-mv3t54i6-01a9b844** | `npm test` | **failed (exit 1): 2017 tests, 2000 pass, 2 fail, 15 skipped, 0 todo**; 69.4 s. Neither failure is in a rework-4 file (see below). |
| **ev:ev-mv3t65gk-01e2adc7** | `npm run test:browser` | **passed: 8/8** |
| **ev:ev-mv3t6bo7-015fdd78** | `test/api/uploads-retention.test.js` alone | **passed: 41/41** (the timer test that was red in the full run is green here) |

- **Why the `npm test` count differs from the engineer's run.** The engineer's run (ev:ev-mv3szcve-01bf3db5) had 1985 tests. This one has 2017. The 32 extra tests come from e4's test files, which were built in parallel: `test/api/execute.test.js` and `test/api/lost-response.test.js` are now committed, and `test/api/authorization-pending.test.js` is untracked. None of e4's test files failed.
- **The two failures in ev:ev-mv3t54i6-01a9b844:**
  1. **`test/api/contracts.test.js` "NFR6: every registered route has a scenario in the table".** This is the known red row and belongs to e6. Three routes have no contract scenario: `GET /api/paypal/return`, `GET /api/paypal/cancel` and `POST /api/webhooks/paypal/:merchantKey`. Both of the engineer's full runs show the same row.
  2. **`test/api/uploads-retention.test.js` "RS-39: startApp removes an expired image at startup and another one on the next tick (RS_RETENTION_INTERVAL_MS)"** (line 711, `existsSync(second file) === false` got `true`).
     - **History:** this is the timer flake that the second handoff reported once, unrecorded, while e4 was editing `src/main.js`. It has now **recurred in a recorded run**. It passed alone right afterwards (ev:ev-mv3t6bo7-015fdd78).
     - **Attribution: e4, through `src/main.js`.** e4's in-progress `src/main.js` (in e4's ownership, committed in snapshot `a8a0fff`) now starts the reconciler inside `startApp`. That adds startup work to the process this test drives.
     - **Mechanism.** The test polls until the image **row** is gone, then asserts at once that the **file** is gone. `sweepExpiredImages` (`src/services/retention.js`) deletes the row first and then awaits `unlinkQuiet`. Under load the test can observe the gap between the two.
     - **Not a rework-4 effect.** The test fails on the file assertion. Rework-4 changed none of `src/main.js`, `src/services/retention.js` or `test/api/uploads-retention.test.js`.
     - **Routing:** I report it to the orchestrator for e4 (or the test's owner) so the test waits for the file as well as the row.

## Finding → change → tests → evidence

| Finding (resolution condition) | Change | Tests | Evidence |
|---|---|---|---|
| **FU-23 / TR-D-3**<br>Condition: `rescue_requests`, `plan_versions`, `images` and `planning_runs` use INTEGER PRIMARY KEY without AUTOINCREMENT. After a hard delete of the highest id, the next row reuses that id, so audit rows or a `model_spend` row point at another customer's request. Migration 006 rebuilds those tables with AUTOINCREMENT (app-only, data preserved). `model_spend.request_id` gets a foreign key or check. An RS-39 test shows that no id is reused. | `src/db/migrations/006_autoincrement_ids.sql`:<br>- rebuilds the four tables with `INTEGER PRIMARY KEY AUTOINCREMENT`;<br>- recreates indexes and triggers byte for byte;<br>- rebuilds `model_spend` with `request_id INTEGER REFERENCES rescue_requests(id) ON DELETE SET NULL`.<br>**Choice of SET NULL** (engineer's rationale):<br>- the row belongs to the budget ledger (`gate.js` sums every row of the day), so it must outlive a hard delete of its request;<br>- SET NULL drops only the pointer, so the row can never name another request;<br>- an insert naming a nonexistent request is refused;<br>- a CHECK cannot look at another table;<br>- a tombstone reference would add a second source of truth.<br>Existing rows that point at an already deleted request are copied with NULL. | **`test/api/id-reuse.test.js`**, three RS-39 cases. X creates a request with an image, extraction, plan version and approval, then hard-deletes it. Then:<br>- Y's request, plan version, planning run and image ids are all larger than X's;<br>- the admin timeline of Y's request lists none of X's audit events;<br>- X's `model_spend` row survives with `request_id` NULL.<br>**`test/unit/db/migrate-006.test.js`** migrates a seeded 005 database and checks:<br>- every row is equal;<br>- every index, trigger and table text is identical except the keyword and the FK;<br>- foreign-key lists are equal;<br>- `sqlite_sequence` = max ids;<br>- `foreign_key_check` is empty and `integrity_check` is ok;<br>- the append-only triggers still fire and `INSERT OR REPLACE` is still refused;<br>- next ids after deleting the highest are 8/71/7001/34;<br>- SET NULL works and an unknown request is refused;<br>- a failing statement rolls back atomically;<br>- a lost plan version rolls back through the deferred FK;<br>- the upgraded schema equals the fresh schema.<br>**Also updated:** `migrate.test.js`, `open-race.test.js` (version 6); `gate.test.js` (fixture row). | **Failing first:** ev:ev-mv3skw6z-010f1667 (id-reuse 3/3 red on 001–005).<br>**Mutants (red):** plan_versions without AUTOINCREMENT ev:ev-mv3sqzbe-01dfb4d9; FK without ON DELETE SET NULL ev:ev-mv3sr3lx-01b2631c.<br>**Engineer green:** ev:ev-mv3svgxu-01111cf2 (claim 1), ev:ev-mv3sy1ir-013d720a (120/120).<br>**Mine:** ev:ev-mv3t3hzo-014c57e6 (120/120), ev:ev-mv3t54i6-01a9b844 (all RS-39 id-reuse and migrate-006 tests pass). |
| **SEC-R-1** (minor)<br>Condition: `src/auth/general-limit.js` takes the write lock on every signed-in call. GET and HEAD fail open on a busy error: the request proceeds uncounted and the event is logged. Covered by a lock-holder test. | **`src/auth/general-limit.js`** has a new signature, `take(userId, { method, log, requestId })`:<br>- **GET/HEAD:** the counting transaction waits only `readBusyWaitMs` (default 50 ms, bounded 0–5000), and the connection's busy timeout is restored afterwards. On a busy error the call proceeds uncounted and logs one `rate_limit.busy_open` warn line carrying only the request id (no user id or name).<br>- **Every other method, and a call with no method:** the busy error is rethrown unchanged (503 `DB_BUSY`, Retry-After 1).<br>- **Unchanged:** over-limit is still 429, and a non-busy error is not swallowed.<br>**`src/auth/rbac.js` line 64:** `limiter.take(ctx.user.id, { method: req.method, log: ctx.log, requestId: ctx.requestId })`. | **`test/unit/auth/general-limit-busy.test.js`.** A second OS process holds the write lock (`test/helpers/lock-proc.js`):<br>- GET and HEAD proceed well under the 1000 ms test busy timeout, uncounted, with one log line, and the timeout is restored;<br>- POST, PATCH, PUT, DELETE and a call with no method fail closed, uncounted and unlogged;<br>- over-limit GET is still 429;<br>- a non-busy error propagates;<br>- a db object without pragma access still fails open;<br>- **hook test:** `authorize()` passes method, logger and requestId (was todo in claim 1; live in claim 2). | **Failing first:** ev:ev-mv3sq19p-013611a4 (3 red on the old limiter); ev:ev-mv3sxp4l-014d613f (hook test without todo, rbac not wired: 1 red).<br>**Mutants (red):** fail-open for every method ev:ev-mv3sqk3u-01ebc8a9 (6 red); reads wait the full busy timeout ev:ev-mv3sqqfy-01b5cfb8 (1 red).<br>**Engineer green:** ev:ev-mv3sqtv3-011b46ac, ev:ev-mv3sy1ir-013d720a.<br>**Mine:** ev:ev-mv3t3hzo-014c57e6; ev:ev-mv3t54i6-01a9b844 (all 11 `SEC-R-1` tests pass, and every `SEC-C-3` result is still ok (16 ok lines, 0 not ok), including the 301st-call refusal with p95 < 300 ms). |

### Engineer's full-suite runs (for reference)

| Claim | `npm test` | `npm run test:browser` |
|---|---|---|
| 1 | ev:ev-mv3st8eq-01f35767: 1985 tests, 1967 pass, 2 fail. The two failures are e6's route-table row and `gate.test.js`, which claim 2 then fixed. | ev:ev-mv3sv80u-010f89cb: 8/8 |
| 2 | ev:ev-mv3szcve-01bf3db5: 1985 tests, 1969 pass, 1 fail (e6's row), 15 skipped | ev:ev-mv3szjv3-01155216: 8/8 |

One more engineer run is not cited in the handoffs: **ev:ev-mv3src2v-013e9d1c**, a green attempt in claim 1 that failed. It comes before the claim's final green ev:ev-mv3svgxu-01111cf2. I mention it so the record is complete.

## Migration 006: safety argument (from the engineer's handoff, checked against the SQL)

1. **One transaction, all or nothing.**
   - The runner (`src/db/migrate.js`) applies the file inside one `BEGIN IMMEDIATE` with `foreign_keys = ON`, which cannot be switched off inside a transaction.
   - The file therefore sets `PRAGMA defer_foreign_keys = ON` (line 27), so foreign keys are checked at COMMIT.
   - If any statement fails, everything rolls back. migrate-006 tests this.
2. **Cascades are neutralised by staging.**
   - `DROP TABLE` runs an implicit DELETE, which fires `ON DELETE CASCADE`.
   - So the file first copies nine tables into TEMP tables: `rescue_requests`, `images`, `extractions`, `requirements`, `planning_runs`, `plan_versions`, `plan_approvals`, `replan_queue`, `model_spend`.
   - It then drops and recreates five of them, and puts the rows back with their original ids. That covers the cascading children `extractions`, `requirements`, `replan_queue` and `plan_approvals`.
3. **Non-cascading children are not touched.**
   - These are `reservations`, `supplier_orders`, `payment_operations` and `provider_calls`.
   - Their deferred foreign keys are satisfied again when the parent ids are re-inserted.
   - If a parent does not come back, the COMMIT fails on the deferred FK and everything rolls back. migrate-006 tests this with a lost plan version.
4. **No RENAME.** Tables are recreated under their own names, so SQLite never rewrites references in other tables.
5. **Audit protection is untouched.** The SEC-B-2 append-only triggers live on `audit_events` and `inventory_ledger`, which this migration does not touch. The test shows they still fire and still refuse `INSERT OR REPLACE`.
6. **Sequence state.** Re-inserting the rows with explicit ids sets `sqlite_sequence` to each table's max id. From then on a deleted highest id is never handed out again.
7. **App-only.** The migration changes nothing outside the application database. The PB-1 open race (`open-race.test.js`) still applies each migration exactly once across concurrent processes, now `[1..6]`.

## Remaining issues (not fixed by this rework)

1. **SEC-R-2 and SEC-R-3 are untouched and still open.** Both come from the same review, `rework-1-1.json`, and both are severity info:
   - SEC-R-2: a non-public `/api` request with `Sec-Fetch-Mode: navigate` is not refused before identification, so cross-site top-level navigations can spend a victim's general budget.
   - SEC-R-3: sign-out is counted by the general limit.
2. **`extractions` and `requirements` keep `INTEGER PRIMARY KEY` without AUTOINCREMENT.** Their ids can still be reused after a hard delete.
   - The engineer's reason: audit entity ids do not reference them.
   - The condition named only the four tables, so this meets it. The reviewer or orchestrator may still want them covered.
3. **Ids reused before 006 cannot be repaired.**
   - Each rebuilt table's sequence starts at its current max id, so reuse stops from now on.
   - A pair of records that already collided on an existing database stays as it is.
4. **Write lock during the migration.**
   - The migration rewrites four tables and stages nine in TEMP tables inside one `BEGIN IMMEDIATE`, and holds the write lock for the whole copy.
   - That is fine at demo size. On a very large database, every writer (and, through the limiter, every non-GET signed-in call) would wait or get 503 `DB_BUSY` until it finishes.
   - Mitigation for an operator: run the upgrade at startup before traffic. The migration runs in `startApp` before `listen`.
5. **The uploads-retention timer test (e4 / test owner).** It recurred once in a recorded run: ev:ev-mv3t54i6-01a9b844, and green alone in ev:ev-mv3t6bo7-015fdd78. See above. It is not caused by this rework, and I route it to the orchestrator.
6. **e6's route-table row.** It stays red until e6 adds the three contract scenarios.

## Artifact coverage

- **Artifacts submitted:** this file plus the nine files in the table above.
- **Check after submitting:** `.eccode/drafts/phase-artifacts-check.mjs` compares the artifacts with the rework's recorded ownership, both handoffs' `filesChanged`, and git changes since the first claim's base `46046ed`. The result is in my report to the orchestrator.

## Lessons

`mem-sd-mv1audrd-013b7102` (tool-call guard root resolution) is recorded as not-applicable by the engineer in both handoffs. Reason: this task contains no hook, guard or root discovery.
