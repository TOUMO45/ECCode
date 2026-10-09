CREATE TABLE rescue_requests (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES users(id),
  raw_text TEXT CHECK (raw_text IS NULL OR length(raw_text) BETWEEN 1 AND 4000),     -- NULL after tombstone
  language TEXT NOT NULL CHECK (language IN ('ar','en','mixed','unknown')),
  intake_status TEXT NOT NULL CHECK (intake_status IN ('draft','extracted','confirmed')),   -- NOT a rescue status
  deleted_at TEXT, archived_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX rescue_requests_customer ON rescue_requests(customer_id, created_at);
CREATE TABLE images (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL UNIQUE CHECK (file_name GLOB '[0-9a-f]*' AND length(file_name) = 32),  -- 128-bit random hex
  mime_detected TEXT NOT NULL CHECK (mime_detected IN ('image/png','image/jpeg','image/webp')),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 5242880), sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX images_one_per_request ON images(request_id);
CREATE INDEX images_created ON images(created_at);
CREATE TABLE extractions (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('fake','cli','anthropic','none')), model TEXT, prompt_version TEXT NOT NULL,
  schema_ok INTEGER NOT NULL CHECK (schema_ok IN (0,1)), error_code TEXT, degraded INTEGER NOT NULL CHECK (degraded IN (0,1)),
  simulated INTEGER NOT NULL CHECK (simulated IN (0,1)), latency_ms INTEGER, cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  fields_json TEXT NOT NULL, questions_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  CHECK (degraded = 0 OR (schema_ok = 0 AND error_code IS NOT NULL)));
CREATE INDEX extractions_request ON extractions(request_id, id);
CREATE TABLE requirements (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1), fields_json TEXT NOT NULL,          -- FieldValue map; originalWording scrubbed on tombstone
  product_type TEXT NOT NULL CHECK (product_type IN ('cups_and_lids','cups','lids')),
  cups INTEGER NOT NULL CHECK (cups BETWEEN 0 AND 100000), lids INTEGER NOT NULL CHECK (lids BETWEEN 0 AND 100000),
  capacity_ml INTEGER NOT NULL, diameter_mm INTEGER NOT NULL, material TEXT,
  budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents BETWEEN 1 AND 100000000),
  deadline_at TEXT, max_pickups INTEGER NOT NULL CHECK (max_pickups BETWEEN 1 AND 5),
  confirmed_by INTEGER NOT NULL REFERENCES users(id), confirmed_at TEXT NOT NULL, UNIQUE (request_id, version));
CREATE TABLE rate_events (id INTEGER PRIMARY KEY, user_key TEXT NOT NULL,   -- 'u:<userId>' or 'ip:<address>'
  kind TEXT NOT NULL CHECK (kind IN ('extract_or_upload','register','request_create','webhook','general')), at TEXT NOT NULL);
CREATE INDEX rate_events_key ON rate_events(user_key, kind, at);
-- request_create events are counted per Asia/Amman day and are not removed when a request is deleted (SEC-2)
CREATE TABLE model_spend (
  id INTEGER PRIMARY KEY, day TEXT NOT NULL,                       -- YYYY-MM-DD in Asia/Amman
  customer_id INTEGER NOT NULL REFERENCES users(id), request_id INTEGER,
  purpose TEXT NOT NULL CHECK (purpose IN ('extract','rephrase')),
  reserved_micro_usd INTEGER NOT NULL CHECK (reserved_micro_usd >= 0),   -- F-TR-12: integer micro-dollars
  actual_micro_usd INTEGER CHECK (actual_micro_usd IS NULL OR actual_micro_usd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved','settled')), created_at TEXT NOT NULL);
CREATE INDEX model_spend_day ON model_spend(day);
CREATE INDEX model_spend_customer ON model_spend(customer_id, status);
