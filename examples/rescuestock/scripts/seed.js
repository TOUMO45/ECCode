// Loads the RS-FIX-1 demo data: suppliers A-E (demo), one bundle product, one
// active offer and one unit of stock each, ledger rows, and the seven demo
// accounts supplier-a..e, cafe1, cafe2. `npm run seed` runs it.
//
// Passwords (SEC-5): with RS_DEMO_PASSWORD set (>= 12 chars, not a placeholder)
// all seven accounts share it. Otherwise each account gets its own random
// password, printed once to the terminal and never written to the log.
//
// Ready times are local Asia/Amman times on RS_DEMO_DATE, converted to UTC with
// Intl (no constant offset). Password hashes are scrypt: see hashPassword.
import { randomBytes, scryptSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DEMO_TIME_ZONE, isoFromMs, systemClock, zonedTimeToUtcMs } from '../src/clock.js';

// RS-FIX-1 (brief > Canonical fixture). Prices are in cents. "Test prices, not market prices."
export const RS_FIX_1 = Object.freeze({
  timeZone: DEMO_TIME_ZONE,
  suppliers: Object.freeze([
    { code: 'A', cups: 100, lids: 100, lidDiameterMm: 90, priceCents: 3000, prepFeeCents: 1000, ready: '10:00' },
    { code: 'B', cups: 100, lids: 100, lidDiameterMm: 90, priceCents: 3600, prepFeeCents: 800, ready: '10:30' },
    { code: 'C', cups: 200, lids: 200, lidDiameterMm: 95, priceCents: 4800, prepFeeCents: 500, ready: '10:00' },
    { code: 'D', cups: 200, lids: 200, lidDiameterMm: 90, priceCents: 6800, prepFeeCents: 1200, ready: '11:20' },
    { code: 'E', cups: 100, lids: 100, lidDiameterMm: 90, priceCents: 4500, prepFeeCents: 1000, ready: '10:40' },
  ]),
  capacityMl: 250,
  cupDiameterMm: 90,
  onHand: 1,
  reserved: 0,
  customers: Object.freeze(['cafe1', 'cafe2']),
});

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLen: 64, saltLen: 16 });

// scrypt$N$r$p$<salt base64url>$<key base64url>, N=16384 r=8 p=1, 64-byte key.
export function hashPassword(password) {
  const salt = randomBytes(SCRYPT.saltLen);
  const key = scryptSync(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function demoAccounts() {
  return [
    ...RS_FIX_1.suppliers.map((s) => ({
      username: `supplier-${s.code.toLowerCase()}`,
      displayName: `Supplier ${s.code} (demo)`,
      role: 'supplier',
      supplierCode: s.code,
    })),
    ...RS_FIX_1.customers.map((name, i) => ({
      username: name,
      displayName: `Cafe ${i + 1} (demo)`,
      role: 'customer',
      supplierCode: null,
    })),
  ];
}

function generatePassword() {
  return randomBytes(12).toString('base64url');
}

// Seeds the database inside one transaction. Returns
//   { seeded: boolean, credentials: [{username, password, shared}] }
// `credentials` is for the terminal only. When the data is already there nothing changes.
export function seedDatabase(db, { clock = systemClock, demoDate, demoPassword = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(demoDate))) throw new TypeError('seedDatabase needs demoDate as YYYY-MM-DD');
  if (demoPassword !== null && (typeof demoPassword !== 'string' || demoPassword.length === 0)) {
    throw new TypeError('demoPassword must be a non-empty string or null');
  }

  const accounts = demoAccounts();
  const credentials = accounts.map((a) => ({
    username: a.username,
    password: demoPassword ?? generatePassword(),
    shared: demoPassword !== null,
  }));
  const hashes = credentials.map((c) => hashPassword(c.password));
  const now = isoFromMs(clock.now());

  const seeded = db.tx(() => {
    const existing = db.prepare("SELECT COUNT(*) AS n FROM suppliers WHERE code GLOB '[A-E]'").get();
    if (existing.n > 0) return false;

    const insertSupplier = db.prepare(
      'INSERT INTO suppliers (code, name, pickup_address, paypal_merchant_key, demo, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    );
    const insertProduct = db.prepare(
      'INSERT INTO products (supplier_id, kind, name, capacity_ml, diameter_mm, material, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    );
    const insertItem = db.prepare('INSERT INTO bundle_items (bundle_product_id, item_product_id, qty) VALUES (?, ?, ?)');
    const insertOffer = db.prepare(
      'INSERT INTO offers (supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from, valid_to, demo) ' +
        "VALUES (?, ?, ?, ?, ?, 1, 'active', ?, NULL, 1)",
    );
    const insertStock = db.prepare(
      'INSERT INTO inventory (product_id, supplier_id, on_hand, reserved, version, demo) VALUES (?, ?, ?, ?, 1, 1)',
    );
    const insertLedger = db.prepare(
      'INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, request_id, at) ' +
        "VALUES (?, ?, 'adjust', ?, ?, ?, ?, 'seed', NULL, 'seed', NULL, ?)",
    );

    const supplierIds = new Map();
    for (const s of RS_FIX_1.suppliers) {
      const supplier = insertSupplier.run(
        s.code,
        `Demo Supplier ${s.code}`,
        `Demo pickup point ${s.code}, Amman (test data)`,
        s.code,
        now,
      );
      const supplierId = Number(supplier.lastInsertRowid);
      supplierIds.set(s.code, supplierId);

      const cup = Number(
        insertProduct.run(supplierId, 'cup', `Supplier ${s.code} paper cup ${RS_FIX_1.capacityMl} ml, ${RS_FIX_1.cupDiameterMm} mm`,
          RS_FIX_1.capacityMl, RS_FIX_1.cupDiameterMm, 'paper', now).lastInsertRowid,
      );
      const lid = Number(
        insertProduct.run(supplierId, 'lid', `Supplier ${s.code} lid ${s.lidDiameterMm} mm`, null, s.lidDiameterMm, 'plastic', now)
          .lastInsertRowid,
      );
      const bundle = Number(
        insertProduct.run(supplierId, 'bundle', `Supplier ${s.code} bundle: ${s.cups} cups + ${s.lids} lids`,
          RS_FIX_1.capacityMl, RS_FIX_1.cupDiameterMm, 'paper', now).lastInsertRowid,
      );
      insertItem.run(bundle, cup, s.cups);
      insertItem.run(bundle, lid, s.lids);

      const readyAt = isoFromMs(zonedTimeToUtcMs(demoDate, s.ready, RS_FIX_1.timeZone));
      insertOffer.run(supplierId, bundle, s.priceCents, s.prepFeeCents, readyAt, now);
      insertStock.run(bundle, supplierId, RS_FIX_1.onHand, RS_FIX_1.reserved);
      insertLedger.run(supplierId, bundle, RS_FIX_1.onHand, RS_FIX_1.reserved, RS_FIX_1.onHand, RS_FIX_1.reserved, now);
    }

    const insertUser = db.prepare(
      'INSERT INTO users (username, password_hash, role, supplier_id, display_name, disabled, demo, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)',
    );
    accounts.forEach((a, i) => {
      insertUser.run(a.username, hashes[i], a.role, a.supplierCode ? supplierIds.get(a.supplierCode) : null, a.displayName, now);
    });

    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'demo_date',
      demoDate,
    );
    db.prepare(
      'INSERT INTO audit_events (at, actor_user_id, actor_role, action, entity_type, entity_id, outcome, detail_json, request_id) ' +
        "VALUES (?, NULL, 'system', 'seed.load', 'seed', NULL, 'ok', ?, NULL)",
    ).run(now, JSON.stringify({ suppliers: RS_FIX_1.suppliers.length, users: accounts.length }));
    return true;
  });

  return { seeded, credentials: seeded ? credentials : [] };
}

function printCredentials(result, config, out) {
  if (!result.seeded) {
    out.write('Demo data is already loaded; nothing was changed. To start over, stop the app and delete the database file.\n');
    return;
  }
  out.write(`Loaded RS-FIX-1 for ${config.demoDate}: suppliers A-E, one bundle each, and ${result.credentials.length} demo accounts.\n`);
  if (config.demoPassword) {
    out.write('All demo accounts share the password in RS_DEMO_PASSWORD:\n');
    for (const c of result.credentials) out.write(`  ${c.username}\n`);
    return;
  }
  out.write('RS_DEMO_PASSWORD is not set, so each account has its own random password. They are shown once and not stored anywhere:\n');
  const width = Math.max(...result.credentials.map((c) => c.username.length));
  for (const c of result.credentials) out.write(`  ${c.username.padEnd(width)}  ${c.password}\n`);
}

async function run() {
  // Loaded here so that importing this file for its functions stays light.
  const { loadConfig, ConfigError } = await import('../src/config.js');
  const { openDb } = await import('../src/db/connection.js');
  const { migrate } = await import('../src/db/migrate.js');
  const { ensureRuntimeDirs } = await import('../src/main.js');

  process.umask(0o077);
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Seed refused to run. ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  ensureRuntimeDirs(config);
  const db = openDb(config.dbPath, { busyTimeoutMs: config.dbBusyTimeoutMs });
  try {
    migrate(db);
    const result = seedDatabase(db, {
      demoDate: config.demoDate,
      demoPassword: config.demoPassword ? config.demoPassword.reveal() : null,
    });
    printCredentials(result, config, process.stdout);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
