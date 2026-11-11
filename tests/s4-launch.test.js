'use strict';
// Plan 3.1: an arm sees its own workspace, the toolchain and the network, and nothing else of the experiment.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const op = require('../tools/s4-operator');
const launch = require('../tools/s4-launch');

const REPO = path.join(__dirname, '..');
const HAVE_BWRAP = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;
const skip = HAVE_BWRAP ? false : 'needs a working bubblewrap';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 's4-launch-'));

test('probe: the arm can write its workspace and cannot see the checkout, the prompt record, a sibling arm or a named secret', { skip }, () => {
  const out = tmp();
  const a = op.prepare({ arm: 'a', out, repo: REPO });
  // a second arm directory beside it, and a stand-in for the hidden material
  fs.mkdirSync(path.join(out, 'arm-b', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(out, 'arm-b', 'workspace', 'solution.py'), 'x');
  const hidden = path.join(tmp(), 'hidden-suite');
  fs.mkdirSync(hidden);
  const res = launch.probe(a.runDir, { deny: [hidden] });
  assert.deepStrictEqual(res.visible, []);
  assert.deepStrictEqual(res.checks, { ran: true, workspaceWritable: true, systemReadOnly: true, deniedPathsInvisible: true, noStrayEnvironment: true, toolchain: true });
  assert.strictEqual(res.ok, true);
  assert.ok(res.denied.includes(REPO) && res.denied.includes(path.join(out, 'arm-b')) && res.denied.includes(hidden));
  assert.ok(!fs.existsSync(path.join(a.workspace, '.s4-canary')), 'the canary file is removed');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(a.runDir, 'sandbox-probe.json'), 'utf8')).ok, true);
});

test('probe fails closed: a path the sandbox does expose is reported, and the probe is not ok', { skip }, () => {
  const a = op.prepare({ arm: 'a', out: tmp(), repo: REPO });
  const res = launch.probe(a.runDir, { deny: ['/usr/bin'] });
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.visible, ['/usr/bin']);
});

test('the operator environment does not leak in: only the named variables pass, and their values are never printed', { skip }, () => {
  const a = op.prepare({ arm: 'a', out: tmp(), repo: REPO });
  const env = { ...process.env, OPERATOR_PRIVATE: 'do-not-leak', ANTHROPIC_API_KEY: 'test-value-123' };
  const res = launch.probe(a.runDir, { env });
  assert.strictEqual(res.checks.noStrayEnvironment, true);
  const sb = launch.sandboxArgv(a.runDir, ['true'], env);
  assert.ok(!sb.args.includes('do-not-leak'));
  assert.ok(sb.args.includes('test-value-123'), 'the key reaches the arm');
  assert.ok(!JSON.stringify(launch.redact(sb.args)).includes('test-value-123'), 'and is hidden wherever the command is recorded');
});

test('start refuses without the owner flag, without a passing probe, and never runs an arm twice', { skip }, () => {
  const a = op.prepare({ arm: 'a', out: tmp(), repo: REPO });
  assert.throws(() => launch.start(a.runDir, {}), /needs --approved-by-owner/);
  assert.throws(() => launch.start(a.runDir, { approved: true }), /no passing sandbox probe/);
  launch.probe(a.runDir, { deny: ['/usr/bin'] }); // a failing probe is not enough
  assert.throws(() => launch.start(a.runDir, { approved: true }), /no passing sandbox probe/);
  fs.writeFileSync(path.join(a.runDir, 'started.json'), '{}');
  launch.probe(a.runDir);
  assert.throws(() => launch.start(a.runDir, { approved: true }), /already started/);
});

test('print shows the model command inside the sandbox with the prompt on stdin', () => {
  const a = op.prepare({ arm: 'a', out: tmp(), repo: REPO });
  const { sb, promptFile } = launch.startCommand(a.runDir);
  const tail = sb.args.slice(sb.args.indexOf('--') + 1);
  assert.deepStrictEqual(tail, ['claude', '-p', '--model', 'claude-opus-5-5', '--permission-mode', 'bypassPermissions']);
  assert.strictEqual(promptFile, path.join(a.runDir, 'prompt.md'));
  assert.ok(sb.args.includes('--clearenv') && sb.args.includes('--unshare-pid'));
});
