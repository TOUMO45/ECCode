import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';

const AT = '2026-10-20T06:00:00.000Z';

function seededDb() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(
    'INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, request_id, at) ' +
      "VALUES (1, 1, 'adjust', 1, 0, 1, 0, 'seed', NULL, 'seed', NULL, ?)",
  ).run(AT);
  db.prepare(
    "INSERT INTO audit_events (at, actor_user_id, actor_role, action, entity_type, entity_id, outcome) VALUES (?, NULL, 'system', 'seed.load', 'seed', NULL, 'ok')",
  ).run(AT);
  return db;
}

test('RS-38: UPDATE on inventory_ledger fails because the table is append-only', () => {
  const db = seededDb();
  assert.throws(() => db.exec('UPDATE inventory_ledger SET delta_on_hand = 99'), /inventory_ledger is append-only/);
  assert.throws(() => db.exec("UPDATE inventory_ledger SET actor = 'someone' WHERE id = 1"), /inventory_ledger is append-only/);
  assert.equal(db.prepare('SELECT delta_on_hand FROM inventory_ledger WHERE id = 1').get().delta_on_hand, 1);
  db.close();
});

test('RS-38: DELETE on inventory_ledger fails because the table is append-only', () => {
  const db = seededDb();
  assert.throws(() => db.exec('DELETE FROM inventory_ledger'), /inventory_ledger is append-only/);
  assert.throws(() => db.exec('DELETE FROM inventory_ledger WHERE id = 1'), /inventory_ledger is append-only/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_ledger').get().n, 1);
  db.close();
});

test('RS-38: UPDATE on audit_events fails because the table is append-only', () => {
  const db = seededDb();
  assert.throws(() => db.exec("UPDATE audit_events SET outcome = 'failed'"), /audit_events is append-only/);
  assert.throws(() => db.exec("UPDATE audit_events SET action = 'x' WHERE id = 1"), /audit_events is append-only/);
  assert.equal(db.prepare('SELECT outcome FROM audit_events WHERE id = 1').get().outcome, 'ok');
  db.close();
});

test('RS-38: DELETE on audit_events fails because the table is append-only', () => {
  const db = seededDb();
  assert.throws(() => db.exec('DELETE FROM audit_events'), /audit_events is append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_events WHERE id = 1'), /audit_events is append-only/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 1);
  db.close();
});

test('RS-38: the append-only triggers still allow INSERT and abort inside a transaction without partial effects', () => {
  const db = seededDb();
  db.prepare(
    "INSERT INTO audit_events (at, actor_user_id, actor_role, action, entity_type, entity_id, outcome) VALUES (?, NULL, 'system', 'second', 'seed', NULL, 'denied')",
  ).run(AT);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 2);
  assert.throws(() =>
    db.tx(() => {
      db.prepare(
        "INSERT INTO audit_events (at, actor_user_id, actor_role, action, entity_type, entity_id, outcome) VALUES (?, NULL, 'system', 'third', 'seed', NULL, 'ok')",
      ).run(AT);
      db.exec('DELETE FROM audit_events');
    }),
  /append-only/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 2, 'the whole transaction rolled back');
  db.close();
});

test('RS-38: audit_events rejects an unknown outcome and the ledger rejects an unknown reason or ref type', () => {
  const db = seededDb();
  assert.throws(
    () => db.prepare("INSERT INTO audit_events (at, actor_role, action, entity_type, outcome) VALUES (?, 'system', 'a', 'b', 'maybe')").run(AT),
    /CHECK/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, actor, at) VALUES (1, 1, 'steal', 1, 0, 1, 0, 'seed', 'x', ?)",
        )
        .run(AT),
    /CHECK/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, actor, at) VALUES (1, 1, 'adjust', 1, 0, 1, 0, 'manual', 'x', ?)",
        )
        .run(AT),
    /CHECK/,
  );
  db.close();
});
