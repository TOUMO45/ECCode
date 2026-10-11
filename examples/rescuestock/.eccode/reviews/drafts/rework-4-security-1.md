# phase:rework-4: security review (FINAL)

Reviewer: security-reviewer, run run-mv3t98qd-01226fef. Gate: `phase:rework-4`. Submission: `sub-mv3t8kff-017759bd`.
Scope: FU-23 / TR-D-3 (migration 006, id reuse after a hard delete) and SEC-R-1 (limiter fail-open for GET/HEAD), plus the
`rbac.js` and `gate.test.js` changes. Handoffs `ho-mv3swih9-01bb4f5b`, `ho-mv3t23oc-01dfb735`. Original findings: my
`phase-d-security-1.md` section "FU-23 (orchestrator item)" and SEC-R-1 in `rework-1-security-1.md` / `rework-1-1.json`.
The technical-reviewer records the gate; this draft is input to its decision.

Status: FINAL.

## Verdict

- **No blocking or major finding.**
- **One new minor finding, SEC-RW4-1.** Migration 006 seeds `sqlite_sequence` from the max id of the rows that *survive*. Ids that were hard-deleted before the upgrade, above that max, are handed out again after the upgrade. Their audit rows and `model_spend` rows still name them. This is the FU-23 defect again, for every database that is upgraded rather than created fresh.
  - **Reproduced** through the real flows: ev:ev-mv3twi5f-015c7a17.
  - **Fix validated:** about 10 lines of SQL, ev:ev-mv3u2o6u-0130d038.
  - **Recommendation: fix it in this rework, before 006 is applied to any persistent database.**
    - After that, editing 006 is refused by the NFR1 checksum check.
    - A 007 could then only stop *future* reuse. It could not take back ids already handed out.
    - No persistent database exists in the project today: there is no `data/` directory and no tracked `.db` file.
  - **If the orchestrator accepts it as a residual instead,** it must be recorded as a risk that names the upgrade-time condition.
- **SEC-R-1 is resolved as specified.** Every point of the brief was confirmed with a real lock-holder process, including spoofing and self-induction attempts. The bypass the fail-open allows is bounded and cannot be triggered by a user (SEC-RW4-I3).
- **FU-23 for fresh databases and for deletes after the upgrade is resolved.** I re-ran my iteration-1 section F probe at HEAD and every expectation inverted as required.
- **Info:** five notes, SEC-RW4-I1 to SEC-RW4-I5. None of them needs to be fixed in this rework.

## Evidence (all recorded by security-reviewer on this gate, after the submission)

The nine submitted files have the same sha256 on disk as in the submission when checked after these runs (`7ad36458…`, `470ba04b…`, `2d39fe35…`, `a8e21b74…`, `47ccca2e…`, `fe426ddd…`, `c6329ccb…`, `9d8832b3…`, `b13f0042…`).

| ev id | what | result |
|---|---|---|
| ev:ev-mv3twcws-01dec919 | `sec-rw4-probe.mjs` sections F, L, R (scratchpad) | passed, 24 checks, ALL EXPECTATIONS MET |
| ev:ev-mv3twi5f-015c7a17 | `sec-rw4-m.mjs`: migration 006 on a 005 database filled through the real HTTP flows | passed, ALL EXPECTATIONS MET (both REPRO lines reproduce) |
| ev:ev-mv3u2o6u-0130d038 | `sec-rw4-fixcheck.mjs`: 006 as submitted vs 006 plus the suggested statements | passed (REPRO, and the fix holds) |
| ev:ev-mv3txdk1-017029c7 | the green set of `ho-mv3t23oc-01dfb735`, verbatim | passed: 120 tests, 120 pass, 0 fail, 0 skipped, 0 todo |
| ev:ev-mv3tzf4g-0111832e | `npm test` (the project checks) | failed (exit 1): 2062 tests, 2053 pass, 1 fail, 8 skipped. The one failure is the known uploads-retention timer test (`test/api/uploads-retention.test.js:711`, the file assertion). It is not a rework-4 file; see the submission. The e6 route-table row now passes. |
| ev:ev-mv3tzro0-016ab924 | `test/api/uploads-retention.test.js` alone | passed: 41/41 |

Superseded runs, disclosed:
- **ev:ev-mv3ttojn-011c8ff9** (failed): first run of the F/L/R probe. The single FAIL was a bug in my probe, not in the code. The "counted again after release" check compared raw row counts across a 61 s clock advance, so the limiter's own window purge made the count go 7 → 1. v2 counts rows inside the window: 0 → 1, which passes.
- **ev:ev-mv3u194t-01b4ef9b** (failed): first run of the fix check. My fixture username `x` violated the `users.username` length CHECK. Corrected to `cust-x`.

## Findings

### blocking / major

None.

### minor

**SEC-RW4-1: after the upgrade, migration 006 hands out again the ids that were hard-deleted just before it, so the FU-23 cross-customer audit mix-up reappears on every upgraded database.**

- **Where:** `src/db/migrations/006_autoincrement_ids.sql`.
  - The `INSERT … SELECT … ORDER BY id` re-inserts set `sqlite_sequence` to max(id) of the surviving rows.
  - Comment, line 20: "the best high-water mark that is known for existing data".
  - The submission's safety argument, point 6: "From then on a deleted highest id is never handed out again".
  - Higher ids are in fact known. `audit_events.entity_id` holds them for `request`, `image` and `plan_version`. `audit_events.detail_json` holds `planVersionId` and `runId` from `plan.create`. `model_spend.request_id` holds request ids, read in the staging copy before the NULLing.
- **Reproduction 1, through the app:** ev:ev-mv3twi5f-015c7a17, line "M REPRO (new, SEC-RW4-1)".
  1. On a 005 schema, X (cafe1) creates request 5. X uploads image 4, extracts, and hard-deletes it. Request 5 is the highest id, so it was never reused on 005.
  2. Migrate to 006.
  3. Y (cafe2) creates the first request after the upgrade. It gets **id 5**, and its image gets **id 4**.
  4. `GET /api/admin/timeline?requestId=5` lists X's `request.create(request:5)`, `extraction.run(request:5)` and `request.delete(request:5)` among Y's own events.
  5. Y's view shows none of X's text. The exposure is the same as FU-23: admin-only; ids, codes and counts.
- **Reproduction 2, in isolation:** ev:ev-mv3u2o6u-0130d038. With 006 as submitted, the next ids are request 2, image 11, run 101 and plan version 30. Those are exactly the deleted ids that the audit rows and the `model_spend` row still name.
- **Impact:**
  - Audit-trail integrity: the same class as FU-23, minor.
  - It hits every database that already holds data when it is upgraded. The rebuild exists for exactly those databases; fresh databases are created with AUTOINCREMENT anyway.
  - The ids affected are the run of hard-deleted ids directly above each table's surviving max at the moment of the upgrade.
  - `model_spend` itself is protected: the dangling row is set to NULL.
  - The RS-39 tests and `migrate-006.test.js` only delete *after* migrating, so they cannot see this.
- **Resolution condition:**
  - In 006, before the staging tables are dropped, raise each rebuilt table's `sqlite_sequence` to the highest id still named anywhere. Create the row first if a table is empty.
  - Add a test that deletes the highest request, image, run and plan version *before* migrating and asserts they are not handed out afterwards.
  - Validated statements (ev:ev-mv3u2o6u-0130d038: next ids become 3/12/102/31, `foreign_key_check` empty):

```sql
INSERT INTO sqlite_sequence (name, seq)
  SELECT t, 0 FROM (SELECT 'rescue_requests' AS t UNION ALL SELECT 'images' UNION ALL SELECT 'planning_runs' UNION ALL SELECT 'plan_versions')
  WHERE t NOT IN (SELECT name FROM sqlite_sequence);
UPDATE sqlite_sequence SET seq = MAX(seq,
  COALESCE((SELECT MAX(entity_id) FROM audit_events WHERE entity_type = 'request'), 0),
  COALESCE((SELECT MAX(request_id) FROM s_model_spend), 0)) WHERE name = 'rescue_requests';
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT MAX(entity_id) FROM audit_events WHERE entity_type = 'image'), 0)) WHERE name = 'images';
UPDATE sqlite_sequence SET seq = MAX(seq,
  COALESCE((SELECT MAX(entity_id) FROM audit_events WHERE entity_type = 'plan_version'), 0),
  COALESCE((SELECT MAX(CAST(json_extract(detail_json, '$.planVersionId') AS INTEGER)) FROM audit_events WHERE action = 'plan.create'), 0)) WHERE name = 'plan_versions';
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT MAX(CAST(json_extract(detail_json, '$.runId') AS INTEGER)) FROM audit_events WHERE action = 'plan.create'), 0)) WHERE name = 'planning_runs';
```

- **Owner:** backend-engineer, in this rework. 006 has not been applied anywhere persistent. After it has, NFR1 refuses an edit, and a 007 cannot take back ids already handed out.

### info

**SEC-RW4-I1: `extractions` and `requirements` ids are still reused after a hard delete (residual 2 of the submission). Not needed now.**
- **Evidence:** ev:ev-mv3twcws-01dec919 R. X's extraction id 1 and requirements id 1 are reused by Y after X's hard delete. The same happens on the upgraded database in ev:ev-mv3twi5f-015c7a17, where G2 and K both get extraction 5 and requirements 6.
- **Exposure:**
  - Y's request view carries `extraction.id = 1`. The audit `extraction.run` rows of both customers carry `detail.extractionId = 1`, on different request entities.
  - No route looks anything up by extraction or requirements id, and the admin timeline scopes by request and plan ids only. So X's events do not reach Y's timeline (checked).
  - Requirements ids appear in no audit row.
  - Only a person correlating `detail.extractionId` across raw audit rows could conflate the two.
- **Recommendation:** if 006 is reopened for SEC-RW4-1, adding AUTOINCREMENT to these two tables is cheap, because both are already staged. Otherwise leave it.

**SEC-RW4-I2: an extract that races a hard delete of the same request now answers 500 INTERNAL; it used to answer 404.**
- **Evidence:** ev:ev-mv3twcws-01dec919 R. The race "extract ‖ DELETE" was run 25 times, and all 25 gave extract 500 INTERNAL with delete 200 hard.
- **Mechanism:**
  1. `extractRequest` checks the owner, then awaits the image read.
  2. The DELETE commits during that await.
  3. `gate.reserve` then inserts `model_spend` naming the deleted request. The new FK refuses it with SQLite 787 (confirmed directly: `gate.run` → `Error/ERR_SQLITE_ERROR/787`, provider not called).
  4. That error is not an AppError, so `app.js` maps it to 500 and logs `http.error` at error level.
- **What did not change:** no SQL or constraint text reaches the response (checked). No `model_spend` row is added and no provider call is made, which is better than before: the old code called the provider, then answered 404. One `extract_upload` rate slot is consumed.
- **Impact:** a customer can only cause error-level log lines and 500s on their own request, bounded by the 10-minute extract/upload limit. No security impact.
- **Recommendation (TR domain):** map an FK failure in `reserve` to 404 NOT_FOUND, or re-check the owner inside the reserve transaction.

**SEC-RW4-I3: the SEC-R-1 fail-open allows uncounted reads only while another connection holds the write lock, and a user cannot cause that.**
- **Evidence:** ev:ev-mv3twcws-01dec919 L.
  - While a separate lock-holder process held the lock, 400 GETs in one fixed-clock minute all answered 200 and none was counted (the limit is 300/min).
  - **Self-induction failed.** One user's 40 concurrent writes plus 120 concurrent reads produced 0 `busy_open` lines and no 503, and 160 of 160 calls were counted.
  - The reason: the app uses a single `node:sqlite` connection with synchronous `db.tx`, so in-process traffic never produces SQLITE_BUSY.
  - The only other connections are operator processes: `npm run seed`, a second instance on the same file, or external tools.
- **Exposure:** while such a lock is held, a signed-in user reads only their own data. The costliest reads were the request view and an image of up to 5 MB.
  - Each read under the lock waits 50 ms, synchronously on the event loop (55.0 ms per read measured). That throttles the whole process to roughly 18 reads/s.
  - Before, the wait was 5 s per read.
  - Admin-only reads (timeline, metrics) are admin's own.
- **Accepted by design.** No action.

**SEC-RW4-I4: the session-touch write on a GET still waits the full busy timeout (outside this diff).**
- **Evidence:** ev:ev-mv3twcws-01dec919 L, INFO line. Under the lock, a GET whose session was due a touch (more than 60 s since the last) took **1057 ms** with a 1000 ms busy timeout; the default timeout is 5000 ms.
- **Cause:**
  - `src/auth/sessions.js` (lines 57–63) runs the touch `UPDATE` with the connection's normal timeout, before the limiter, and tolerates busy only after it.
  - `node:sqlite` waits synchronously, so during an operator-held lock each user's first poll per minute stalls the whole process for up to 5 s.
- **Relation to SEC-R-1:** this is the same availability class. It goes beyond SEC-R-1's resolution condition, which named the limiter only.
- **Recommendation:** apply the same short wait to the touch, or skip it on busy. Route to the next `src/auth` touch.

**SEC-RW4-I5: collisions made before 006 stay as they are (residual 3 of the submission, confirmed).**
- **Evidence:** ev:ev-mv3twi5f-015c7a17. On the 005 database, X's `model_spend` row 3 names request 3, which now belongs to Y (row 4 is Y's own). Both rows are unchanged after 006.
- **Assessment:** not repairable from the data. Disclosed. No action.

## Checked and held

**FU-23, iteration-1 section F re-run at HEAD** (ev:ev-mv3twcws-01dec919 F, the same flow as ev:ev-mv33e5qp-017ba56b):
- **Ids:** after X's hard delete, Y's request, image, planning run and plan version all get larger ids. X has 1/1/1/1; Y has 2/2/2/2. Iteration 1 showed equal ids.
- **Timelines:**
  - The admin timeline of Y's request shows only Y's events (`request.create,extraction.run,requirements.confirm,plan.create,plan.approve`, actor Y only).
  - X's deleted id keeps X's history (`…,request.delete`, actor X only).
- **Access:** X's deleted id is 404 to X (view, image, extract) and to Y.
- **model_spend:**
  - X's `model_spend` row survives with `request_id` NULL and `customer_id` X.
  - The daily budget still counts it: the gate's SQL sum is 3700 µ$ before and after, and `/api/admin/metrics` shows 0.0037 before and after.
  - An insert naming an unknown request is refused (787).
  - `foreign_key_check` is empty.

**Migration 006 on a realistic 005 database** (ev:ev-mv3twi5f-015c7a17):
- **Data:**
  - The database was filled through HTTP: kept requests, a reserved-then-tombstoned request, two hard deletes, an active reservation, supplier orders, payment operations, provider calls, plan approvals and a `replan_queue` row.
  - After migrating, every table except `model_spend` and `schema_migrations` holds exactly the same rows. No data was lost and no cascade fired through the DROPs.
  - `model_spend` keeps its rows and amounts. Only the dangling `request_id` became NULL, and the daily sums are unchanged.
- **Schema:**
  - Only the five rebuilt tables changed in `sqlite_master`.
  - Every index and trigger is byte-identical, including SEC-B-2's `audit_no_update`, `audit_no_delete`, `inventory_ledger_no_update` and `inventory_ledger_no_delete`.
  - Each rebuilt table's definition differs from the old one only by `AUTOINCREMENT` and the `model_spend` FK.
  - The FK lists of all tables are unchanged except `model_spend`, which gains `request_id → rescue_requests ON DELETE SET NULL`.
  - The upgraded schema equals a fresh 001–006 schema.
- **Integrity:**
  - `foreign_key_check` is empty, `integrity_check` is ok, and `foreign_keys` is still ON.
  - No TEMP staging table is left behind.
  - `sqlite_sequence` equals the max ids, as stated; see SEC-RW4-1 for why that is not enough.
- **Append-only:** UPDATE, DELETE, INSERT OR REPLACE and REPLACE on `audit_events` and `inventory_ledger` are all still refused.
- **After the upgrade:** a hard delete of the highest request is not reused afterwards (G2 is 6/5/6/6, K is 7/6/7/7).

**SEC-R-1** (ev:ev-mv3twcws-01dec919 L, a real lock-holder process via `test/helpers/lock-proc.js`, connection busy timeout 1000 ms):
- **Reads fail open:**
  - Under the lock, GET list, GET view and GET image answer 200 in 54–55 ms, uncounted.
  - Each logs exactly one `rate_limit.busy_open` warn line. Its keys are `ts, level, msg, requestId` only: no user id, username, key, session or path.
  - `PRAGMA busy_timeout` is restored to 1000 afterwards.
- **Every non-read call fails closed** with 503 `DB_BUSY` and `Retry-After: 1`, uncounted and without a `busy_open` line. This covered:
  - POST create, POST extract and DELETE;
  - a POST carrying `X-HTTP-Method-Override` / `X-Method-Override` / `X-HTTP-Method: GET`;
  - a POST with `?_method=GET`;
  - sign-out.
  The POST waited the full 1008 ms.
- **The method cannot be spoofed:**
  - The limiter receives `req.method` from Node's HTTP parser. No override header or parameter exists anywhere in `src`.
  - A GET with `X-HTTP-Method-Override: POST` is served as the plain list and creates nothing.
  - `get` and `GeT` on the wire get 400 from the parser before any app code.
  - HEAD gets 405 from the router, before the access hook, because no HEAD route is registered.
  - The limiter runs after `router.match`, so it only ever sees a registered route's method.
- **Counting resumes after release:** 0 calls in the window before, 1 after. The reads made under the lock left nothing behind.
- **Code review:**
  - `withShortBusyWait` interpolates only integers that are validated at construction (0–5000) or by `openDb`, so the PRAGMA cannot be injected.
  - A non-busy error is rethrown.
  - The over-limit 429 path is unchanged.

**Diff hygiene:**
- `src/auth/rbac.js` changes exactly one line, the `limiter.take` call (`git diff 46046ed`).
- `test/unit/ai/gate.test.js` is +2/-0. The fixture inserts request 7 for the test's own customer. The NFR6 assertions are unchanged and still check `request_id` 7 on the reserved row, so no assertion was weakened.
- `migrate.test.js` and `open-race.test.js` only move the version numbers: test migrations go 006 → 007, and the expected list becomes `[1..6]`.

**Project checks:**
- The green set passes 120/120.
- `npm test` has one failure, outside the rework files, and that test passes 41/41 when run alone.

## Not checked

- Migration timing and write-lock duration on a large database (residual 4 of the submission). I tested only small, realistic databases.
- Deployments with more than one app instance on one database file. They are not a supported topology, but they would make SEC-RW4-I3's fail-open reachable through another instance's long transactions.
- Live model and live PayPal: never enabled (`RS_LIVE_MODEL` and `RS_LIVE_PAYPAL` unset). The browser suite (`npm run test:browser`) was not re-run by me.
- e4's files (saga, reconciler, execute), beyond confirming that they add no migration and open no second connection (`openDb` is called only in `src/main.js` and `scripts/seed.js`).
- SEC-R-2 and SEC-R-3: untouched by this rework and still open, as the submission states.

## Guard refusals during this review (verbatim)

1. While extracting the base tree `46046ed` into my scratchpad with `git archive | tar -x` (to build a 005 database with the old code), combined with `cd`:
   `PreToolUse:Bash hook error: This command changes directory (cd/pushd/popd) and then writes the relative path "$SP/rw4-v5", which the guard cannot bind to a file. Write it with a path relative to the project root in a command without cd, or use the Edit/Write tool so ownership can be checked.`
2. The same extraction without `cd`, and three later `sed -i` edits of my own probe files in the scratchpad (one earlier `sed -i` on the same file was allowed):
   `PreToolUse:Bash hook error: security-reviewer reviews/designs but does not edit project files; write drafts under .eccode/artifacts/ or .eccode/reviews/drafts/.`
3. **What I did instead:**
   - I did not extract the base tree. Section M builds the 005 database with the HEAD app on migrations 001–005 copied to a temp directory, the same technique `migrate-006.test.js` uses.
   - I rewrote the probe files with the Write tool.
   - No project file was edited.
