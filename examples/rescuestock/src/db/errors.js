// Maps node:sqlite errors to typed errors.
//   SQLITE_BUSY / SQLITE_LOCKED -> AppError(503, DB_BUSY) with Retry-After: 1
//   SQLITE_CONSTRAINT           -> DbConstraintError (kind: unique, primary_key, check, foreign_key, not_null, trigger)
// Anything else is returned unchanged. The mapped errors never carry SQL text.
import { AppError } from '../http/envelope.js';

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CONSTRAINT = 19;

const CONSTRAINT_KINDS = new Map([
  [275, 'check'],
  [787, 'foreign_key'],
  [1299, 'not_null'],
  [1555, 'primary_key'],
  [1811, 'trigger'],
  [2067, 'unique'],
]);

export class DbConstraintError extends Error {
  constructor(kind, cause) {
    super(`Database constraint violated (${kind}).`);
    this.name = 'DbConstraintError';
    this.code = 'DB_CONSTRAINT';
    this.kind = kind;
    this.sqliteCode = cause && Number.isInteger(cause.errcode) ? cause.errcode : null;
    this.cause = cause;
  }
}

export function sqliteErrorCode(err) {
  if (!err || err.code !== 'ERR_SQLITE_ERROR' || !Number.isInteger(err.errcode)) return null;
  return err.errcode;
}

export function isBusyError(err) {
  const code = sqliteErrorCode(err);
  return code !== null && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED);
}

export function isConstraintError(err) {
  const code = sqliteErrorCode(err);
  return code !== null && (code & 0xff) === SQLITE_CONSTRAINT;
}

export function dbBusyError() {
  return new AppError(503, 'DB_BUSY', { headers: { 'Retry-After': '1' } });
}

export function mapDbError(err) {
  if (err instanceof AppError || err instanceof DbConstraintError) return err;
  if (isBusyError(err)) return dbBusyError();
  if (isConstraintError(err)) {
    return new DbConstraintError(CONSTRAINT_KINDS.get(err.errcode) || 'other', err);
  }
  return err;
}
