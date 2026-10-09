CREATE TABLE payment_operations (
  id INTEGER PRIMARY KEY, supplier_order_id INTEGER NOT NULL UNIQUE REFERENCES supplier_orders(id),
  status TEXT NOT NULL CHECK (status IN ('created','approved','authorization_pending','authorized','authorization_failed',
    'capture_pending','captured','voided','refund_requested','refund_pending','refunded','refund_failed','unknown')),
  prev_status TEXT,                                    -- status before 'unknown' (restored when the provider shows no effect)
  provider TEXT NOT NULL CHECK (provider IN ('fake','paypal-sandbox')), merchant_key TEXT NOT NULL,
  provider_order_id TEXT UNIQUE, approval_url TEXT, create_attempt INTEGER NOT NULL DEFAULT 1,
  provider_authorization_id TEXT, provider_capture_id TEXT, provider_refund_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), currency TEXT NOT NULL CHECK (currency = 'USD'),
  authorization_expires_at TEXT, buyer_cancelled_at TEXT,
  cancel_requested_at TEXT, cancel_reason TEXT,        -- ARCH-22: set by the void rule / compensation on every non-terminal op
  voided_locally INTEGER NOT NULL DEFAULT 0 CHECK (voided_locally IN (0,1)),
  void_failed INTEGER NOT NULL DEFAULT 0 CHECK (void_failed IN (0,1)),
  last_error_code TEXT, unknown_since TEXT, pending_since TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (status <> 'unknown' OR (prev_status IS NOT NULL AND unknown_since IS NOT NULL)));
CREATE INDEX payment_operations_status ON payment_operations(status) WHERE archived_at IS NULL;
CREATE TABLE provider_calls (
  id INTEGER PRIMARY KEY, payment_operation_id INTEGER NOT NULL REFERENCES payment_operations(id),
  kind TEXT NOT NULL CHECK (kind IN ('create_order','authorize','capture','void','refund')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  operation_key TEXT NOT NULL UNIQUE CHECK (operation_key GLOB 'so:[0-9]*:*:[0-9]*'),  -- so:<supplierOrderId>:<kind>:<attempt>
  status TEXT NOT NULL CHECK (status IN ('intent','succeeded','failed','unknown','cancelled')),
  send_token TEXT, send_count INTEGER NOT NULL DEFAULT 0, started_at TEXT,   -- started_at NULL = queued, provably never sent
  lease_epoch INTEGER,                                                     -- capture calls: plan lease epoch of the sender
  next_attempt_at TEXT,                                                    -- revision 2: retryable back-off (F-TR-3)
  http_status INTEGER, provider_status TEXT, provider_resource_id TEXT, error_code TEXT,
  request_id TEXT, unknown_since TEXT, archived_at TEXT, created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX provider_calls_op ON provider_calls(payment_operation_id, kind);
CREATE INDEX provider_calls_open ON provider_calls(status, started_at) WHERE status IN ('intent','unknown') AND archived_at IS NULL;
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, transmission_id TEXT NOT NULL, merchant_key TEXT NOT NULL,
  event_type TEXT, resource_type TEXT, resource_id TEXT,
  signature_status TEXT NOT NULL CHECK (signature_status IN ('valid','invalid','unverified')),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','duplicate','ignored','flagged','rejected','pending')),
  flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1)), flag_reason TEXT,
  payload_json TEXT,              -- minimized summary {event_type, resource ids, resource status}; never payer data
  payload_sha256 TEXT NOT NULL, received_at TEXT NOT NULL, applied_at TEXT);
CREATE UNIQUE INDEX webhook_valid_once ON webhook_events(transmission_id) WHERE signature_status = 'valid';
CREATE TABLE idempotency_keys (                                  -- revision 2 (F-TR-1): scope (user, key)
  user_id INTEGER NOT NULL, key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,                                       -- sha256(method + ' ' + concrete path + '\n' + canonical body)
  status_code INTEGER NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, key));
