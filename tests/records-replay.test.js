'use strict';
// The shipped records (the TriageDesk delivery, the learning-cycle project
// and the toolkit's own record) must keep replaying to their snapshots. Any
// reducer change that alters the replay of existing logs is caught here
// before it reaches a user's record.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Store } = require('../lib/store');
const { unreviewedChanges } = require('../lib/delivery');

const RECORDS = ['examples/triage-desk', 'examples/learning-cycle/legacy-project', '.'];

for (const rel of RECORDS) {
  test(`shipped record ${rel}: hash chain intact, snapshot equals replay, approved artifacts unchanged`, () => {
    const root = path.join(__dirname, '..', rel);
    const store = new Store(root);
    const audit = store.audit();
    assert.deepStrictEqual(audit.errors, []);
    assert.ok(audit.events > 0);
    assert.deepStrictEqual(unreviewedChanges(store.state(), root).filter((c) => !c.pending), []);
  });
}

test('the TriageDesk record carries the evidence the final report cites', () => {
  const state = new Store(path.join(__dirname, '..', 'examples/triage-desk')).state();
  assert.ok(state.delivery, 'delivered');
  assert.strictEqual(state.gateOrder.filter((g) => state.gates[g].status === 'approved').length, 9);
  assert.strictEqual(state.gates.verification.iterations, 1, 'verification was rejected once (VER-1) before approval');
  assert.strictEqual(state.rejectedReviews.length, 5, 'five reviews refused by gate rules');
  assert.ok(Object.values(state.evidence).filter((e) => e.kind === 'command' && e.status === 'failed').length >= 30, 'failing checks stay on record');
});
