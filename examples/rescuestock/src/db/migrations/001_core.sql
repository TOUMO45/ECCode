CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- csrf_key, demo_date
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE CHECK (code GLOB '[A-Z]'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80), pickup_address TEXT NOT NULL CHECK (length(pickup_address) <= 200),
  paypal_merchant_key TEXT NOT NULL CHECK (paypal_merchant_key GLOB '[A-Z0-9_]*' AND length(paypal_merchant_key) BETWEEN 1 AND 20),
  demo INTEGER NOT NULL DEFAULT 1 CHECK (demo IN (0,1)), created_at TEXT NOT NULL);
CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 3 AND 40),
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('customer','supplier','admin')),
  supplier_id INTEGER REFERENCES suppliers(id), display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)), demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at TEXT NOT NULL, CHECK ((role = 'supplier') = (supplier_id IS NOT NULL)));
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE login_failures (id INTEGER PRIMARY KEY, username_key TEXT NOT NULL, ip TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX login_failures_user ON login_failures(username_key, at);
CREATE INDEX login_failures_ip ON login_failures(ip, at);
CREATE TABLE products (
  id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  kind TEXT NOT NULL CHECK (kind IN ('cup','lid','bundle')), name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  capacity_ml INTEGER CHECK (capacity_ml IS NULL OR capacity_ml BETWEEN 1 AND 5000),
  diameter_mm INTEGER CHECK (diameter_mm IS NULL OR diameter_mm BETWEEN 1 AND 500),
  material TEXT CHECK (material IS NULL OR material IN ('paper','plastic','other')),
  demo INTEGER NOT NULL DEFAULT 1 CHECK (demo IN (0,1)), created_at TEXT NOT NULL);
CREATE INDEX products_supplier ON products(supplier_id);
CREATE TABLE bundle_items (
  bundle_product_id INTEGER NOT NULL REFERENCES products(id), item_product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty > 0), PRIMARY KEY (bundle_product_id, item_product_id));
CREATE TABLE compatibility (
  cup_product_id INTEGER NOT NULL REFERENCES products(id), lid_product_id INTEGER NOT NULL REFERENCES products(id),
  confirmed_by INTEGER REFERENCES users(id), confirmed_at TEXT NOT NULL, PRIMARY KEY (cup_product_id, lid_product_id));
CREATE TABLE offers (
  id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), product_id INTEGER NOT NULL REFERENCES products(id),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0), prep_fee_cents INTEGER NOT NULL CHECK (prep_fee_cents >= 0),
  ready_at TEXT NOT NULL, version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active','withdrawn','replaced')),
  valid_from TEXT NOT NULL, valid_to TEXT, demo INTEGER NOT NULL DEFAULT 1 CHECK (demo IN (0,1)),
  UNIQUE (product_id, version));
CREATE UNIQUE INDEX offers_one_current ON offers(product_id) WHERE status IN ('active','withdrawn');
CREATE TABLE inventory (
  product_id INTEGER PRIMARY KEY REFERENCES products(id), supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  on_hand INTEGER NOT NULL CHECK (on_hand >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 1 CHECK (demo IN (0,1)),
  CHECK (reserved <= on_hand));
CREATE TABLE inventory_ledger (
  id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('reserve','release','expire','consume','restock','adjust')),
  delta_on_hand INTEGER NOT NULL, delta_reserved INTEGER NOT NULL, on_hand_after INTEGER NOT NULL, reserved_after INTEGER NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('reservation','supplier_patch','admin_reset','seed')), ref_id INTEGER,
  actor TEXT NOT NULL, request_id TEXT, at TEXT NOT NULL);
CREATE INDEX inventory_ledger_ref ON inventory_ledger(ref_type, ref_id);
CREATE TRIGGER inventory_ledger_no_update BEFORE UPDATE ON inventory_ledger BEGIN SELECT RAISE(ABORT, 'inventory_ledger is append-only'); END;
CREATE TRIGGER inventory_ledger_no_delete BEFORE DELETE ON inventory_ledger BEGIN SELECT RAISE(ABORT, 'inventory_ledger is append-only'); END;
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor_user_id INTEGER, actor_role TEXT NOT NULL,   -- 'system' for reconciler
  action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','failed')),
  detail_json TEXT NOT NULL DEFAULT '{}', request_id TEXT);
CREATE INDEX audit_entity ON audit_events(entity_type, entity_id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
