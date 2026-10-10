// User lookups, customer registration and the admin bootstrap (SEC-5).
import { randomBytes } from 'node:crypto';
import { isoFromMs } from '../clock.js';
import { DbConstraintError, mapDbError } from '../db/errors.js';
import { AppError } from '../http/envelope.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

export const ADMIN_USERNAME = 'admin';

const USER_SELECT = `
  SELECT u.id, u.username, u.password_hash, u.role, u.display_name, u.disabled, u.supplier_id, sup.code AS supplier_code
    FROM users u LEFT JOIN suppliers sup ON sup.id = u.supplier_id`;

// The User object of the API contract.
export function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? user.display_name,
    role: user.role,
    supplierCode: user.supplierCode ?? user.supplier_code ?? null,
  };
}

// The lookup column is COLLATE NOCASE, so the lower-cased key matches the stored username (SEC-9).
export function findByUsernameKey(db, key) {
  return db.prepare(`${USER_SELECT} WHERE u.username = ?`).get(key) ?? null;
}

export function findById(db, id) {
  return db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) ?? null;
}

// Inserts a customer. The role is fixed here; nothing from the request can choose it.
// A taken username (case-insensitive) is 409 USERNAME_TAKEN.
export function createCustomer(db, clock, { username, passwordHash, displayName }) {
  try {
    const result = db
      .prepare(
        "INSERT INTO users (username, password_hash, role, supplier_id, display_name, disabled, demo, created_at) VALUES (?, ?, 'customer', NULL, ?, 0, 0, ?)",
      )
      .run(username, passwordHash, displayName, isoFromMs(clock.now()));
    return Number(result.lastInsertRowid);
  } catch (err) {
    const mapped = mapDbError(err);
    if (mapped instanceof DbConstraintError && mapped.kind === 'unique') throw new AppError(409, 'USERNAME_TAKEN');
    throw mapped;
  }
}

// Disabling a user deletes their sessions.
export function disableUser(db, userId) {
  return db.tx(() => {
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId);
    return Number(db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes);
  });
}

// Creates or updates the admin account from RS_ADMIN_PASSWORD (a Secret, already checked for length and
// placeholders by config), and disables it when the variable is unset. The value is never logged.
// Returns 'created' | 'updated' | 'unchanged' | 'disabled'.
export async function ensureAdmin({ db, config, clock }) {
  const secret = config.adminPassword;
  const existing = () => db.prepare('SELECT id, role, password_hash, disabled FROM users WHERE username = ?').get(ADMIN_USERNAME);
  const now = () => isoFromMs(clock.now());
  const before = existing();
  if (before && before.role !== 'admin') {
    // A non-admin already owns the name. Refuse rather than promote it.
    throw new Error('The username "admin" belongs to a non-admin account; startup refused.');
  }

  if (!secret) {
    if (!before) {
      // A disabled admin row with a hash nobody knows keeps the name reserved.
      const unusable = await hashPassword(randomBytes(32).toString('base64url'));
      db.prepare(
        "INSERT OR IGNORE INTO users (username, password_hash, role, supplier_id, display_name, disabled, demo, created_at) VALUES (?, ?, 'admin', NULL, 'Administrator', 1, 0, ?)",
      ).run(ADMIN_USERNAME, unusable, now());
      return 'disabled';
    }
    if (before.disabled !== 1) disableUser(db, before.id);
    return 'disabled';
  }

  const password = secret.reveal();
  if (before && before.disabled === 0 && (await verifyPassword(password, before.password_hash))) return 'unchanged';
  const hash = await hashPassword(password);
  return db.tx(() => {
    const row = existing();
    if (row && row.role !== 'admin') throw new Error('The username "admin" belongs to a non-admin account; startup refused.');
    if (!row) {
      db.prepare(
        "INSERT INTO users (username, password_hash, role, supplier_id, display_name, disabled, demo, created_at) VALUES (?, ?, 'admin', NULL, 'Administrator', 0, 0, ?)",
      ).run(ADMIN_USERNAME, hash, now());
      return 'created';
    }
    db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?').run(hash, row.id);
    // A changed password ends every session of the account.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    return 'updated';
  });
}
