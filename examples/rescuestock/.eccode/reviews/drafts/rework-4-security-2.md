# phase:rework-4: security review, iteration 2 (FINAL)

Reviewer: security-reviewer, run run-mv3utb3f-016a6eef. Gate: `phase:rework-4`. Submission: `sub-mv3ussgo-0158904e`
(responds to `rev-mv3ua9lc-01c4624b`). Handoff `ho-mv3um18e-0136c6a3`. Previous draft: `rework-4-security-1.md` (FINAL).
The technical-reviewer records the gate; this draft is input to its decision.

Status: FINAL.

## Verdict

- **SEC-RW4-1 (raised to major by `rev-mv3ua9lc-01c4624b`) is resolved.**
  - On HEAD, ids hard-deleted on 005 above the surviving maximum are not handed out again after the upgrade. This holds for requests, images, extractions, planning runs and plan versions.
  - It holds through the real HTTP flows (ev:ev-mv3v0c21-01572152) and in isolation (ev:ev-mv3v0chb-01c75520 S1).
  - My iteration-1 reproduction, re-run unchanged, no longer reproduces: its REPRO line now FAILS (ev:ev-mv3v0cw7-01fe08e4).
- **`requirements` keeps a gap: ids deleted on 005 are reused.** This is the disclosed residual. I confirmed it is unobservable: no audit row, spend row or API response names a requirements id.
- **The extractions and requirements rebuild keeps every trigger, index (automatic UNIQUE indexes included) and foreign key.** The upgraded schema equals a fresh 001–006 schema.
- **No new blocking, major or minor finding.**
  - I could get around the floor only with inputs the app cannot produce. Each is shown as a GAP line in ev:ev-mv3v0chb-01c75520. Combined into one info note, SEC-RW4-I6.
- **Since my iteration-1 review, only two files changed:** `006_autoincrement_ids.sql` and `migrate-006.test.js`. No test assertion was weakened.
- **From security: approve.**

## Evidence (recorded by security-reviewer on this gate, after `sub-mv3ussgo-0158904e`)

All ten artifacts of the submission have the same sha256 on disk as recorded in it, checked after these runs.

| ev id | what | result |
|---|---|---|
| ev:ev-mv3v0c21-01572152 | `sec-rw4-m2.mjs`: my probe M (shape of ev:ev-mv3twi5f-015c7a17), expectations inverted, extended to extractions and requirements | passed, ALL EXPECTATIONS MET |
| ev:ev-mv3v0chb-01c75520 | `sec-rw4-floor.mjs`: the isolated shape (S1, as in ev:ev-mv3u2o6u-0130d038, plus extractions and requirements) and the attempts to get around the floor (S2–S6) | passed, ALL EXPECTATIONS MET (GAP lines reproduce as expected) |
| ev:ev-mv3v0cw7-01fe08e4 | `sec-rw4-fixcheck.mjs` from iteration 1, unchanged, against HEAD | **failed as intended.** "006 as submitted" now gives 3/12/102/31, not 2/11/101/30, so the REPRO line FAILS. The fix line passes. |
| ev:ev-mv3v0s1s-01afdffc | green set of `ho-mv3um18e-0136c6a3`, verbatim | passed: 131 tests, 131 pass, 0 fail, 0 skipped, 0 todo |
| ev:ev-mv3v2lup-01b6c0fc | `npm test` (the project checks) | passed: 2087 tests, 2079 pass, 0 fail, 8 skipped, 0 todo |

## (1) SEC-RW4-1 re-test

**Through the app** (ev:ev-mv3v0c21-01572152). Setup on 005:
- X (cafe1) owns tree F: request 5, image 4, extraction 4, requirements 5, run 5 and plan version 5, each the highest id of its table.
- X hard-deletes F on 005.
- The database also holds a tombstoned request, an abandoned reservation, a pre-006 collision and a dangling spend row.

After migrating at HEAD:
- **Sequences equal an independently computed floor:** `{"rescue_requests":5,"images":4,"planning_runs":5,"plan_versions":5,"extractions":4,"requirements":4}`.
- **Y's first tree gets new ids:** request 6, image 5, extraction 5, run 6, plan version 6.
- **requirements:** id 5 is reused (residual, see below).
- **Timeline:** the admin timeline of Y's request lists only Y's events.
- **Audit rows:** no audit row of X names any of Y's new ids (checked as entity ids and as `extractionId`, `runId` and `planVersionId` details).
- **Y's view** carries no requirements id and none of X's text.

**In isolation** (ev:ev-mv3v0chb-01c75520 S1):
- **Setup:** survivors are request 1, image 10, extraction 50, requirements 60, run 100 and plan version 29. Request 2 was deleted with image 11, a degraded extraction 51, requirements 61, run 101, plan version 30, the app's audit trail and a spend row.
- **Result:** the next ids are 3/12/52/102/31 and `foreign_key_check` is empty. requirements gets 61 (residual).

**Attempts to get around the floor** (ev:ev-mv3v0chb-01c75520):

| # | attempt | result | reachable through the app? |
|---|---|---|---|
| S2 | ids named only inside malformed `detail_json` (truncated JSON; plain text) | the migration does not abort (`json_valid` guard). Those ids (extraction 51, run 101, plan 30) are not seen and are reused. The request floor from the entity id still holds. | **No.** `recordAudit` always writes `JSON.stringify(sanitizeDetail(…))` (`src/services/audit.js` lines 12–28, 50), so malformed JSON cannot be written. |
| S3 | a request id named only in another entity type's detail (`image.upload` `detail.requestId`, no `request` row) | that request id (2) is reused | **No.** Every request gets a `request.create` row with `entity_type='request'` (`src/services/requests.js` line 96). |
| S3 | large ids of unrelated entity types (`supplier_order` 500, `user` 900, a `supplier_order` detail `planVersionId` 40) | no floor is inflated. A denied `plan_version` row (35) raises the plan floor, which is correct and conservative. | — |
| S4 | a `model_spend` row naming request 7, which was never audited | the request floor rises (next id 8), and the row itself is set to NULL | — |
| S5 | an empty 005 database | six `sqlite_sequence` rows at 0; the first request gets id 1 | — |
| S6a | ids stored as the string `"45"`, the float `150.9` and the negative `-5` | the floor rises to 46 and 151; the negative id changes nothing | — |
| S6b | absurd values: `planVersionId` 1e300 or `runId` 2^63−1, and a `request` entity id of 999999999999999 | the sequence pins at 2^63−1, so the next plan version or run insert fails with SQLITE_FULL (13). The next request id becomes 1000000000000000 (16 digits), which `idParam` refuses. | **No.** `sanitizeDetail` keeps only safe integers (≤ 2^53−1, which leaves ample headroom). Entity ids are server-generated. The `denied` audit rows that name a plan version (`plan.approve`, `reservation.create`, `plan.execute`, `plan.abandon`) come from routes that call `findOwnedPlan` first (`src/routes/plans.js`). So a client cannot plant an arbitrary id in a source the floor reads. |
| — | the highest id is the one deleted | covered by S1 and M2 | — |

**Assessment:** SEC-RW4-1 is resolved. The floor reads every source the app actually writes for these tables:
- `request.create` and the other request-entity rows;
- `image.upload`;
- the plan_version-entity rows;
- `plan.create` `planVersionId` and `runId`;
- `extraction.run` `extractionId`, degraded outcome included;
- `model_spend.request_id`.

## (2) The rebuild of extractions and requirements; schema equality (ev:ev-mv3v0c21-01572152)

**Data and definitions:**
- Every table except `model_spend` and `schema_migrations` holds exactly the same rows after 006, extractions and requirements included.
- `model_spend` keeps its rows and amounts. Only the dangling `request_id` became NULL, and the daily sums are unchanged.
- In `sqlite_master` only the seven rebuilt tables changed: rescue_requests, images, extractions, requirements, planning_runs, plan_versions and model_spend.
- Each table's definition equals its 005 definition apart from `AUTOINCREMENT` and the `model_spend` FK, with comments and whitespace normalised.

**Indexes, triggers and foreign keys:**
- Every index of every table has the same name, uniqueness, origin and columns before and after, including the automatic indexes:
  - `sqlite_autoindex_requirements_1` on (request_id, version);
  - `images.file_name` UNIQUE;
  - `extractions_request` (request_id, id).
- The triggers of every table are unchanged. The rebuilt tables have none; the SEC-B-2 append-only triggers still refuse UPDATE, DELETE, INSERT OR REPLACE and REPLACE.
- The foreign keys of every table are unchanged except `model_spend` (+ `request_id → rescue_requests ON DELETE SET NULL`):
  - extractions → rescue_requests CASCADE;
  - requirements → rescue_requests CASCADE;
  - requirements.confirmed_by → users.
- No other table references extractions or requirements.

**Integrity:** `foreign_key_check` is empty, `integrity_check` is ok, `foreign_keys` is ON and no TEMP table is left.

**Schema equality:** the upgraded schema equals a fresh 001–006 schema, both in the `sqlite_master` text and in every index list. The fresh database has the six sequence rows at 0.

## (3) What changed since my iteration-1 review

- `git diff de5bde2 HEAD` over the nine files touches only two:
  - `src/db/migrations/006_autoincrement_ids.sql` (+55/−4): the extractions/requirements rebuild and the floor;
  - `test/unit/db/migrate-006.test.js`.
- **Test changes:**
  - `REBUILT` grows to six tables.
  - The seeded test now expects the floored sequences `[99,70,7000,33,700,700]` instead of `[7,70,7000,33]`. That is correct: request 99 is named by a spend row.
  - The after-006 RS-39 case seeds without the dangling spend, so the 99 floor does not mask it.
  - The new before-the-upgrade cases are added.
  - No assertion was removed or loosened.
- `general-limit.js`, `rbac.js`, `id-reuse.test.js`, `general-limit-busy.test.js`, `migrate.test.js`, `open-race.test.js` and `gate.test.js` are unchanged since iteration 1. My SEC-R-1 results (ev:ev-mv3twcws-01dec919) still apply, and the technical review recorded SEC-R-1 as resolved.

## Findings

### blocking / major / minor

None new.

### info

**SEC-RW4-I6: the floor sees only the sources the app writes; the corrected safety point 6 says slightly more than that.**
- **Evidence:** ev:ev-mv3v0chb-01c75520, GAP lines S2, S3 and S6b.
- **What the floor misses:**
  - an id named only in malformed JSON;
  - a request id named only in another entity's detail;
  - absurd values, which can pin a sequence.
- **Reachability:** none of these can be produced by the app (see the table above).
- **Wording:** the submission's point 6 reads "no id that `audit_events` or `model_spend` still names is handed out again". Read literally, that also covers detail keys the floor does not read (for example `image.upload` `requestId`, or order details' `planVersionId`). It is true for the rows the app writes.
- **Recommendation:** the verification report should word it as "no id named by the audit rows the app writes for these tables (…) or by `model_spend`". No code change is needed.

**requirements residual (disclosed by the submission; confirmed harmless).**
- **Evidence:** ev:ev-mv3v0c21-01572152 and ev:ev-mv3v0chb-01c75520 S1.
- **What happens:** a requirements id deleted on 005 above the surviving maximum is handed out again after the upgrade. Ids deleted after the upgrade are not reused, because of AUTOINCREMENT.
- **Why it is harmless:** no audit row (`requirements.confirm` carries only `version`), no spend row and no API response names a requirements id. Y's view was checked. No action.

The iteration-1 info notes are as recorded in `rev-mv3ua9lc-01c4624b` and the iteration-2 table of the submission:
- SEC-RW4-I1 is fixed.
- SEC-RW4-I2 and SEC-RW4-I4 are carried, outside this rework's files.
- SEC-RW4-I3 and SEC-RW4-I5 need no action.

## Not checked

- Migration run time on large databases (TR-R4-1, decision `dec-mv3u4zzu-01f07c5a`). I did not repeat the measurement.
- The browser suite. Live model and live PayPal were never enabled.
- e4, e5 and e6 files beyond what `npm test` exercises.

## Guard refusals during this iteration (verbatim)

1. When I first tried to record evidence through a shell variable holding the CLI invocation:
   `PreToolUse:Bash hook error: The guard cannot verify who this eccode command acts as: "$E" runs a command through a variable or substitution; call the eccode CLI directly so its --actor can be checked.`
   I then called the CLI directly with `--actor security-reviewer`; every run above was recorded that way.
