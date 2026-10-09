'use strict';
// F9 (portability and release reproducibility): the package as it would be installed, not only the checkout.
//   npm run validate; npm pack --dry-run content; a real tarball installed into a throwaway consumer and
//   require('eccode') + the installed CLI driven from there; .gitattributes; a static scan of the test fixtures for
//   cmd.exe-hostile shapes; version consistency across the manifests; the shipped F9 test (upgrade/rollback included)
//   run with its skip count checked. Windows itself is NOT run here (Linux only); this probe says so in its output.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, report, cleanup } = require('./_lib');

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, exit: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim().slice(0, 400), error: r.error ? r.error.message : undefined };
};
const NPM = process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? [process.execPath, process.env.npm_execpath] : ['npm'];
const npm = (args, opts) => sh(NPM[0], [...NPM.slice(1), ...args], opts);

const { step, finish, out } = report('F9-release-checks');
out.windowsRun = false;
out.note = 'Windows was NOT run: this verification ran on Linux only; the Windows claims of 0.3.0 rest on the analysis in docs/evidence/review-bundle/README.md and on CI.';
const dirs = [];
try {
  const v = npm(['run', 'validate']);
  step('F9.validate', 'npm run validate', 'ok', { ok: v.ok, exit: v.exit, value: v.stdout.split('\n').slice(-3).join(' | ').slice(0, 300), message: v.stderr });

  const dry = npm(['pack', '--dry-run', '--json']);
  const files = dry.ok ? JSON.parse(dry.stdout)[0].files.map((f) => f.path) : [];
  const must = ['package.json', 'lib/index.js', 'bin/eccode.js', 'hooks/hooks.json', 'scripts/hooks/guard.js', 'schemas/review.schema.json'];
  const never = ['tests/', 'examples/', '.eccode/', 'eval/', '.github/'];
  step('F9.pack.dryRun', 'npm pack --dry-run lists the engine and CLI and ships no tests, examples or records', 'documented', { ok: dry.ok && must.every((m) => files.includes(m)) && never.every((n) => !files.some((f) => f.startsWith(n))), value: { count: files.length, missing: must.filter((m) => !files.includes(m)), leaked: files.filter((f) => never.some((n) => f.startsWith(n))).slice(0, 10), docsShipped: files.filter((f) => f.startsWith('docs/')).length } });

  // A real tarball, installed into a consumer directory, and used from there.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-f9-'));
  dirs.push(tmp);
  const packed = npm(['pack', '--pack-destination', tmp, '--json']);
  const tgz = packed.ok ? path.join(tmp, JSON.parse(packed.stdout)[0].filename) : null;
  step('F9.pack.real', 'npm pack to a temp dir', 'ok', { ok: packed.ok && Boolean(tgz) && fs.existsSync(tgz), value: tgz && path.basename(tgz), message: packed.stderr });
  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }));
  const inst = npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tgz], { cwd: consumer });
  step('F9.install', 'npm install <tarball> --offline into the consumer', 'ok', { ok: inst.ok, exit: inst.exit, value: inst.stdout.slice(-200), message: inst.stderr });
  const req = sh(process.execPath, ['-e', "const e=require('eccode');console.log(JSON.stringify({version:e.version,exports:Object.keys(e).length,hasStore:typeof e.Store==='function',hasGates:typeof e.gates.startGate==='function'}))"], { cwd: consumer });
  step('F9.require', "require('eccode') from the installed package", 'ok', { ok: req.ok, value: req.stdout, message: req.stderr });
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  require(REPO + '/tests/helpers').initRepo(project);
  const INSTALLED = path.join(consumer, 'node_modules', 'eccode', 'bin', 'eccode.js');
  const init = sh(process.execPath, [INSTALLED, 'init', '--name', 'Installed', '--idea', 'drive the installed release, not the checkout'], { cwd: project });
  step('F9.installedCli.init', 'the installed CLI: eccode init', 'ok', { ok: init.ok, value: init.stdout.slice(0, 120), message: init.stderr });
  const run = sh(process.execPath, [INSTALLED, 'evidence', 'run', '--actor', 'test-engineer', '--label', 'smoke', '--', 'node -e "process.exit(0)"'], { cwd: project });
  step('F9.installedCli.evidence', 'the installed CLI: eccode evidence run', 'ok', { ok: run.ok, value: run.stdout.slice(0, 120), message: run.stderr });
  const audit = sh(process.execPath, [INSTALLED, 'audit'], { cwd: project });
  step('F9.installedCli.audit', 'the installed CLI: eccode audit', 'ok', { ok: audit.ok, value: audit.stdout.slice(0, 120), message: audit.stderr });
  const hooksJson = JSON.parse(fs.readFileSync(path.join(consumer, 'node_modules', 'eccode', 'hooks', 'hooks.json'), 'utf8'));
  step('F9.installedHooks', 'hooks.json of the installed package names the guard', 'documented', { ok: JSON.stringify(hooksJson).includes('guard.js'), value: JSON.stringify(hooksJson).slice(0, 200) });

  // .gitattributes
  const ga = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8');
  step('F9.gitattributes', '.gitattributes: text=auto eol=lf, bundle and evidence logs -text', 'documented', { ok: /^\* text=auto eol=lf$/m.test(ga) && /review-bundle\/\*\* -text/.test(ga) && /\.eccode\/evidence\/\*\.log -text/.test(ga), value: ga.split('\n').filter((l) => l && !l.startsWith('#')) });
  const eolCheck = sh('git', ['ls-files', '--eol', 'lib/store.js', 'bin/eccode.js', 'tests/helpers.js', 'docs/evidence/review-bundle/eccode-check-windows.log']);
  step('F9.eol', 'git ls-files --eol on engine files and a bundle log', 'documented', { ok: eolCheck.ok, value: eolCheck.stdout.split('\n') });

  // Static scan of the fixtures (the rule set of tests/review-F9.test.js, applied here independently, helpers.js included).
  const rules = [
    [/\bsh',\s*'-c'|\bsh -c\b/, 'sh -c'],
    [/grep -q/, 'grep -q'],
    [/;\s*exit \d/, '; exit N'],
    [/(command: |'--', |evaluate\([^)]*)'(true|false)'/, "'true'/'false' as a command"],
  ];
  const hits = [];
  for (const f of fs.readdirSync(path.join(REPO, 'tests')).filter((x) => x.endsWith('.js'))) {
    fs.readFileSync(path.join(REPO, 'tests', f), 'utf8').split('\n').forEach((line, i) => {
      if (/\/\/ hook input/.test(line)) return;
      for (const [re, name] of rules) if (re.test(line)) hits.push(`tests/${f}:${i + 1} [${name}] ${line.trim().slice(0, 100)}`);
    });
  }
  step('F9.fixtureScan', 'tests/*.js scanned for sh -c, grep -q, "; exit N", true/false commands (lines marked "hook input" excluded)', 'documented', { ok: hits.filter((h) => !h.includes('review-F9.test.js')).length === 0, value: hits });
  const guardTestHookInputs = fs.readFileSync(path.join(REPO, 'tests/review-F4-F5-guard.test.js'), 'utf8').split('\n').filter((l) => /sh -c/.test(l)).map((l) => l.trim().slice(0, 100));
  step('F9.fixtureScan.hookInputs', 'sh -c strings that exist only as guard hook input (never executed)', 'documented', { ok: true, value: guardTestHookInputs });

  // Version consistency.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const plugin = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin/plugin.json'), 'utf8')).version;
  const market = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin/marketplace.json'), 'utf8')).plugins[0].version;
  const changelog = (/^## (\d+\.\d+\.\d+)/m.exec(fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8')) || [])[1];
  const index = require(REPO + '/lib/index.js').version;
  const engineMarker = (/ENGINE_VERSION\s*=\s*([^;\n]+)/.exec(fs.readFileSync(path.join(REPO, 'lib/memory/records.js'), 'utf8')) || [])[1];
  step('F9.versions', 'package.json, plugin.json, marketplace.json, CHANGELOG first heading, lib/index.js', 'documented', { ok: [plugin, market, changelog, index].every((x) => x === pkg) && pkg === '0.3.0', value: { pkg, plugin, market, changelog, index, engineMarkerSource: (engineMarker || '').trim() } });

  // The shipped F9 test, including the upgrade/rollback test, with its skip count.
  const t = sh(process.execPath, ['--test', 'tests/review-F9.test.js']);
  const summary = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map((k) => [k, Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(t.stdout + t.stderr) || [])[1])]));
  step('F9.shippedTest', 'node --test tests/review-F9.test.js (upgrade/rollback against the 0.1.0 commit included)', 'documented', { ok: t.ok && summary.fail === 0 && summary.skipped === 0 && summary.pass === 6, value: summary, message: t.stderr.slice(0, 200) });
  const v010 = sh('git', ['cat-file', '-e', 'd2d0c2432aa3277f45b5b54cd3d43385f0d66d75^{commit}']);
  step('F9.v010commit', 'the 0.1.0 release commit is in this clone (so the upgrade test did not skip)', 'documented', { ok: v010.ok, value: v010.ok ? 'present' : 'absent' });
  // The working tree at verification time.
  const statusOut = sh('git', ['status', '--short']).stdout.split('\n').filter((l) => l && !l.includes('docs/evidence/verification-0.3.0'));
  step('F9.workingTree', 'git status --short at verification time (excluding this verification\'s own files)', 'documented', { ok: statusOut.length === 0, value: statusOut }, statusOut.length ? 'the working tree is not identical to 5da8913; engine probes used lib/ and bin/ which are unmodified, guard probes used a git-archive snapshot of HEAD' : 'clean');
  step('F9.windows', 'Windows', 'documented', { ok: false, value: 'NOT RUN. Linux only (see out.note). The five Windows fixture fixes are unverified on Windows by this verification.' });
} finally {
  cleanup(...dirs);
}
finish();
