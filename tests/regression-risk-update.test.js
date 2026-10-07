'use strict';
// Regression: `eccode risk update --id R --status s` (no --title/--severity/
// --owner) must keep the risk's other fields, and the materialized snapshot
// (state.json) must always equal the state rebuilt by replaying events.jsonl.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('../lib/store');
const { tmpProject } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');

function cli(dir, ...args) {
  return execFileSync(process.execPath, [CLI, '--root', dir, ...args], { encoding: 'utf8' });
}

function snapshot(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.eccode', 'state.json'), 'utf8'));
}

test('risk update with only --status keeps title, severity, mitigation and owner', () => {
  const { dir } = tmpProject();
  cli(dir, 'risk', 'add', '--id', 'RISK-1', '--title', 'Prompt injection', '--severity', 'high', '--mitigation', 'validator', '--owner', 'ai-engineer', '--actor', 'product-architect');
  cli(dir, 'risk', 'update', '--id', 'RISK-1', '--status', 'mitigated', '--actor', 'product-architect');

  const replayed = new Store(dir).rebuild().risks['RISK-1'];
  const materialized = new Store(dir).state().risks['RISK-1'];
  const snap = snapshot(dir).risks['RISK-1'];

  // Discriminator: does replaying the log agree with the snapshot?
  assert.strictEqual(replayed.title, 'Prompt injection', 'replay of events.jsonl lost the title');
  assert.strictEqual(snap.title, 'Prompt injection', 'state.json snapshot lost the title');

  for (const r of [materialized, snap]) {
    assert.strictEqual(r.status, 'mitigated');
    assert.strictEqual(r.title, 'Prompt injection');
    assert.strictEqual(r.severity, 'high');
    assert.strictEqual(r.mitigation, 'validator');
    assert.strictEqual(r.owner, 'ai-engineer');
  }
});

test('materialized state equals the state rebuilt by replaying events.jsonl', () => {
  const { dir } = tmpProject();
  cli(dir, 'risk', 'add', '--id', 'R2', '--title', 'Key leak', '--severity', 'medium', '--owner', 'backend-engineer', '--actor', 'product-architect');
  cli(dir, 'risk', 'update', '--id', 'R2', '--status', 'mitigated', '--actor', 'product-architect');
  // A later partial update must also build on the right base.
  cli(dir, 'risk', 'update', '--id', 'R2', '--mitigation', 'env-only key', '--actor', 'product-architect');

  const store = new Store(dir);
  assert.deepStrictEqual(snapshot(dir), store.rebuild());
  assert.deepStrictEqual(store.state(), store.rebuild());
  assert.strictEqual(store.rebuild().risks.R2.owner, 'backend-engineer');
});

test('Store.commit: in-process reduction matches replay when data contains undefined values (any event type)', () => {
  const { dir } = tmpProject();
  const store = new Store(dir);
  store.commit('risk.recorded', 'product-architect', { id: 'R3', title: 'T', severity: 'low', owner: 'o', status: 'open' });
  const { state } = store.commit('risk.recorded', 'product-architect', { id: 'R3', title: undefined, severity: undefined, owner: undefined, status: 'closed' });
  // The state commit() returns to callers is the same one it persisted.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state)), store.rebuild());
  assert.strictEqual(state.risks.R3.title, 'T');
});
