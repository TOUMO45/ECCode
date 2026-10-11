-- 006: ids of rescue_requests, planning_runs, plan_versions, images, extractions and requirements are never reused (FU-23 /
-- TR-D-3), also not those hard-deleted before the upgrade (SEC-RW4-1), and model_spend.request_id becomes a foreign key.
-- App-only migration: no new data, no seed change.
--
-- Why: an INTEGER PRIMARY KEY without AUTOINCREMENT takes max(rowid) + 1, so after a hard delete of the highest id the next
-- insert gets the same id. The append-only audit_events (entity_id) and the model_spend row of the deleted request then
-- named another customer's request, plan version or image. AUTOINCREMENT keeps a high-water mark in sqlite_sequence.
-- SQLite cannot add AUTOINCREMENT to an existing table, so the six tables are rebuilt.
--
-- How, inside the migration runner's one BEGIN IMMEDIATE (src/db/migrate.js) with foreign_keys = ON, which cannot be switched
-- off inside a transaction:
--   * defer_foreign_keys = ON postpones every foreign-key check to COMMIT. A violation left at COMMIT (a parent id that did not
--     come back) fails the commit and rolls the whole migration back, so the file is applied completely or not at all.
--   * DROP TABLE runs an implicit DELETE that fires ON DELETE CASCADE: dropping rescue_requests deletes the rows of extractions,
--     requirements, replan_queue, and dropping plan_versions deletes plan_approvals. These (and the four rebuilt tables) are
--     copied to TEMP tables first and put back with their original ids afterwards. Children with no cascade (reservations,
--     supplier_orders, ...) stay in place; their references are satisfied again when the parent ids are re-inserted.
--   * The tables are recreated under their own names, so no ALTER TABLE ... RENAME rewrites the references of other tables.
--   * The append-only triggers of SEC-B-2 sit on audit_events and inventory_ledger, which are not touched; none of the rebuilt
--     tables has a trigger. Their indexes are dropped with them and created again below, byte for byte as in 002 and 003.
--   * The high-water mark (SEC-RW4-1). Re-inserting the surviving rows would only raise sqlite_sequence to the highest SURVIVING
--     id, and ids that were hard-deleted on 005 above that point would be handed out again, although audit_events and
--     model_spend still name them. So, before the staging tables are dropped, each sequence is raised to the highest id still
--     named anywhere: audit_events.entity_id for the entity type (request, image, plan_version), the plan.create details
--     planVersionId and runId, the extraction.run detail extractionId, and the staged model_spend.request_id. A missing
--     sqlite_sequence row is created first. requirements ids appear in no audit row, so for that table the surviving maximum is
--     the best mark there is. Ids that 005 had already handed out twice before this migration cannot be told apart and stay as
--     they are.
--   * extractions and requirements are rebuilt too (SEC-RW4-I1): both are staged anyway and their ids were reused as well.
--
-- model_spend.request_id: FOREIGN KEY ... ON DELETE SET NULL. The row is the budget ledger of the day (gate.js sums every
-- row of the day), so it must survive a hard delete of its request; SET NULL keeps customer, day, purpose and amount and
-- drops the pointer, so the row can never name another request, and an insert that names a request that does not exist is
-- refused. Rows that already point at a deleted request (made before this migration) are set to NULL when they are copied.

PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE s_rescue_requests AS SELECT * FROM rescue_requests;
CREATE TEMP TABLE s_images AS SELECT * FROM images;
CREATE TEMP TABLE s_extractions AS SELECT * FROM extractions;
CREATE TEMP TABLE s_requirements AS SELECT * FROM requirements;
CREATE TEMP TABLE s_planning_runs AS SELECT * FROM planning_runs;
CREATE TEMP TABLE s_plan_versions AS SELECT * FROM plan_versions;
CREATE TEMP TABLE s_plan_approvals AS SELECT * FROM plan_approvals;
CREATE TEMP TABLE s_replan_queue AS SELECT * FROM replan_queue;
CREATE TEMP TABLE s_model_spend AS SELECT * FROM model_spend;

DROP TABLE model_spend;
DROP TABLE plan_versions;
DROP TABLE planning_runs;
DROP TABLE images;
DROP TABLE extractions;
DROP TABLE requirements;
DROP TABLE rescue_requests;

CREATE TABLE rescue_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES users(id),
  raw_text TEXT CHECK (raw_text IS NULL OR length(raw_text) BETWEEN 1 AND 4000),     -- NULL after tombstone
  language TEXT NOT NULL CHECK (language IN ('ar','en','mixed','unknown')),
  intake_status TEXT NOT NULL CHECK (intake_status IN ('draft','extracted','confirmed')),   -- NOT a rescue status
  deleted_at TEXT, archived_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX rescue_requests_customer ON rescue_requests(customer_id, created_at);
CREATE TABLE images (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL UNIQUE CHECK (file_name GLOB '[0-9a-f]*' AND length(file_name) = 32),  -- 128-bit random hex
  mime_detected TEXT NOT NULL CHECK (mime_detected IN ('image/png','image/jpeg','image/webp')),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 5242880), sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX images_one_per_request ON images(request_id);
CREATE INDEX images_created ON images(created_at);
CREATE TABLE extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('fake','cli','anthropic','none')), model TEXT, prompt_version TEXT NOT NULL,
  schema_ok INTEGER NOT NULL CHECK (schema_ok IN (0,1)), error_code TEXT, degraded INTEGER NOT NULL CHECK (degraded IN (0,1)),
  simulated INTEGER NOT NULL CHECK (simulated IN (0,1)), latency_ms INTEGER, cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  fields_json TEXT NOT NULL, questions_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  CHECK (degraded = 0 OR (schema_ok = 0 AND error_code IS NOT NULL)));
CREATE INDEX extractions_request ON extractions(request_id, id);
CREATE TABLE requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1), fields_json TEXT NOT NULL,          -- FieldValue map; originalWording scrubbed on tombstone
  product_type TEXT NOT NULL CHECK (product_type IN ('cups_and_lids','cups','lids')),
  cups INTEGER NOT NULL CHECK (cups BETWEEN 0 AND 100000), lids INTEGER NOT NULL CHECK (lids BETWEEN 0 AND 100000),
  capacity_ml INTEGER NOT NULL, diameter_mm INTEGER NOT NULL, material TEXT,
  budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents BETWEEN 1 AND 100000000),
  deadline_at TEXT, max_pickups INTEGER NOT NULL CHECK (max_pickups BETWEEN 1 AND 5),
  confirmed_by INTEGER NOT NULL REFERENCES users(id), confirmed_at TEXT NOT NULL, UNIQUE (request_id, version));
CREATE TABLE planning_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
  requirements_version INTEGER NOT NULL, feasible INTEGER NOT NULL CHECK (feasible IN (0,1)),
  trace_json TEXT NOT NULL, rejections_json TEXT NOT NULL, candidate_codes_json TEXT NOT NULL DEFAULT '[]',
  relaxations_json TEXT NOT NULL DEFAULT '[]', blocking_json TEXT NOT NULL DEFAULT '[]',
  excluded_suppliers_json TEXT NOT NULL DEFAULT '[]', offers_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX planning_runs_request ON planning_runs(request_id, id);
CREATE TABLE plan_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
  planning_run_id INTEGER NOT NULL REFERENCES planning_runs(id), version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('draft','proposed','approved','superseded','non_executable','executing','executed')),
  plan_json TEXT NOT NULL, alternatives_json TEXT NOT NULL DEFAULT '[]', plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0), pickup_count INTEGER NOT NULL CHECK (pickup_count >= 1),
  ready_at TEXT NOT NULL, superseded_by INTEGER REFERENCES plan_versions(id),
  supersede_reason TEXT CHECK (supersede_reason IS NULL OR supersede_reason IN ('PRICE_CHANGED','PREP_FEE_CHANGED','READY_TIME_CHANGED','OFFER_WITHDRAWN','AVAILABILITY_DROPPED','REQUIREMENTS_CHANGED','REPLANNED')),
  non_executable_reason TEXT CHECK (non_executable_reason IS NULL OR non_executable_reason IN
    ('SUPPLIER_REFUSED','AUTHORIZATION_FAILED','AUTHORIZATION_EXPIRED','PAYMENT_CANCELLED','RESERVATION_EXPIRED','CAPTURE_FAILED','OUT_OF_STOCK','REQUEST_DELETED','DEMO_RESET')),
  reason_detail_json TEXT NOT NULL DEFAULT '{}',          -- e.g. {"supplierCode":"B","refusal":"..."}
  executor_id TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (request_id, version),
  CHECK (status <> 'non_executable' OR non_executable_reason IS NOT NULL),
  CHECK (status <> 'superseded' OR supersede_reason IS NOT NULL));
CREATE INDEX plan_versions_request ON plan_versions(request_id, version);
CREATE INDEX plan_versions_exec ON plan_versions(status, lease_until);
CREATE TABLE model_spend (
  id INTEGER PRIMARY KEY, day TEXT NOT NULL,                       -- YYYY-MM-DD in Asia/Amman
  customer_id INTEGER NOT NULL REFERENCES users(id), request_id INTEGER REFERENCES rescue_requests(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('extract','rephrase')),
  reserved_micro_usd INTEGER NOT NULL CHECK (reserved_micro_usd >= 0),   -- F-TR-12: integer micro-dollars
  actual_micro_usd INTEGER CHECK (actual_micro_usd IS NULL OR actual_micro_usd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved','settled')), created_at TEXT NOT NULL);
CREATE INDEX model_spend_day ON model_spend(day);
CREATE INDEX model_spend_customer ON model_spend(customer_id, status);

INSERT INTO rescue_requests SELECT * FROM s_rescue_requests ORDER BY id;
INSERT INTO images SELECT * FROM s_images ORDER BY id;
INSERT INTO planning_runs SELECT * FROM s_planning_runs ORDER BY id;
INSERT INTO plan_versions SELECT * FROM s_plan_versions ORDER BY id;
INSERT INTO extractions SELECT * FROM s_extractions ORDER BY id;
INSERT INTO requirements SELECT * FROM s_requirements ORDER BY id;
INSERT INTO plan_approvals SELECT * FROM s_plan_approvals ORDER BY id;
INSERT INTO replan_queue SELECT * FROM s_replan_queue ORDER BY request_id;
INSERT INTO model_spend (id, day, customer_id, request_id, purpose, reserved_micro_usd, actual_micro_usd, status, created_at)
  SELECT id, day, customer_id, CASE WHEN request_id IN (SELECT id FROM rescue_requests) THEN request_id END,
         purpose, reserved_micro_usd, actual_micro_usd, status, created_at
  FROM s_model_spend ORDER BY id;

-- The sequence floor (SEC-RW4-1): raise each sequence to the highest id still named anywhere. This must run before the staging
-- tables are dropped, because s_model_spend still holds the request ids that the copy above set to NULL. json_extract is
-- guarded by json_valid so a malformed detail_json can never abort the migration.
INSERT INTO sqlite_sequence (name, seq)
  SELECT t, 0 FROM (SELECT 'rescue_requests' AS t UNION ALL SELECT 'images' UNION ALL SELECT 'planning_runs'
                    UNION ALL SELECT 'plan_versions' UNION ALL SELECT 'extractions' UNION ALL SELECT 'requirements')
  WHERE t NOT IN (SELECT name FROM sqlite_sequence);
UPDATE sqlite_sequence SET seq = MAX(seq,
  COALESCE((SELECT MAX(entity_id) FROM audit_events WHERE entity_type = 'request'), 0),
  COALESCE((SELECT MAX(request_id) FROM s_model_spend), 0)) WHERE name = 'rescue_requests';
UPDATE sqlite_sequence SET seq = MAX(seq,
  COALESCE((SELECT MAX(entity_id) FROM audit_events WHERE entity_type = 'image'), 0)) WHERE name = 'images';
UPDATE sqlite_sequence SET seq = MAX(seq,
  COALESCE((SELECT MAX(entity_id) FROM audit_events WHERE entity_type = 'plan_version'), 0),
  COALESCE((SELECT MAX(CASE WHEN json_valid(detail_json) THEN CAST(json_extract(detail_json, '$.planVersionId') AS INTEGER) END)
              FROM audit_events WHERE action = 'plan.create'), 0)) WHERE name = 'plan_versions';
UPDATE sqlite_sequence SET seq = MAX(seq,
  COALESCE((SELECT MAX(CASE WHEN json_valid(detail_json) THEN CAST(json_extract(detail_json, '$.runId') AS INTEGER) END)
              FROM audit_events WHERE action = 'plan.create'), 0)) WHERE name = 'planning_runs';
UPDATE sqlite_sequence SET seq = MAX(seq,
  COALESCE((SELECT MAX(CASE WHEN json_valid(detail_json) THEN CAST(json_extract(detail_json, '$.extractionId') AS INTEGER) END)
              FROM audit_events WHERE action = 'extraction.run'), 0)) WHERE name = 'extractions';

DROP TABLE s_rescue_requests;
DROP TABLE s_images;
DROP TABLE s_extractions;
DROP TABLE s_requirements;
DROP TABLE s_planning_runs;
DROP TABLE s_plan_versions;
DROP TABLE s_plan_approvals;
DROP TABLE s_replan_queue;
DROP TABLE s_model_spend;
