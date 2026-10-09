'use strict';
// The shipped records (the TriageDesk and Groundwork deliveries, the learning-cycle project and the
// toolkit's own record) must keep replaying to their snapshots. Any reducer change that alters the
// replay of existing logs is caught here before it reaches a user's record.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Store } = require('../lib/store');
const { unreviewedChanges } = require('../lib/delivery');

const RECORDS = ['examples/triage-desk', 'examples/groundwork', 'examples/learning-cycle/legacy-project', '.'];

for (const rel of RECORDS) {
  test(`shipped record ${rel}: hash chain intact, snapshot equals replay, approved artifacts unchanged`, () => {
    const root = path.join(__dirname, '..', rel);
    const store = new Store(root);
    const audit = store.audit();
    assert.deepStrictEqual(audit.errors, []);
    assert.ok(audit.events > 0);
    assert.deepStrictEqual(unreviewedChanges(store.rebuild(), root).filter((c) => !c.pending), []);
  });
}

test('the shipped records carry the evidence the reports cite', () => {
  const triage = new Store(path.join(__dirname, '..', 'examples/triage-desk')).state();
  assert.ok(triage.delivery, 'TriageDesk delivered');
  assert.strictEqual(triage.gateOrder.filter((g) => triage.gates[g].status === 'approved').length, 9);
  assert.strictEqual(triage.gates.verification.iterations, 1, 'verification was rejected once (VER-1) before approval');
  assert.strictEqual(triage.rejectedReviews.length, 5, 'five reviews refused by gate rules');

  const groundwork = new Store(path.join(__dirname, '..', 'examples/groundwork'));
  const gw = groundwork.state();
  assert.ok(gw.delivery, 'Groundwork delivered');
  assert.ok(gw.gateOrder.filter((g) => gw.gates[g].status === 'approved').length >= 12, 'the gates of the first delivery stay approved (verification may be reopened for a rework)');
  assert.ok(Object.values(gw.tasks).length >= 17, 'the 17 delivery tasks (plus any later rework)');
  assert.ok(gw.rejectedReviews.length >= 36, 'the engine refused 36 review attempts during the delivery');
  // The operator interventions disclosed in the evidence README are --actor user events in the log.
  const userEvents = groundwork.readEvents().filter((e) => e.actor === 'user');
  assert.ok(userEvents.some((e) => e.type === 'gate.reopened' && e.data.gate === 'verification'), 'verification was reopened by the operator as user');
});
