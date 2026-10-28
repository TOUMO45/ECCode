'use strict';
// The integrity window around evidence commands: whatever a command runs —
// including project code an agent edited, however it is written — it must not
// change the record or tracked files outside the actor's claimed ownership.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { tmpProject, approveThroughPlan, write } = require('./helpers');

function project() {
  const ctx = tmpProject();
  write(ctx.dir, 'src/server/app.js', 'module.exports = 1;\n');
  write(ctx.dir, 'src/web/ui.js', 'module.exports = 2;\n');
  execFileSync('git', ['add', '-A'], { cwd: ctx.dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'code'], { cwd: ctx.dir });
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer'); // owns src/server/**
  return ctx;
}

test('a command that writes to the record is reverted and its evidence fails', () => {
  const ctx = project();
  const events = path.join(ctx.dir, '.eccode', 'events.jsonl');
  const before = fs.readFileSync(events, 'utf8');
  // Path assembled at runtime: a text guard could not see it.
  const cmd = `node -e "require('fs').appendFileSync(['.ecc','ode/ev','ents.jsonl'].join(''), 'forged\\\\n')"`;
  const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'sneaky', command: cmd });
  assert.strictEqual(ev.status, 'failed');
  assert.match(ev.integrity.join(' '), /changed the ECCode record \(\.eccode\/events\.jsonl\); the change was reverted/);
  const after = fs.readFileSync(events, 'utf8');
  assert.ok(after.startsWith(before), 'earlier events unchanged');
  for (const line of after.trim().split('\n')) JSON.parse(line); // the raw forged line is gone: every line is an event again
  assert.strictEqual(after.slice(before.length).trim().split('\n').length, 1, 'only the evidence event itself was appended');
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('a command that changes tracked files outside the claim fails; inside the claim it passes', () => {
  const ctx = project();
  const outside = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'x', command: `node -e "require('fs').appendFileSync('src/web/ui.js', '// x\\\\n')"` });
  assert.strictEqual(outside.status, 'failed');
  assert.match(outside.integrity.join(' '), /outside backend-engineer's claimed ownership: src\/web\/ui\.js/);
  const inside = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'y', command: `node -e "require('fs').appendFileSync('src/server/app.js', '// y\\\\n')"` });
  assert.strictEqual(inside.status, 'passed', JSON.stringify(inside.integrity));
  // Edits made before the command are not blamed on it.
  const again = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'z', command: 'node -e "process.exit(0)"' });
  assert.strictEqual(again.status, 'passed', JSON.stringify(again.integrity));
});

// Mealie pilot (b1 item 9, b2 items 3 and 4): in a parallel phase, a teammate
// edited its own files while an engineer's tests ran, and the engineer's
// evidence failed for "changing" them. Files another active claim owns are that
// claim's agent's to change; the evidence names them instead of failing.
test('a change to files another agent\'s claim owns is named, not blamed on the check', () => {
  const ctx = project();
  tasks.claim(ctx.store, ctx.config, 'ui', 'frontend-engineer'); // owns src/web/**
  const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'x', command: `node -e "require('fs').appendFileSync('src/web/ui.js', '// teammate\\\\n')"` });
  assert.strictEqual(ev.status, 'passed', JSON.stringify(ev.integrity));
  assert.deepStrictEqual(ev.concurrent, ['src/web/ui.js']);
  // A file no other claim owns still fails the check.
  write(ctx.dir, 'README.md', 'x\n');
  execFileSync('git', ['add', 'README.md'], { cwd: ctx.dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'readme'], { cwd: ctx.dir });
  const out = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'y', command: `node -e "require('fs').appendFileSync('README.md', 'y\\\\n')"` });
  assert.strictEqual(out.status, 'failed');
  assert.match(out.integrity.join(' '), /outside backend-engineer's claimed ownership: README\.md/);
});

test('a failing node --test check is recorded as failed even when ECCode itself runs under a Node test runner', () => {
  // This file runs under `node --test`, so NODE_TEST_CONTEXT is inherited here
  // exactly as it would be when ECCode is started from inside a test runner.
  const ctx = tmpProject();
  write(ctx.dir, 'failing.test.js', "require('node:test')('fails', () => { throw new Error('boom'); });\n");
  const prev = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = prev || 'child-v8';
  try {
    const ev = evidence.runCommand(ctx.store, 'orchestrator', { label: 'nested', command: 'node --test failing.test.js' });
    assert.strictEqual(ev.status, 'failed', `a failing test must not record as ${ev.status}`);
    assert.notStrictEqual(ev.exitCode, 0);
  } finally {
    if (prev === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prev;
  }
});

// Mealie pilot, c1 item 1: mutate's window reverted the record to its snapshot
// and erased a passing evidence run another engineer recorded meanwhile (its
// completion was then refused: the evidence did not exist) and the
// orchestrator's run end. Writes by other agents must survive the window.
const os = require('os');
const { spawnSync } = require('child_process');
const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');
function waitFor(file, ms = 30000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return fs.existsSync(file);
}

test('an event another agent records while a check runs is kept, not reverted', () => {
  const ctx = project();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-window-'));
  const done = path.join(tmp, 'writer.done');
  // Another agent: its own process, not started by the check, records a risk while the check runs.
  fs.writeFileSync(path.join(tmp, 'agent.js'), `const r = require('child_process').spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'risk', 'add', '--id', 'R9', '--title', 'concurrent risk', '--severity', 'low', '--actor', 'orchestrator'], { cwd: ${JSON.stringify(ctx.dir)}, encoding: 'utf8' });\nrequire('fs').writeFileSync(${JSON.stringify(done)}, String(r.status) + r.stderr);\n`);
  fs.writeFileSync(path.join(tmp, 'check.js'), `const env = { ...process.env }; delete env.ECCODE_EVIDENCE;\nrequire('child_process').spawn(process.execPath, [${JSON.stringify(path.join(tmp, 'agent.js'))}], { env, detached: true, stdio: 'ignore' }).unref();\nsetTimeout(() => {}, 1500);\n`);
  const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'slow check', command: `node "${path.join(tmp, 'check.js')}"` });
  assert.ok(waitFor(done), 'the other agent finished');
  const writer = fs.readFileSync(done, 'utf8');
  assert.match(writer, /^0/, 'its write succeeded once the check ended');
  assert.match(writer, /waiting for the record: a check is running \(slow check, pid \d+\)/, 'and it said what it waited for');
  assert.strictEqual(ev.status, 'passed');
  assert.strictEqual(ev.integrity, undefined, 'the other agent\'s write is not the check\'s');
  assert.ok(ctx.store.readEvents().some((e) => e.type === 'risk.recorded' && e.data.id === 'R9'), 'the event survived');
  assert.ok(ctx.store.readEvents().some((e) => e.data && e.data.id === ev.id), 'and so did the evidence');
  assert.strictEqual(ctx.store.audit().ok, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a checked command that calls the engine to write is refused at once, and nothing is recorded', () => {
  const ctx = project();
  const started = Date.now();
  const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'writes', command: `node "${CLI}" risk add --id R8 --title "from the check" --severity low --actor orchestrator` });
  assert.ok(Date.now() - started < 8000, 'no wait on the window\'s own lock');
  assert.strictEqual(ev.status, 'failed');
  assert.strictEqual(ev.integrity, undefined, 'refused before anything was written');
  assert.match(fs.readFileSync(path.join(ctx.dir, ev.log), 'utf8'), /a checked command may not write the ECCode record/);
  assert.ok(!ctx.store.readEvents().some((e) => e.type === 'risk.recorded'));
});

test('a live window\'s lock is never broken as stale; a dead holder\'s is', () => {
  const { withLock } = require('../lib/util');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-lock-'));
  const lock = path.join(dir, '.lock');
  const old = new Date(Date.now() - 120000);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, window: true }));
  fs.utimesSync(lock, old, old);
  assert.throws(() => withLock(lock, () => 'stolen', { timeoutMs: 100, staleMs: 50, windowWaitMs: 300 }), (e) => e.code === 'LOCK_TIMEOUT' && /held by a running check/.test(e.message));
  assert.ok(fs.existsSync(lock), 'still held');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(dead), window: true }));
  fs.utimesSync(lock, old, old);
  assert.strictEqual(withLock(lock, () => 'taken', { timeoutMs: 1000, staleMs: 50 }), 'taken');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Multi-file run (s2e2 item 05): an evidence run waited behind two running
// checks, then timed out at once on the brief ordinary lock their owner took
// to record its result, because the 10 s clock had run all along.
test('the ordinary lock wait starts again once a running check lets go', async () => {
  const { withLock, sleepSync } = require('../lib/util');
  const { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-lock-'));
  const lock = path.join(dir, '.lock');
  const holder = spawn(process.execPath, ['-e', `
    const fs = require('fs'); const lock = ${JSON.stringify(lock)};
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, window: true, label: 'full-tests' }));
    setTimeout(() => {
      fs.writeFileSync(lock + '.next', JSON.stringify({ pid: process.pid }));
      fs.renameSync(lock + '.next', lock);
      setTimeout(() => fs.unlinkSync(lock), 100);
    }, 2500);`], { stdio: 'ignore' });
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  while (!fs.existsSync(lock)) sleepSync(10);
  assert.strictEqual(withLock(lock, () => 'taken', { timeoutMs: 2000, staleMs: 30000, windowWaitMs: 60000 }), 'taken');
  await exited;
  fs.rmSync(dir, { recursive: true, force: true });
});

// Final review: the window refused every engine write in the command's process
// tree, so a project whose tests create their own ECCode records (ECCode
// itself) failed under evidence run. Only the windowed record is refused.
test('a checked command may write an ECCode record of its own, not the windowed one', () => {
  const ctx = project();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-own-'));
  execFileSync('git', ['init', '-q'], { cwd: tmp });
  const ev = evidence.runCommand(ctx.store, 'backend-engineer', { label: 'own record', command: `node "${CLI}" init --root "${tmp}" --name t --idea "a record the tests create"` });
  assert.strictEqual(ev.status, 'passed', fs.readFileSync(path.join(ctx.dir, ev.log), 'utf8'));
  assert.ok(fs.existsSync(path.join(tmp, '.eccode', 'events.jsonl')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Final review: mutate held one window over the baseline and every mutant, so
// another agent's write waited for the whole run. Each test run is its own window.
test('a write waits for one test run of mutate, not for the whole mutation run', () => {
  const mutate = require('../lib/mutate');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-mwin-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  write(dir, 'src/a.js', 'module.exports = (x) => x;\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  execFileSync(process.execPath, [CLI, 'init', '--root', dir, '--name', 't', '--idea', 'mutation windows'], { stdio: 'pipe' });
  write(dir, 'src/a.js', 'module.exports = (x) => (x > 1 ? x + 1 : x - 1) && x < 9 && x !== 3;\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-mwin-w-'));
  const done = path.join(tmp, 'done');
  fs.writeFileSync(path.join(tmp, 'agent.js'), `setTimeout(() => { require('child_process').spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'risk', 'add', '--id', 'R1', '--title', 'meanwhile', '--severity', 'low', '--actor', 'orchestrator'], { cwd: ${JSON.stringify(dir)} }); require('fs').writeFileSync(${JSON.stringify(done)}, String(Date.now())); }, 1500);\n`);
  const env = { ...process.env };
  delete env.ECCODE_EVIDENCE;
  require('child_process').spawn(process.execPath, [path.join(tmp, 'agent.js')], { env, detached: true, stdio: 'ignore' }).unref();
  const r = mutate.run(dir, { test: 'node -e "setTimeout(() => {}, 700)"', timeoutMs: 30000 });
  const ended = Date.now();
  assert.ok(r.total >= 4, `enough mutants to tell: ${r.total}`);
  assert.ok(waitFor(done), 'the other agent wrote');
  assert.ok(Number(fs.readFileSync(done, 'utf8')) < ended - 1000, 'it got in between two test runs, not after the last one');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Mealie rerun, b2 item 1: the full test suite outlived the 600 s evidence
// timeout; only the shell was killed, the tests under it ran on and left a
// half-migrated test database, and nothing said how to allow more time.
test('an evidence run that times out stops everything it started and says how to give it more time', { skip: process.platform === 'win32' && 'process groups are POSIX' }, () => {
  const { dir, store } = tmpProject();
  const late = path.join(dir, 'late.txt');
  // The path goes in as an argument: quoting it inside the -e script would break it.
  const ev = evidence.runCommand(store, 'backend-engineer', { label: 'slow suite', command: `node -e "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 1500)" ${JSON.stringify(late)} & sleep 5`, timeoutMs: 500 });
  assert.strictEqual(ev.timedOut, true);
  assert.strictEqual(ev.status, 'failed');
  assert.doesNotMatch(ev.outputTail, /SyntaxError/);
  assert.match(ev.outputTail, /timed out after 0\.5 s.*--timeout <seconds>/);
  const until = Date.now() + 2500;
  while (Date.now() < until) { /* wait past the grandchild's write */ }
  assert.strictEqual(fs.existsSync(late), false, 'the process the command started was stopped with it');
});

// Review of the fix above: in its own group, the command outlived an eccode
// process that was killed (Ctrl-C, a stopped tool call, an agent's group
// killed by the bench harness), and went on writing into the project.
test('an evidence run whose eccode process is killed stops with it', { skip: process.platform === 'win32' && 'process groups are POSIX' }, () => {
  const { dir } = tmpProject();
  const marker = path.join(dir, 'marker.txt');
  const runner = `const evidence = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'evidence'))}); const { Store } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store'))});
evidence.runCommand(new Store(${JSON.stringify(dir)}), 'backend-engineer', { label: 'slow', command: 'sleep 3 && echo late > marker.txt', timeoutMs: 30000 });`;
  const child = require('child_process').spawn(process.execPath, ['-e', runner], { cwd: dir, detached: true, stdio: 'ignore' });
  const sleep = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* wait */ } };
  sleep(1000);
  process.kill(-child.pid, 'SIGKILL'); // the eccode process and its own group, as a harness kills an agent
  sleep(4500);
  assert.strictEqual(fs.existsSync(marker), false, 'the check did not outlive the eccode process');
});

test('evidence run --timeout is in the help', () => {
  const res = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'eccode.js'), 'help'], { encoding: 'utf8' });
  assert.match(res.stdout, /evidence run [^\n]*--timeout <s>/);
});

// Delivery run: a check that ran past the old 10-minute default was stopped
// and run again, which cost large changes their time.
test('evidence run waits 30 minutes by default', () => {
  assert.strictEqual(require('../lib/evidence').DEFAULT_TIMEOUT_MS, 1800000);
  const help = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'eccode.js'), '--help'], { encoding: 'utf8' }).stdout;
  assert.match(help, /evidence run [^\n]*default 1800 s/);
});
