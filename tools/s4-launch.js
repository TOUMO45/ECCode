#!/usr/bin/env node
'use strict';
// S4 (Meterline) arm sandbox and launch, plan section 3.1. An arm runs as one process tree inside bubblewrap that
// can see only: its own workspace, its own home and Claude config directory, the toolchain (read-only) and the
// network. It cannot see the ECCode checkout, the hidden material, another arm, or the operator's files.
//
//   node tools/s4-launch.js probe --run <dir>/arm-a [--deny <path> ...]   canary: proves the walls, writes sandbox-probe.json
//   node tools/s4-launch.js print --run <dir>/arm-a                       the exact command a start would run
//   node tools/s4-launch.js start --run <dir>/arm-a --approved-by-owner   starts the model (spends tokens)
//
// `start` refuses unless a passing probe of the same sandbox is on record and the owner flag is given.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

class LaunchError extends Error {}

const SYSTEM_RO = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/opt', '/etc/ssl', '/etc/ca-certificates', '/etc/alternatives',
  '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/localtime', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d'];
// Names only. Values are read from the operator's environment at start and are never written to any file.
const PASS_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'LANG', 'LC_ALL', 'TZ'];
const CA_ENV = ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];

function loadRun(runDir) {
  const dir = path.resolve(runDir || '');
  const file = path.join(dir, 'run.json');
  if (!runDir || !fs.existsSync(file)) throw new LaunchError(`no run.json in ${dir}: prepare the arm first (tools/s4-operator.js prepare)`);
  return { dir, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/** The bubblewrap argv for one arm. Pure: it reads the environment's names and the file system's shape only. */
function sandboxArgv(runDir, command, env = process.env) {
  const dir = path.resolve(runDir);
  const workspace = path.join(dir, 'workspace');
  const home = path.join(dir, 'home');
  const config = path.join(dir, 'claude-config');
  const args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--clearenv',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run'];
  for (const p of SYSTEM_RO) {
    if (!fs.existsSync(p)) continue;
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) args.push('--symlink', fs.readlinkSync(p), p);
    else args.push('--ro-bind', p, p);
  }
  const extra = new Set();
  for (const name of CA_ENV) if (env[name] && fs.existsSync(env[name])) extra.add(path.resolve(env[name]));
  for (const p of extra) args.push('--ro-bind', p, p);
  args.push('--bind', workspace, workspace, '--bind', home, home, '--bind', config, config, '--chdir', workspace);
  args.push('--setenv', 'HOME', home, '--setenv', 'CLAUDE_CONFIG_DIR', config,
    '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' + (fs.existsSync('/opt/node22/bin') ? ':/opt/node22/bin' : ''));
  for (const name of PASS_ENV) if (env[name] !== undefined) args.push('--setenv', name, env[name]);
  return { bwrap: 'bwrap', args: [...args, '--', ...command], workspace, home, config };
}

function ensureDirs(dir) {
  for (const d of ['home', 'claude-config']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  if (!fs.existsSync(path.join(dir, 'workspace'))) throw new LaunchError(`${dir} has no workspace`);
}

/** Paths an arm must never see: the checkout this tool runs from, the hidden material, its sibling arms, the operator's home. */
function defaultDenied(dir) {
  const siblings = fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith('arm-') && path.join(path.dirname(dir), n) !== dir)
    .map((n) => path.join(path.dirname(dir), n));
  return [path.resolve(__dirname, '..'), '/root/.cache/s4-hidden', path.join(dir, 'run.json'), path.join(dir, 'prompt.md'), ...siblings];
}

function probe(runDir, { deny = [], env = process.env } = {}) {
  const { dir } = loadRun(runDir);
  ensureDirs(dir);
  const denied = [...new Set([...defaultDenied(dir), ...deny.map((p) => path.resolve(p))])];
  // One canary inside the sandbox reports what it can do. Exit codes are not trusted: the operator reads the file system afterwards.
  const script = [
    'set -u', 'echo "uid=$(id -u)"',
    'if touch ./.s4-canary 2>/dev/null; then echo "write_workspace=yes"; else echo "write_workspace=no"; fi',
    'if touch /usr/.s4-canary 2>/dev/null; then echo "write_system=yes"; else echo "write_system=no"; fi',
    ...denied.map((p, i) => `if [ -e ${JSON.stringify(p)} ]; then echo "sees_${i}=yes"; else echo "sees_${i}=no"; fi`),
    'echo "env_names=$(env | cut -d= -f1 | sort | tr \'\\n\' \' \')"',
    'command -v node >/dev/null && echo "node=$(node --version)" || echo "node=missing"',
    'command -v claude >/dev/null && echo "claude=present" || echo "claude=missing"',
  ].join('\n');
  const sb = sandboxArgv(dir, ['sh', '-c', script], env);
  const r = spawnSync(sb.bwrap, sb.args, { encoding: 'utf8' });
  if (r.error) throw new LaunchError(`bubblewrap could not start: ${r.error.message}`);
  const got = Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const canary = path.join(sb.workspace, '.s4-canary');
  const wroteWorkspace = fs.existsSync(canary);
  if (wroteWorkspace) fs.unlinkSync(canary);
  const wroteSystem = fs.existsSync('/usr/.s4-canary');
  const visible = denied.filter((p, i) => got[`sees_${i}`] !== 'no');
  const envNames = (got.env_names || '').trim().split(/\s+/).filter(Boolean);
  const allowedEnv = new Set([...PASS_ENV, 'HOME', 'PATH', 'CLAUDE_CONFIG_DIR', 'PWD', 'SHLVL', '_', 'OLDPWD']);
  const strayEnv = envNames.filter((n) => !allowedEnv.has(n));
  const checks = {
    ran: r.status === 0 && got.uid !== undefined,
    workspaceWritable: wroteWorkspace && got.write_workspace === 'yes',
    systemReadOnly: !wroteSystem && got.write_system === 'no',
    deniedPathsInvisible: visible.length === 0,
    noStrayEnvironment: strayEnv.length === 0,
    toolchain: got.node !== 'missing' && got.node !== undefined,
  };
  const result = { at: new Date().toISOString(), ok: Object.values(checks).every(Boolean), checks, denied, visible, strayEnv,
    node: got.node || null, claude: got.claude || null, bwrap: (spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).stdout || '').trim(),
    stderr: r.stderr.trim().slice(0, 500) };
  fs.writeFileSync(path.join(dir, 'sandbox-probe.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function startCommand(runDir, env = process.env) {
  const { dir, record } = loadRun(runDir);
  if (!Array.isArray(record.launch) || record.launch[0] !== 'claude') throw new LaunchError('run.json has no launch command');
  return { dir, sb: sandboxArgv(dir, record.launch, env), promptFile: path.join(dir, 'prompt.md') };
}

function start(runDir, { approved, env = process.env } = {}) {
  const { dir, sb, promptFile } = startCommand(runDir, env);
  if (!approved) throw new LaunchError('start spends tokens: it needs --approved-by-owner (plan 9.2 ceiling: 500M total, pause at 400M)');
  const probeFile = path.join(dir, 'sandbox-probe.json');
  if (!fs.existsSync(probeFile) || JSON.parse(fs.readFileSync(probeFile, 'utf8')).ok !== true) {
    throw new LaunchError('no passing sandbox probe on record for this arm: run `probe` first');
  }
  if (fs.existsSync(path.join(dir, 'started.json'))) throw new LaunchError('this arm was already started: an arm runs once');
  ensureDirs(dir);
  fs.writeFileSync(path.join(dir, 'started.json'), `${JSON.stringify({ at: new Date().toISOString(), argvWithoutEnvValues: redact(sb.args) }, null, 2)}\n`);
  const out = fs.openSync(path.join(dir, 'stdout.log'), 'a');
  const err = fs.openSync(path.join(dir, 'stderr.log'), 'a');
  const r = spawnSync(sb.bwrap, sb.args, { input: fs.readFileSync(promptFile), stdio: ['pipe', out, err] });
  fs.writeFileSync(path.join(dir, 'finished.json'), `${JSON.stringify({ at: new Date().toISOString(), status: r.status, signal: r.signal }, null, 2)}\n`);
  return r.status;
}

/** The argv with every --setenv value of a passed-through variable hidden, safe to print or record. */
function redact(args) {
  const out = [...args];
  for (let i = 0; i < out.length - 2; i += 1) if (out[i] === '--setenv' && PASS_ENV.includes(out[i + 1])) out[i + 2] = '<from operator environment>';
  return out;
}

function main(argv) {
  const cmd = argv[0];
  const flags = { deny: [] };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--run') { flags.run = argv[i + 1]; i += 1; } else if (argv[i] === '--deny') { flags.deny.push(argv[i + 1]); i += 1; } else if (argv[i] === '--approved-by-owner') flags.approved = true;
  }
  if (cmd === 'probe') {
    const res = probe(flags.run, { deny: flags.deny });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res.ok ? 0 : 2;
  }
  if (cmd === 'print') {
    const { sb, promptFile } = startCommand(flags.run);
    process.stdout.write(`${JSON.stringify({ stdin: promptFile, command: [sb.bwrap, ...redact(sb.args)] }, null, 2)}\n`);
    return 0;
  }
  if (cmd === 'start') return start(flags.run, { approved: flags.approved });
  process.stderr.write('usage: s4-launch.js probe|print|start --run <dir>/arm-<a|b|c> [--deny <path>] [--approved-by-owner]\n');
  return 1;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) {
    if (!(err instanceof LaunchError)) throw err;
    process.stderr.write(`s4-launch: ${err.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { sandboxArgv, probe, start, startCommand, redact, LaunchError, PASS_ENV };
