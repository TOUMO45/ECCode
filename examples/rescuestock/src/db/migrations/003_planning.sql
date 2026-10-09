CREATE TABLE planning_runs (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
  requirements_version INTEGER NOT NULL, feasible INTEGER NOT NULL CHECK (feasible IN (0,1)),
  trace_json TEXT NOT NULL, rejections_json TEXT NOT NULL, candidate_codes_json TEXT NOT NULL DEFAULT '[]',
  relaxations_json TEXT NOT NULL DEFAULT '[]', blocking_json TEXT NOT NULL DEFAULT '[]',
  excluded_suppliers_json TEXT NOT NULL DEFAULT '[]', offers_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX planning_runs_request ON planning_runs(request_id, id);
CREATE TABLE plan_versions (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES rescue_requests(id) ON DELETE CASCADE,
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
CREATE TABLE plan_approvals (
  id INTEGER PRIMARY KEY, plan_version_id INTEGER NOT NULL UNIQUE REFERENCES plan_versions(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES users(id), approved_hash TEXT NOT NULL, approved_total_cents INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE reservations (
  id INTEGER PRIMARY KEY, plan_version_id INTEGER NOT NULL REFERENCES plan_versions(id),
  customer_id INTEGER NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,                                     -- the client's Idempotency-Key (F-TR-1)
  operation_key TEXT NOT NULL UNIQUE,                                -- 'res:<customerId>:<planVersionId>:<Idempotency-Key>'
  status TEXT NOT NULL CHECK (status IN ('active','consumed','expired','released','reconciling')),
  expires_at TEXT NOT NULL, escalation TEXT CHECK (escalation IS NULL OR escalation IN ('REFUND_FAILED','VOID_FAILED','UNKNOWN_TOO_LONG','PENDING_TOO_LONG')),
  created_at TEXT NOT NULL, closed_at TEXT, UNIQUE (customer_id, idempotency_key));
CREATE INDEX reservations_customer_live ON reservations(customer_id) WHERE status = 'active';   -- SEC-2 cap
CREATE UNIQUE INDEX reservations_one_live ON reservations(plan_version_id) WHERE status IN ('active','consumed','reconciling');
CREATE INDEX reservations_expiry ON reservations(status, expires_at);
CREATE TABLE reservation_items (
  reservation_id INTEGER NOT NULL REFERENCES reservations(id), product_id INTEGER NOT NULL REFERENCES products(id),
  supplier_id INTEGER NOT NULL, offer_id INTEGER NOT NULL REFERENCES offers(id), qty INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (reservation_id, product_id));
CREATE TABLE supplier_orders (
  id INTEGER PRIMARY KEY, plan_version_id INTEGER NOT NULL REFERENCES plan_versions(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id), reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  lines_json TEXT NOT NULL, subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  prep_fee_cents INTEGER NOT NULL CHECK (prep_fee_cents >= 0), tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0 AND total_cents = subtotal_cents + prep_fee_cents + tax_cents),
  fulfilment_status TEXT NOT NULL CHECK (fulfilment_status IN ('awaiting_supplier','confirmed','refused','cancelled','ready','collected')),
  committed_qty_json TEXT, committed_ready_at TEXT, confirmed_at TEXT, refusal_reason TEXT CHECK (refusal_reason IS NULL OR length(refusal_reason) <= 300),
  ready_marked_at TEXT, collected_at TEXT, created_at TEXT NOT NULL, UNIQUE (plan_version_id, supplier_id));
CREATE INDEX supplier_orders_supplier ON supplier_orders(supplier_id, fulfilment_status);
CREATE TABLE pickup_confirmations (
  id INTEGER PRIMARY KEY, supplier_order_id INTEGER NOT NULL REFERENCES supplier_orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('handover','receipt')), by_user INTEGER NOT NULL REFERENCES users(id), at TEXT NOT NULL,
  UNIQUE (supplier_order_id, kind));
CREATE TABLE replan_queue (request_id INTEGER PRIMARY KEY REFERENCES rescue_requests(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, enqueued_at TEXT NOT NULL,
  failed_drains INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT);   -- F-TR-2: never dropped on failure
