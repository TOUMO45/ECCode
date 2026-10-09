CREATE TABLE fake_paypal_orders (id TEXT PRIMARY KEY, merchant_key TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CREATED','APPROVED','COMPLETED','VOIDED')), return_url TEXT NOT NULL, cancel_url TEXT NOT NULL,
  approvable INTEGER NOT NULL DEFAULT 1, simulated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE fake_paypal_authorizations (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES fake_paypal_orders(id),
  status TEXT NOT NULL CHECK (status IN ('CREATED','PENDING','DENIED','CAPTURED','VOIDED','EXPIRED')),
  amount_cents INTEGER NOT NULL, expiration_time TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE fake_paypal_captures (id TEXT PRIMARY KEY, authorization_id TEXT NOT NULL REFERENCES fake_paypal_authorizations(id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','PENDING','DECLINED','REFUNDED')), amount_cents INTEGER NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE fake_paypal_refunds (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES fake_paypal_captures(id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','PENDING','FAILED','CANCELLED')), amount_cents INTEGER NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE fake_paypal_requests (merchant_key TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, response_json TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (merchant_key, request_id));       -- PayPal-Request-Id replay model
CREATE TABLE fake_paypal_calls (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, merchant_key TEXT NOT NULL, request_id TEXT,
  resource_id TEXT, replayed INTEGER NOT NULL DEFAULT 0, pid INTEGER NOT NULL, at TEXT NOT NULL);  -- call counting (RS-20, ARCH-26)
CREATE TABLE fault_flags (name TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', remaining INTEGER, created_at TEXT NOT NULL);
