// RS-36 (schema half, task c2-requests-plans-view): the rescue status is derived on read and stored nowhere.
//   * no table has a column named like a rescue status;
//   * rescue_requests has no `status` column (its `intake_status` is not a rescue status and only allows
//     draft / extracted / confirmed);
//   * no value of any derived status is allowed by a CHECK on any column;
//   * after a request has gone through requirements and planning, no stored cell equals a derived status;
//   * no source file writes a column named like a rescue status.
// Reads the migrated schema and the source tree; the live endpoint is covered in rescue-status.test.js.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { ROW_STATUS } from '../../src/domain/derive.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DERIVED = [...new Set(Object.values(ROW_STATUS))];
// Names that would store a rescue status: anything with "rescue" and "status", in either order.
const LOOKS_LIKE_RESCUE_STATUS = /rescue.*status|status.*rescue/i;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (path.endsWith('.js') || path.endsWith('.sql')) files.push(path);
  }
  return files;
}

describe('RS-36: no column stores the rescue status', () => {
  let h;
  before(async () => {
    h = await startHarness({ seed: true });
  });
  after(() => h.close());

  const tables = () => h.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const columns = (table) => h.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);

  test('RS-36: no table or column is named like a rescue status', () => {
    const all = tables();
    assert.ok(all.length >= 25, 'the migrated schema is present');
    for (const table of all) {
      assert.doesNotMatch(table.name, LOOKS_LIKE_RESCUE_STATUS, `table ${table.name}`);
      for (const column of columns(table.name)) assert.doesNotMatch(column, LOOKS_LIKE_RESCUE_STATUS, `${table.name}.${column}`);
    }
  });

  test('RS-36: rescue_requests has no status column; its intake_status only allows draft, extracted, confirmed', () => {
    const cols = columns('rescue_requests');
    assert.ok(!cols.includes('status'));
    assert.ok(cols.includes('intake_status'));
    const ddl = tables().find((t) => t.name === 'rescue_requests').sql;
    const check = /intake_status\s+TEXT\s+NOT NULL\s+CHECK\s*\(intake_status IN \(([^)]*)\)\)/.exec(ddl);
    assert.ok(check, 'intake_status has an IN-list CHECK');
    assert.deepEqual(check[1].split(',').map((v) => v.trim().replaceAll("'", '')), ['draft', 'extracted', 'confirmed']);
  });

  test('RS-36: the persisted state machines are separate columns (plan, reservation, payment, fulfilment) and none allows a derived status value', () => {
    const wanted = { plan_versions: 'status', reservations: 'status', payment_operations: 'status', supplier_orders: 'fulfilment_status' };
    for (const [table, column] of Object.entries(wanted)) assert.ok(columns(table).includes(column), `${table}.${column}`);
    // `cancelled` and `collected` are also legitimate fulfilment-machine values, so only the other derived words are tested.
    const derivedOnly = DERIVED.filter((s) => !['cancelled', 'collected'].includes(s));
    for (const table of tables()) {
      for (const status of derivedOnly) {
        assert.ok(!new RegExp(`CHECK[^;]*'${status}'`).test(table.sql.replaceAll('\n', ' ')), `${table.name} allows the derived status ${status}`);
      }
    }
  });

  test('RS-36: after requirements and planning no stored cell equals a derived status', async () => {
    const client = createClient(h.request);
    await client.signIn('cafe1', DEMO_PASSWORD);
    const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids.' });
    const id = created.json.request.id;
    await client.post(`/api/requests/${id}/confirm`, {
      fields: { productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90, material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2 },
    });
    const planned = await client.post(`/api/requests/${id}/plan`, {});
    assert.equal(planned.status, 201);
    const view = await client.get(`/api/requests/${id}`);
    assert.equal(view.json.rescueStatus.status, 'plan_found');
    const derived = new Set(DERIVED);
    for (const table of tables()) {
      for (const row of h.db.prepare(`SELECT * FROM ${table.name}`).all()) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== 'string') continue;
          // `cancelled` is a legitimate fulfilment value and `collected` a legitimate fulfilment/plan word; only columns that
          // are not state-machine columns are held to "no derived status".
          if (['status', 'fulfilment_status', 'prev_status'].includes(column)) continue;
          assert.ok(!derived.has(value), `${table.name}.${column} holds the derived status ${value}`);
        }
      }
    }
  });
});

describe('RS-36: no source file stores a rescue status', () => {
  test('RS-36: no SQL or code under src/ names a stored rescue-status column, and the service code reads status through derive.js', () => {
    const offenders = [];
    for (const file of walk(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (/rescue_status/i.test(text) || /\bstatus\s*=\s*\?[^;]*rescue/i.test(text)) offenders.push(file.slice(ROOT.length + 1));
    }
    assert.deepEqual(offenders, []);
    const view = readFileSync(join(ROOT, 'src', 'services', 'view.js'), 'utf8');
    assert.match(view, /deriveRescueStatus\(/);
    for (const writer of ['requests.js', 'plans.js']) {
      const text = readFileSync(join(ROOT, 'src', 'services', writer), 'utf8');
      assert.doesNotMatch(text, /UPDATE\s+rescue_requests\s+SET\s+[^;']*status\s*=\s*\?/i, `${writer} must not write a status into rescue_requests from a variable`);
    }
  });
});
