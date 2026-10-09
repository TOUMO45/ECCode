'use strict';
// F9 (independent review): portability and release reproducibility.
// - shellQuote lives in lib/util.js with a win32 branch; the POSIX output is unchanged.
// - Test fixtures never depend on sh builtins, and throwaway repos pin core.autocrlf=false so the
//   byte hashes the record pins survive a checkout on a machine with a global autocrlf=true.
// - The package entry point exists and `npm pack` ships the engine, CLI, schemas and hooks only.
// - A record written by the 0.1.0 release survives an upgrade to the current toolkit and a
//   rollback to 0.1.0, and the event types 0.1.0 does not know are named in the compatibility doc.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const V010 = 'd2d0c2432aa3277f45b5b54cd3d43385f0d66d75'; // the 0.1.0 release commit
const PKG = require('../package.json');

/**
 * The test sources the fixture rules apply to: every tests/*.js except this file (it holds the
 * rules) and helpers.js (its task().verification.command is declarative; nothing in lib/ runs it).
 */
function otherTestSources() {
  return fs.readdirSync(__dirname).filter((x) => x.endsWith('.js') && x !== 'helpers.js' && x !== path.basename(__filename));
}

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

/** Files `npm pack` would ship, or null when npm is not installed. */
function packedFiles() {
  const npm = process.env.npm_execpath;
  const opts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
  const res = npm && /[\\/]npm-cli\.js$/.test(npm)
    ? spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json'], opts)
    : spawnSync('npm', ['pack', '--dry-run', '--json'], { ...opts, shell: process.platform === 'win32' });
  if (res.error && res.error.code === 'ENOENT') return null;
  assert.strictEqual(res.status, 0, `npm pack --dry-run failed: ${res.stderr}`);
  return JSON.parse(res.stdout)[0].files.map((f) => f.path);
}

test('F9 shellQuote: one implementation in lib/util.js, POSIX quoting unchanged, cmd.exe grouping on win32', () => {
  const util = require('../lib/util');
  assert.strictEqual(typeof util.shellQuote, 'function', 'lib/util.js exports shellQuote');
  for (const src of ['bin/eccode.js', 'lib/memory/improve-cli.js']) {
    const text = fs.readFileSync(path.join(ROOT, src), 'utf8');
    assert.doesNotMatch(text, /function shellQuote/, `${src} must import shellQuote from lib/util.js, not define its own`);
    assert.match(text, /shellQuote/, `${src} uses shellQuote`);
  }
  assert.strictEqual(util.shellQuote('plain/arg.js'), 'plain/arg.js', 'safe arguments pass through on every platform');
  withPlatform('linux', () => {
    assert.strictEqual(util.shellQuote("it's"), "'it'\\''s'");
    assert.strictEqual(util.shellQuote('a b'), "'a b'");
    assert.strictEqual(util.shellQuote('say "hi"'), "'say \"hi\"'");
  });
  withPlatform('win32', () => {
    assert.strictEqual(util.shellQuote('a b'), '"a b"', 'double quotes group under cmd.exe');
    assert.strictEqual(util.shellQuote("it's"), '"it\'s"', 'a single quote means nothing to cmd.exe');
    assert.strictEqual(util.shellQuote('say "hi"'), '"say \\"hi\\""', 'an embedded " is \\" for the child argv parser');
    assert.strictEqual(util.shellQuote('end\\'), '"end\\\\"', 'a trailing backslash is doubled so it cannot escape the closing quote');
    assert.strictEqual(util.shellQuote('x\\"y'), '"x\\\\\\"y"', 'backslashes before a quote are doubled, then the quote escaped');
  });
});

test('F9 fixtures: throwaway repos pin core.autocrlf=false so the byte hashes the record pins survive a checkout', () => {
  const helpers = require('./helpers');
  assert.strictEqual(typeof helpers.initRepo, 'function', 'helpers.initRepo is the one place test repos are created');
  for (const f of otherTestSources()) {
    assert.ok(!/\['init',\s*'-q'\]/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')), `tests/${f}: create the repo with initRepo(dir) from ./helpers`);
  }
  const ctx = helpers.tmpProject();
  assert.strictEqual(execFileSync('git', ['config', '--local', '--get', 'core.autocrlf'], { cwd: ctx.dir, encoding: 'utf8' }).trim(), 'false');
  // The reviewer's machine: a global autocrlf=true. The repo-local setting must win, or a
  // `git checkout -- file` after an approval rewrites LF as CRLF and the pinned hash no longer matches.
  const globalConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gitconfig-')), 'gitconfig');
  fs.writeFileSync(globalConfig, '[core]\n\tautocrlf = true\n[user]\n\temail = t@t\n\tname = t\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
  const file = path.join(ctx.dir, 'src', 'b.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '// ui\n');
  execFileSync('git', ['add', '-A'], { cwd: ctx.dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'ui'], { cwd: ctx.dir, env });
  fs.unlinkSync(file);
  execFileSync('git', ['checkout', '--', 'src/b.js'], { cwd: ctx.dir, env });
  assert.deepStrictEqual([...fs.readFileSync(file)], [...Buffer.from('// ui\n')], 'the checkout restored the committed bytes (LF)');
});

test('F9 fixtures: no test depends on sh builtins or POSIX-only tools (cmd.exe has no true, false, grep or sh)', () => {
  // The exact fixtures that failed the independent review's Windows run, as rules.
  const rules = [
    [/\bsh',\s*'-c'|\bsh -c\b/, 'sh is not on every PATH: drive node -e "..." instead'],
    [/grep -q/, 'cmd.exe has no grep: node -e "process.exit(require(\'fs\').readFileSync(f, \'utf8\').includes(x) ? 0 : 1)"'],
    [/;\s*exit \d/, 'cmd.exe does not split commands on ";": node -e "...; process.exit(n)"'],
    [/(command: |'--', |evaluate\([^)]*)'(true|false)'/, 'cmd.exe has no true/false: node -e "process.exit(0)" / node -e "process.exit(1)"'],
  ];
  const problems = [];
  for (const f of otherTestSources()) {
    fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').forEach((line, i) => {
      for (const [re, fix] of rules) if (re.test(line)) problems.push(`tests/${f}:${i + 1}: ${line.trim()}\n    ${fix}`);
    });
  }
  assert.deepStrictEqual(problems, [], `non-portable fixtures:\n${problems.join('\n')}`);
});

test('F9 package: lib/index.js is the entry point and exposes the engine API', () => {
  assert.strictEqual(PKG.main, 'lib/index.js');
  assert.ok(fs.existsSync(path.join(ROOT, PKG.main)), 'package.json main must exist');
  const api = require(ROOT); // resolves through package.json main
  assert.strictEqual(api.version, PKG.version);
  for (const name of ['Store', 'init', 'openProject', 'gates', 'tasks', 'evidence', 'runs', 'delivery', 'reconcile', 'rework', 'Memory', 'loadConfig', 'EccodeError']) {
    assert.ok(api[name], `lib/index.js exports ${name}`);
  }
  const { initRepo } = require('./helpers');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-api-'));
  initRepo(dir);
  const store = api.init(dir, { name: 'Api', idea: 'drive the engine in-process through the package entry point' });
  const config = api.loadConfig(dir);
  api.gates.startGate(store, config, 'architecture', 'orchestrator');
  assert.strictEqual(store.state().gates.architecture.status, 'in_progress');
  assert.strictEqual(api.openProject(dir).store.state().seq, 2);
});

test('F9 package: npm pack ships the engine, CLI, schemas and hooks, and no tests, examples or records', (t) => {
  const files = packedFiles();
  if (!files) return t.skip('npm is not installed; the package-content check needs it');
  for (const must of ['package.json', 'lib/index.js', 'bin/eccode.js', 'hooks/hooks.json', 'scripts/hooks/guard.js', 'scripts/hooks/session-start.js', 'scripts/hooks/stop.js', 'schemas/review.schema.json', 'schemas/plan.schema.json']) {
    assert.ok(files.includes(must), `npm pack must ship ${must}`);
  }
  for (const never of ['tests/', 'examples/', '.eccode/', 'eval/', '.github/']) {
    assert.deepStrictEqual(files.filter((f) => f.startsWith(never)), [], `npm pack must not ship ${never}`);
  }
});

test('F9 upgrade and rollback: a 0.1.0 record survives installing the current toolkit over it and rolling back', (t) => {
  if (spawnSync('git', ['cat-file', '-e', `${V010}^{commit}`], { cwd: ROOT }).status !== 0) {
    return t.skip(`commit ${V010.slice(0, 8)} (the 0.1.0 release) is not in this clone; run git fetch --unshallow`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-f9-'));
  const old = path.join(tmp, 'eccode-0.1.0');
  const tar = path.join(tmp, 'eccode-0.1.0.tar');
  fs.mkdirSync(old);
  execFileSync('git', ['archive', '--format=tar', '-o', tar, V010], { cwd: ROOT });
  const untar = spawnSync('tar', ['-x', '-C', old, '-f', tar], { encoding: 'utf8' });
  if (untar.error && untar.error.code === 'ENOENT') return t.skip('tar is not installed; the upgrade test needs it to unpack the 0.1.0 release');
  assert.strictEqual(untar.status, 0, untar.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(old, 'package.json'), 'utf8')).version, '0.1.0');

  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  require('./helpers').initRepo(project);
  const cli = (bin, args) => spawnSync(process.execPath, [bin, ...args], { cwd: project, encoding: 'utf8' });
  const ok = (res, what) => {
    assert.strictEqual(res.status, 0, `${what}: ${res.stdout}${res.stderr}`);
    return res;
  };
  const installed = path.join(project, '.claude', 'eccode');
  const INSTALLED_CLI = path.join(installed, 'bin', 'eccode.js');
  const installedVersion = () => JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
  const hookGroups = () => {
    const settings = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
    const count = (event) => (settings.hooks[event] || []).filter((g) => (g.hooks || []).some((h) => String(h.command).includes('eccode/scripts/hooks/'))).length;
    return { SessionStart: count('SessionStart'), PreToolUse: count('PreToolUse'), Stop: count('Stop') };
  };

  // 1. Install 0.1.0 as a project-local copy (its docs/usage.md section B) and write a record with it.
  ok(cli(path.join(old, 'bin', 'eccode.js'), ['install', '--target', project]), '0.1.0 install');
  assert.strictEqual(installedVersion(), '0.1.0');
  assert.deepStrictEqual(hookGroups(), { SessionStart: 1, PreToolUse: 1, Stop: 0 }, '0.1.0 merged its two hooks');
  ok(cli(INSTALLED_CLI, ['init', '--name', 'Upgrade', '--idea', 'a record written by the 0.1.0 release']), '0.1.0 init');
  ok(cli(INSTALLED_CLI, ['evidence', 'run', '--actor', 'test-engineer', '--label', 'smoke', '--', 'node -e "process.exit(0)"']), '0.1.0 evidence run');
  ok(cli(INSTALLED_CLI, ['risk', 'add', '--id', 'R1', '--title', 'Provider outage', '--severity', 'medium', '--actor', 'delivery-lead']), '0.1.0 risk add');
  assert.match(ok(cli(INSTALLED_CLI, ['audit']), '0.1.0 audit').stdout, /Audit OK: 3 events/);
  const logBefore = fs.readFileSync(path.join(project, '.eccode', 'events.jsonl'));

  // 2. Upgrade: the current toolkit installed over it (lib/install.js).
  require('../lib/install').install({ target: project });
  assert.strictEqual(installedVersion(), PKG.version);
  assert.ok(fs.existsSync(path.join(installed, 'lib', 'rework.js')), 'the current runtime replaced the old one');
  assert.deepStrictEqual(hookGroups(), { SessionStart: 1, PreToolUse: 1, Stop: 1 }, 'hook entries were replaced in place, not duplicated');
  assert.match(ok(cli(INSTALLED_CLI, ['audit']), 'upgraded audit').stdout, /Audit OK: 3 events/);
  assert.deepStrictEqual(fs.readFileSync(path.join(project, '.eccode', 'events.jsonl')), logBefore, 'audit and install are read-only on the record');
  assert.match(ok(cli(INSTALLED_CLI, ['status', '--brief']), 'upgraded status').stdout, /NEXT:/);
  assert.strictEqual(JSON.parse(ok(cli(INSTALLED_CLI, ['status', '--json']), 'upgraded status --json').stdout).project.name, 'Upgrade');
  // The upgraded engine keeps working on the old record.
  ok(cli(INSTALLED_CLI, ['evidence', 'run', '--actor', 'test-engineer', '--label', 'after-upgrade', '--', 'node -e "process.exit(0)"']), 'upgraded evidence run');
  ok(cli(INSTALLED_CLI, ['risk', 'update', '--id', 'R1', '--status', 'mitigated', '--actor', 'delivery-lead']), 'upgraded risk update');
  assert.match(ok(cli(INSTALLED_CLI, ['audit']), 'upgraded audit after writes').stdout, /Audit OK: 5 events/);

  // 3. Roll back: 0.1.0 installed again over the current toolkit.
  ok(cli(path.join(old, 'bin', 'eccode.js'), ['install', '--target', project]), '0.1.0 reinstall');
  assert.strictEqual(installedVersion(), '0.1.0');
  assert.deepStrictEqual(hookGroups(), { SessionStart: 1, PreToolUse: 1, Stop: 1 }, 'rollback keeps one entry per hook');
  // Every event the newer engine wrote is one the 0.1.0 reducer knows, so the rolled-back engine
  // replays the snapshot the newer engine left and the audit stays clean.
  const oldReducer = fs.readFileSync(path.join(old, 'lib', 'reducer.js'), 'utf8');
  const oldTypes = new Set([...oldReducer.matchAll(/case '([a-z._]+)'/g)].map((m) => m[1]));
  const written = fs.readFileSync(path.join(project, '.eccode', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  assert.strictEqual(written.length, 5);
  assert.deepStrictEqual(written.filter((type) => !oldTypes.has(type)), [], 'the upgraded engine wrote only event types 0.1.0 replays');
  assert.match(ok(cli(INSTALLED_CLI, ['audit']), '0.1.0 audit after rollback').stdout, /Audit OK: 5 events/);
  assert.match(ok(cli(INSTALLED_CLI, ['status', '--brief']), '0.1.0 status after rollback').stdout, /NEXT:/);

  // 4. The event types the current engine can write that 0.1.0 does not know are named in the
  // compatibility doc: a record carrying them must stay on the engine that wrote it, or newer.
  // Event types are the literals passed to store.commit(...) and Memory.emit(...).
  const literals = (dir) => {
    const out = new Set();
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.js')) for (const m of fs.readFileSync(path.join(d, e.name), 'utf8').matchAll(/\b(?:commit|emit)\('([a-z]+\.[a-z_]+)'/g)) out.add(m[1]);
      }
    };
    walk(dir);
    return out;
  };
  const oldLiterals = literals(path.join(old, 'lib'));
  const newTypes = [...literals(path.join(ROOT, 'lib'))].filter((type) => !oldLiterals.has(type)).sort();
  assert.ok(newTypes.includes('rework.opened'), `expected the 0.2.0 event types among ${newTypes.join(', ')}`);
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'architecture.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## Record compatibility'), doc.indexOf('## Known limitations'));
  for (const type of newTypes) assert.ok(section.includes(`\`${type}\``), `docs/architecture.md "Record compatibility" must name ${type} (new since 0.1.0)`);
});
