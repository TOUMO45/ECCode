#!/usr/bin/env node
'use strict';
// S4 (Meterline) operator tool: arm order and arm workspace preparation, as fixed by docs/build/gf-s4-plan.md
// section 3 and addenda 2 (section 3) and 3 (sections 2.4 and 4). It prepares and records; it never starts a model.
//
//   node tools/s4-operator.js order --seed <text>
//   node tools/s4-operator.js prepare --arm a|b|c --out <dir> [--stage 1|2] [--repo <eccode checkout>]
//
// Deviation from the plan text, recorded in every run.json: the engine export leaves out `.eccode/` as well as
// `docs/`. The repository tracks its own `.eccode/` record, and with it in the export the plan's `init` command is
// refused (GF-INIT-1, "an ECCode project already exists here"). Found by the first dry run, 2026-11-11.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const BASE = 'a530ae12fd07a4a28566e89b7211acad332f8c69'; // addendum 2 section 2
const MODEL = 'claude-opus-5-5'; // addendum 2 D-5
const STACK = 'python-fastapi-postgres-worker-compose';
const AUTO = { enabled: true, maxSlices: 12, maxTokens: 170000000, maxWallClockMinutes: 480 };
const RECORD = 'docs/build/gf-s4-plan-record/meterline';
const FILES = { // addendum 3 sections 2.2 and 2.4
  'master-prompt-v2-stage1.md': '22c576e9c486b61e1d92eeb3550d74ab89aff2411af2918f0bb2d4128380b392',
  'master-prompt-v2-full.md': 'ef8132b239375790c9ef084b4d334e96d54ddd62c74824f33ded0439b99da48c',
  'sample_readings.csv': '5a9a98a6f7f5f8fc4be69f86aea4c3eb17ab9715a9e66da09fcc00a37db6c7f7',
};
const ARMS = ['a', 'b', 'c'];
const EXPORT_EXCLUDES = ['docs', '.eccode'];

class OperatorError extends Error {}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The arm order for a seed: a fixed, reproducible permutation (plan 3.1, "coin-flip script"). */
function order(seed) {
  if (!seed) throw new OperatorError('order needs --seed <text>; commit the seed before Stage 1');
  return ARMS.map((arm) => ({ arm, key: sha256(`${seed}\n${arm}`) })).sort((x, y) => (x.key < y.key ? -1 : 1)).map((x) => x.arm);
}

/** Read the three frozen inputs and refuse to go on if any byte differs from the registered hash. */
function frozenInputs(repo) {
  const out = {};
  for (const [name, want] of Object.entries(FILES)) {
    const file = path.join(repo, RECORD, name);
    if (!fs.existsSync(file)) throw new OperatorError(`frozen input missing: ${file}`);
    const bytes = fs.readFileSync(file);
    const got = sha256(bytes);
    if (got !== want) throw new OperatorError(`sha256 mismatch for ${name}: got ${got}, registered ${want}. Nothing was prepared.`);
    out[name] = { bytes, sha256: got };
  }
  return out;
}

function toolVersion(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}

function prepare({ arm, out, stage = '1', repo = path.join(__dirname, '..') }) {
  if (!ARMS.includes(arm)) throw new OperatorError('prepare needs --arm a|b|c');
  if (!['1', '2'].includes(String(stage))) throw new OperatorError('--stage is 1 or 2');
  if (!out) throw new OperatorError('prepare needs --out <dir>');
  const runDir = path.resolve(out, `arm-${arm}`);
  const workspace = path.join(runDir, 'workspace');
  if (fs.existsSync(runDir)) throw new OperatorError(`${runDir} already exists: an arm is prepared once, in a fresh directory`);
  const inputs = frozenInputs(repo);
  const promptName = String(stage) === '1' ? 'master-prompt-v2-stage1.md' : 'master-prompt-v2-full.md';
  const prompt = inputs[promptName];

  fs.mkdirSync(workspace, { recursive: true });
  let gf = null;
  if (arm !== 'a') {
    try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${BASE}^{commit}`], { stdio: 'ignore' }); } catch {
      throw new OperatorError(`base commit ${BASE} is not in ${repo}: fetch origin s4-prereq/finish first`);
    }
    const tar = execFileSync('git', ['-C', repo, 'archive', BASE], { maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', workspace, ...EXPORT_EXCLUDES.map((e) => `--exclude=${e}`)], { input: tar });
    // --idea is the v2 prompt, byte for byte (addendum 3 Q-4): passed as one argv element, so nothing is stripped.
    const init = spawnSync(process.execPath, ['bin/eccode-gf.js', 'init', '--name', 'meterline', '--idea', prompt.bytes.toString('utf8'), '--stack', STACK],
      { cwd: workspace, encoding: 'utf8' });
    if (init.status !== 0) throw new OperatorError(`init failed in ${workspace}: ${(init.stderr || init.stdout).trim()}`);
    const cfgFile = path.join(workspace, '.eccode', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.gf = cfg.gf || {};
    cfg.gf.approval = { auto: { ...AUTO } };
    if (arm === 'c') cfg.gf.runtime = { enforce: true };
    else delete cfg.gf.runtime;
    fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    gf = cfg.gf;
  }
  fs.writeFileSync(path.join(workspace, 'sample_readings.csv'), inputs['sample_readings.csv'].bytes);
  fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt.bytes); // outside the workspace: given as the first prompt
  const record = {
    arm, stage: Number(stage), preparedAt: new Date().toISOString(), model: MODEL,
    base: arm === 'a' ? null : BASE,
    inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.sha256])),
    prompt: promptName, gf,
    versions: { node: process.version, claude: toolVersion('claude'), bwrap: toolVersion('bwrap'), docker: toolVersion('docker') },
    deviations: arm === 'a' ? [] : ['engine export excludes .eccode/ as well as docs/: with the repository\'s own record present, init is refused (GF-INIT-1)'],
    notStarted: 'This tool does not start a model. The sandbox (plan 3.1) and the launch are the operator\'s next step on a host with bubblewrap.',
    launch: ['claude', '-p', '--model', MODEL, '--permission-mode', 'bypassPermissions'],
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { runDir, workspace, record };
}

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i += 1; } else rest.push(argv[i]);
  }
  return { cmd: rest[0], flags };
}

function main(argv) {
  const { cmd, flags } = parse(argv);
  if (cmd === 'order') {
    process.stdout.write(`${order(flags.seed).join(' ')}\n`);
    return 0;
  }
  if (cmd === 'prepare') {
    const res = prepare(flags);
    process.stdout.write(`${JSON.stringify({ runDir: res.runDir, ...res.record }, null, 2)}\n`);
    return 0;
  }
  process.stderr.write('usage: s4-operator.js order --seed <text> | prepare --arm a|b|c --out <dir> [--stage 1|2] [--repo <dir>]\n');
  return 1;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) {
    if (!(err instanceof OperatorError)) throw err;
    process.stderr.write(`s4-operator: ${err.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { order, prepare, frozenInputs, BASE, AUTO, FILES, OperatorError };
