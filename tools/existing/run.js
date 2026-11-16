#!/usr/bin/env node
'use strict';
// Existing-codebase pilot (W4) runner. Protocol: docs/build/existing-codebase-pilot.md. One run per call.
//   node tools/existing/run.js --task t1|t2|t3 --arm w|k|s --run <n> --out <dir outside the repositories>
//                              [--skill <Supervisor-Skill checkout>]  (arm k)  [--wall-minutes <n, default 45>]
// The agent gets a copy of this repository as it was at BASE (before the three changes existed) and one task file.
// Afterwards the hidden oracle scores the new behaviour, and the BASE test suite is run against the agent's tree to
// count what it broke.
//   w  weak model alone      k  weak model + the autonomous-supervisor skill      s  strong model alone
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HERE = __dirname;
const REPO = path.join(HERE, '..', '..');
const META = JSON.parse(fs.readFileSync(path.join(HERE, 'base.json'), 'utf8'));
const MODELS = { w: 'claude-haiku-5-5', k: 'claude-haiku-5-5', s: 'claude-sonnet-5-5' };
const TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'Read', 'Glob', 'Grep', 'Task', 'Agent', 'Skill', 'TodoWrite'];
const PROMPT = 'This directory is the ECCode repository. Make the change described in TASK.md. I am unreachable, so do not ask me anything: decide and finish.';
const K_PREFIX = 'Use the autonomous-supervisor skill for this work.\n\n';
const WIN = process.platform === 'win32';
const quote = (a) => (a === '' ? '""' : /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function flags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i += 2) f[argv[i].replace(/^--/, '')] = argv[i + 1];
  return f;
}

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });

/** The repository as it was at the base commit, exported once per output folder. */
function baseTree(out) {
  const dest = path.join(out, 'base-tree');
  if (fs.existsSync(path.join(dest, 'bin', 'eccode.js'))) return dest;
  if (git(REPO, 'cat-file', '-e', `${META.base}^{commit}`).status !== 0) {
    const f = git(REPO, 'fetch', '--depth', '1', 'origin', META.base);
    if (f.status !== 0) throw new Error(`could not fetch the base commit ${META.base}: ${f.stderr.trim().split('\n').pop()}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  const tar = execFileSync('git', ['-C', REPO, 'archive', META.base], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dest, '--exclude=.eccode', '--exclude=.supervisor'], { input: tar });
  return dest;
}

function freeGb(dir) {
  try { const st = fs.statfsSync(dir); return (st.bavail * st.bsize) / 2 ** 30; } catch { return Infinity; }
}

/** Names of the failing tests when the BASE test files run against `tree`. */
function failing(tree, baseDir, scratch, ignore = new Set()) {
  // On Windows a test's leftover child process can keep the folder locked: never reuse a name, and clean up best-effort.
  scratch = `${scratch}-${Date.now().toString(36)}`;
  fs.cpSync(tree, scratch, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|\.eccode)$/.test(src) });
  fs.rmSync(path.join(scratch, 'tests'), { recursive: true, force: true });
  fs.cpSync(path.join(baseDir, 'tests'), path.join(scratch, 'tests'), { recursive: true });
  // Tests leave many folders in the system temp directory; give them one of our own and delete it afterwards.
  const tmp = path.join(path.dirname(scratch), `t${Date.now().toString(36)}`); // short: some tests need short socket paths
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  const files = fs.readdirSync(path.join(scratch, 'tests')).filter((n) => n.endsWith('.test.js')).sort().map((n) => path.join('tests', n));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: scratch, env, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 40 * 60 * 1000 });
  const text = r.stdout || '';
  const names = new Set();
  for (const line of text.split('\n')) {
    const m = /^\s*not ok \d+ - (.*?)(\s+#.*)?$/.exec(line);
    if (m) names.add(m[1].trim().replace(/\\/g, '/'));
  }
  const total = /^# tests (\d+)/m.exec(text);
  // A few tests are sensitive to machine load. A test counts as failing only if it fails again when run on its own.
  const suspects = [...names].filter((n) => !ignore.has(n) && !/\.test\.js$/.test(n));
  if (total && suspects.length && suspects.length <= 40) {
    const esc = (n) => `^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    const again = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...suspects.flatMap((n) => ['--test-name-pattern', esc(n)]), ...files],
      { cwd: scratch, env, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 40 * 60 * 1000 });
    const still = new Set();
    for (const line of (again.stdout || '').split('\n')) {
      const m = /^\s*not ok \d+ - (.*?)(\s+#.*)?$/.exec(line);
      if (m) still.add(m[1].trim().replace(/\\/g, '/'));
    }
    if (/^# tests \d+/m.test(again.stdout || '')) for (const n of suspects) if (!still.has(n)) names.delete(n);
  }
  for (const d of [scratch, tmp]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left behind */ } }
  // A full disk makes hundreds of unrelated tests fail: that is not a measurement.
  const diskFull = /ENOSPC|not enough space on the disk|no space left on device/i.test(`${text}${r.stderr || ''}`) || freeGb(path.dirname(scratch)) < 1;
  return { names: [...names].sort(), total: total ? Number(total[1]) : null, finished: Boolean(total) && !diskFull, diskFull };
}

function baseline(out, baseDir) {
  const file = path.join(out, 'baseline.json');
  // A baseline measured before the suite got its own temp folder is not comparable: measure again.
  if (fs.existsSync(file)) { const old = JSON.parse(fs.readFileSync(file, 'utf8')); if (old.method === 2) return old; }
  process.stdout.write('  measuring the base test suite on this machine (once, several minutes)...\n');
  const b = failing(baseDir, baseDir, path.join(out, 'scratch-baseline'));
  if (!b.finished) throw new Error('the base test suite did not finish on this machine: no baseline, no run');
  b.method = 2;
  fs.writeFileSync(file, `${JSON.stringify(b, null, 2)}\n`);
  return b;
}

function supervisorPlugin(skillRepo, dest) {
  if (!fs.existsSync(path.join(dest, 'skills'))) {
    fs.mkdirSync(dest, { recursive: true });
    for (const part of ['.claude-plugin', 'skills']) fs.cpSync(path.join(skillRepo, part), path.join(dest, part), { recursive: true });
  }
  return dest;
}

function main() {
  const f = flags(process.argv.slice(2));
  const { task, arm } = f;
  if (!META.allowed[task] || !MODELS[arm] || !f.run || !f.out) throw new Error('usage: run.js --task t1|t2|t3 --arm w|k|s --run <n> --out <dir> [--skill <Supervisor-Skill checkout>] [--wall-minutes <n>]');
  const out = path.resolve(f.out);
  for (const repo of [REPO, f.skill].filter(Boolean)) {
    const rel = path.relative(path.resolve(repo), out);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`--out must be outside ${path.resolve(repo)}: the agent must not be able to find the oracle or the reference`);
  }
  const dir = path.join(out, `${task}-${arm}-${f.run}`);
  const ws = path.join(dir, 'workspace');
  // --rescore yes: score an existing run's workspace again (the agent is not run again). For runs whose scoring was
  // spoiled by the machine, for example a full disk.
  const rescore = f.rescore === 'yes';
  if (rescore && !fs.existsSync(path.join(dir, 'transcript.jsonl'))) throw new Error(`${dir} has no finished agent run to rescore`);
  if (!rescore && fs.existsSync(dir)) throw new Error(`${dir} exists: a run is done once`);
  fs.mkdirSync(out, { recursive: true });
  const free = freeGb(out);
  if (free < 4) throw new Error(`only ${free.toFixed(1)} GB free on the drive of ${out}: free at least 4 GB first, a full disk spoils the test-suite measurement`);
  const baseDir = baseTree(out);
  const base = baseline(out, baseDir);
  if (rescore) return scoreRun({ f, task, arm, out, dir, ws, baseDir, base, prev: JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')), text: fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8') });

  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(baseDir, ws, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'tasks', `${task}.md`), path.join(ws, 'TASK.md'));
  for (const a of [['init', '-q'], ['config', 'user.email', 'pilot@example.invalid'], ['config', 'user.name', 'pilot'], ['config', 'core.autocrlf', 'false'], ['add', '-A'], ['commit', '-qm', 'ECCode at the pilot base, with TASK.md']]) git(ws, ...a);

  const args = ['-p', '--model', MODELS[arm], '--setting-sources', '', '--strict-mcp-config', '--allowedTools', ...TOOLS,
    '--max-turns', '200', '--output-format', 'stream-json', '--verbose'];
  let prompt = PROMPT;
  if (arm === 'k') {
    if (!f.skill) throw new Error('arm k needs --skill <Supervisor-Skill checkout>');
    args.push('--plugin-dir', supervisorPlugin(path.resolve(f.skill), path.join(out, 'supervisor-plugin')));
    prompt = K_PREFIX + PROMPT;
  }
  const wallMs = (f['wall-minutes'] ? Number(f['wall-minutes']) : 45) * 60 * 1000;
  const started = Date.now();
  const r = WIN
    ? spawnSync(['claude', ...args.map(quote)].join(' '), { cwd: ws, input: prompt, encoding: 'utf8', timeout: wallMs, maxBuffer: 1 << 30, shell: true })
    : spawnSync('claude', args, { cwd: ws, input: prompt, encoding: 'utf8', timeout: wallMs, maxBuffer: 1 << 30 });
  if (r.error && r.error.code !== 'ETIMEDOUT') throw new Error(`could not start claude: ${r.error.message}`);
  const wall = Math.round((Date.now() - started) / 1000);
  const text = r.stdout || '';
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), text);
  return scoreRun({ f, task, arm, out, dir, ws, baseDir, base, text, prev: { prompt, exit: r.status, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), wallSeconds: wall, wallLimitMinutes: wallMs / 60000 } });
}

function scoreRun({ f, task, arm, out, dir, ws, baseDir, base, text, prev }) {
  let last = null; let toolCalls = 0; let assistantMessages = 0; let usedSkill = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'result') last = o;
    if (o.type === 'assistant') assistantMessages += 1;
    for (const b of (o.message && Array.isArray(o.message.content) ? o.message.content : [])) {
      if (b.type !== 'tool_use') continue;
      toolCalls += 1;
      const input = JSON.stringify(b.input || {});
      if ((b.name === 'Skill' && /autonomous-supervisor/.test(input)) || (b.name === 'Bash' && /supervisor\.py/.test(input))) usedSkill = true;
    }
  }

  const otmp = path.join(out, `scratch-oracle-${Date.now().toString(36)}`);
  fs.mkdirSync(otmp, { recursive: true });
  const oracle = spawnSync(process.execPath, [path.join(HERE, 'oracle.js'), task, ws], { encoding: 'utf8', timeout: 20 * 60 * 1000, env: { ...process.env, TEMP: otmp, TMP: otmp, TMPDIR: otmp } });
  try { fs.rmSync(otmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* left behind */ }
  const m = /SCORE (\d+)\/(\d+)/.exec(oracle.stdout || '');
  process.stdout.write('  running the base test suite against the result (several minutes)...\n');
  const expected = new Set([...base.names, ...META.allowed[task]]);
  const after = failing(ws, baseDir, path.join(out, `scratch-${task}-${arm}-${f.run}`), expected);
  const broke = after.finished ? after.names.filter((n) => !expected.has(n)) : null;
  const changed = git(ws, 'status', '--porcelain').stdout.split('\n').filter((l) => l.trim() && !/\.eccode\/|\.supervisor\//.test(l)).map((l) => l.slice(3));
  const full = Boolean(m && m[1] === m[2]);
  const result = {
    project: `existing-${task}`, task, arm, run: Number(f.run), model: MODELS[arm], base: META.base, prompt: prev.prompt,
    exit: prev.exit, timedOut: prev.timedOut, wallSeconds: prev.wallSeconds, wallLimitMinutes: prev.wallLimitMinutes, rescored: Boolean(f.rescore === 'yes'),
    turns: last ? last.num_turns : null, assistantMessages, costUsd: last ? last.total_cost_usd : null, stopReason: last ? last.subtype : null,
    toolCalls, usedSkill: arm === 'k' ? usedSkill : null,
    contaminated: /tools[\\/]+existing|oracle\.js|reference[\\/]+t\d\.patch/.test(text),
    oracle: m ? { passed: Number(m[1]), total: Number(m[2]) } : null,
    failed: (oracle.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.slice(0, 240)),
    suiteFinished: after.finished, diskFull: after.diskFull, broke, filesChanged: changed,
    solved: full && after.finished && broke.length === 0,
    oracleTail: (oracle.stdout || oracle.stderr || '').trim().split('\n').slice(-3),
    finalMessage: last && typeof last.result === 'string' ? last.result.slice(0, 1500) : null,
  };
  if (f.rescore === 'yes') fs.copyFileSync(path.join(dir, 'result.json'), path.join(dir, `result.before-rescore-${Date.now().toString(36)}.json`));
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const cost = result.costUsd === null ? 'n/a' : result.costUsd.toFixed(2);
  process.stdout.write(`${task} ${arm}${f.run}: ${result.solved ? 'SOLVED' : 'not solved'}  new ${m ? `${m[1]}/${m[2]}` : 'n/a'}  broke ${broke === null ? (after.diskFull ? 'NOT MEASURED (disk full)' : 'suite did not finish') : broke.length}  cost ${cost}  ${result.turns} turns  ${result.wallSeconds}s${result.timedOut ? '  TIMED OUT' : ''}${arm === 'k' ? `  skill:${usedSkill}` : ''}  contaminated:${result.contaminated}\n`);
  for (const n of (broke || []).slice(0, 8)) process.stdout.write(`    broke: ${n.slice(0, 150)}\n`);
}

try { main(); } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; }
