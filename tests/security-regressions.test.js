'use strict';
// Regression tests for the independent security review (findings #1–#22).
// Each test reproduces a defect that the engine used to accept; the finding
// number is in the test name. Guard-hook findings live in hooks-install.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Store } = require('../lib/store');
const runs = require('../lib/runs');
const util = require('../lib/util');
const { tmpProject, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');

function cli(dir, args, env = {}) {
  return spawnSync(process.execPath, [BIN, '--root', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function risk(store, id) {
  return runs.recordRisk(store, 'delivery-lead', { id, title: `risk ${id}`, severity: 'low' });
}

// ---------------------------------------------------------------- #4 torn line

test('#4 a torn final line is repaired before the next append, so the log never becomes permanently corrupt', () => {
  const ctx = tmpProject();
  const log = path.join(ctx.dir, '.eccode/events.jsonl');
  fs.appendFileSync(log, '{"seq": 2, "trunc'); // process died mid-append
  risk(ctx.store, 'R1');
  risk(ctx.store, 'R2');
  const fresh = new Store(ctx.dir);
  const st = fresh.state();
  assert.deepStrictEqual(Object.keys(st.risks).sort(), ['R1', 'R2']);
  assert.strictEqual(fresh.audit().ok, true, JSON.stringify(fresh.audit().errors));
  assert.ok(!fs.readFileSync(log, 'utf8').includes('trunc'), 'the torn fragment is dropped');
});

test('#4 a complete final event that only lost its newline is kept', () => {
  const ctx = tmpProject();
  risk(ctx.store, 'R1');
  const log = path.join(ctx.dir, '.eccode/events.jsonl');
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace(/\n$/, ''));
  risk(ctx.store, 'R2');
  const st = new Store(ctx.dir).state();
  assert.deepStrictEqual(Object.keys(st.risks).sort(), ['R1', 'R2']);
  assert.strictEqual(ctx.store.audit().ok, true);
});

// ------------------------------------------------------------ #5 log rollback

test('#5 a log rolled back behind its snapshot is refused (LOG_ROLLBACK) until the user accepts it', () => {
  const ctx = tmpProject();
  const log = path.join(ctx.dir, '.eccode/events.jsonl');
  risk(ctx.store, 'R1');
  const older = fs.readFileSync(log, 'utf8');
  risk(ctx.store, 'R2');
  risk(ctx.store, 'R3');
  fs.writeFileSync(log, older); // e.g. `git checkout -- .eccode/events.jsonl`
  expectCode(() => ctx.store.state(), 'LOG_ROLLBACK');
  expectCode(() => risk(ctx.store, 'R4'), 'LOG_ROLLBACK');
  expectCode(() => ctx.store.rebuildSnapshot(), 'LOG_ROLLBACK');
  let res = cli(ctx.dir, ['audit']);
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /rolled back|behind/i);
  res = cli(ctx.dir, ['rebuild', '--force', '--actor', 'orchestrator']);
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /USER_AUTH_REQUIRED/);
  res = cli(ctx.dir, ['rebuild', '--force', '--actor', 'user']);
  assert.strictEqual(res.status, 0, res.stderr);
  const st = ctx.store.state();
  assert.deepStrictEqual(Object.keys(st.risks), ['R1']);
  const last = ctx.store.readEvents().pop();
  assert.strictEqual(last.type, 'record.rollback_accepted');
  assert.strictEqual(last.actor, 'user');
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('#5 a log replaced by a different history is refused; a snapshot that is merely behind is still rebuilt', () => {
  const a = tmpProject();
  const b = tmpProject();
  for (const id of ['R1', 'R2', 'R3']) risk(b.store, id);
  risk(a.store, 'A1');
  fs.copyFileSync(path.join(b.dir, '.eccode/events.jsonl'), path.join(a.dir, '.eccode/events.jsonl'));
  expectCode(() => a.store.state(), 'LOG_ROLLBACK');

  // Crash between append and snapshot write: snapshot behind, same history.
  const snapFile = path.join(b.dir, '.eccode/state.json');
  const behind = fs.readFileSync(snapFile, 'utf8');
  risk(b.store, 'R4');
  fs.writeFileSync(snapFile, behind);
  assert.ok(b.store.state().risks.R4);
});

// ----------------------------------------------------------- #9 ECCODE_NOW

test('#9 ECCODE_NOW is honoured only when ECCODE_TEST=1', () => {
  const saved = { now: process.env.ECCODE_NOW, test: process.env.ECCODE_TEST };
  try {
    process.env.ECCODE_NOW = '2099-01-01T00:00:00.000Z';
    delete process.env.ECCODE_TEST;
    assert.notStrictEqual(util.now().getUTCFullYear(), 2099);
    process.env.ECCODE_TEST = '1';
    assert.strictEqual(util.now().getUTCFullYear(), 2099);
  } finally {
    for (const [k, v] of [['ECCODE_NOW', saved.now], ['ECCODE_TEST', saved.test]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const ctx = tmpProject();
  const env = { ...process.env, ECCODE_NOW: '2099-01-01T00:00:00Z' };
  delete env.ECCODE_TEST;
  const res = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'evidence', 'run', '--actor', 'backend-engineer', '--label', 'pre', '--json', '--', 'true'], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, res.stderr);
  const ev = ctx.store.state().evidence[JSON.parse(res.stdout).id];
  assert.ok(!ev.at.startsWith('2099'), `forged timestamp recorded: ${ev.at}`);
});

test('#9 audit reports event timestamps that go backwards', () => {
  const ctx = tmpProject();
  const saved = { now: process.env.ECCODE_NOW, test: process.env.ECCODE_TEST };
  try {
    process.env.ECCODE_TEST = '1';
    process.env.ECCODE_NOW = '2099-01-01T00:00:00.000Z';
    risk(ctx.store, 'R1');
  } finally {
    for (const [k, v] of [['ECCODE_NOW', saved.now], ['ECCODE_TEST', saved.test]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  risk(ctx.store, 'R2');
  const res = ctx.store.audit();
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join('\n'), /timestamp goes backwards/);
});
