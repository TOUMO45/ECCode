'use strict';
// Paired benchmark: the same agent command runs the same tasks in sandboxes
// WITH the lean-change discipline prepended to the prompt and WITHOUT it, and
// the harness measures what the agent cannot self-report: hidden checks the
// sandbox never contains, lines added, dependencies added, tests written and
// wall time. It reports paired per-task results with sample sizes and never
// invents a saving. The agent command is supplied by the user; this module
// never chooses or bills a model itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { EccodeError, readJson, ensureDir, toPosix } = require('./util');
const lean = require('./lean');

const DEFAULT_SUITE = path.join(__dirname, '..', 'bench', 'tasks');

function git(dir, args) {
  return execFileSync('git', ['-c', 'user.email=bench@eccode', '-c', 'user.name=eccode-bench', ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

function listTasks(suite) {
  if (!fs.existsSync(suite)) throw new EccodeError('NOT_FOUND', `No benchmark suite at ${suite}`);
  return fs.readdirSync(suite)
    .filter((d) => fs.existsSync(path.join(suite, d, 'task.json')))
    .map((d) => ({ dir: path.join(suite, d), ...readJson(path.join(suite, d, 'task.json')) }));
}

function leanPrompt() {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'lean-change', 'SKILL.md'), 'utf8');
  return `Follow this working discipline exactly while solving the task (ignore the eccode CLI commands it mentions; they are not installed here):\n\n${skill.replace(/^---[\s\S]*?---\n/, '')}\n\n---\n\n`;
}

/** Manifest dependency names across the sandbox, for before/after comparison. */
function depsOf(dir) {
  const all = new Set();
  for (const f of lean.listFiles(dir)) {
    if (!/(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(f)) continue;
    const text = lean.readText(dir, f);
    if (text) for (const d of lean.dependencyNames(f, text)) all.add(`${f}:${d}`);
  }
  return all;
}

/** One agent run in a fresh sandbox; returns the measured record. */
function runOnce(task, { agentCmd, variant, timeoutMs = 900000, keep = false }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-bench-${task.id}-${variant}-`));
  copyDir(path.join(task.dir, 'fixture'), sandbox);
  const prompt = (variant === 'with' ? leanPrompt() : '') + task.prompt.trim() + '\n';
  fs.writeFileSync(path.join(sandbox, 'PROMPT.md'), prompt);
  git(sandbox, ['init', '-q']);
  git(sandbox, ['add', '-A']);
  git(sandbox, ['commit', '-q', '-m', 'fixture']);
  const depsBefore = depsOf(sandbox);
  const started = Date.now();
  const agent = spawnSync(agentCmd, {
    cwd: sandbox,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ECCODE_BENCH_PROMPT: path.join(sandbox, 'PROMPT.md'), ECCODE_BENCH_VARIANT: variant },
  });
  const durationMs = Date.now() - started;
  // Measure the diff before the hidden checks arrive.
  git(sandbox, ['add', '-A']);
  let linesAdded = 0;
  let linesRemoved = 0;
  const changed = [];
  for (const row of git(sandbox, ['diff', '--cached', '--numstat']).split('\n').filter(Boolean)) {
    const [a, r, f] = row.split('\t');
    if (f === 'PROMPT.md') continue;
    changed.push(f);
    if (a !== '-') {
      linesAdded += Number(a);
      linesRemoved += Number(r);
    }
  }
  const newDeps = [...depsOf(sandbox)].filter((d) => !depsBefore.has(d)).map((d) => d.split(':').pop());
  const hiddenDir = path.join(task.dir, 'hidden');
  if (fs.existsSync(hiddenDir)) copyDir(hiddenDir, path.join(sandbox, '.bench-hidden'));
  const checks = (task.hiddenChecks || []).map((command) => {
    const r = spawnSync(command, { cwd: sandbox, shell: true, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
    return { command, passed: r.status === 0, tail: `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-6).join('\n') };
  });
  const record = {
    task: task.id,
    variant,
    agentExit: typeof agent.status === 'number' ? agent.status : 1,
    durationMs,
    hiddenPassed: checks.filter((c) => c.passed).length,
    hiddenTotal: checks.length,
    linesAdded,
    linesRemoved,
    filesChanged: changed.length,
    testFilesChanged: changed.filter((f) => lean.TEST.test(toPosix(f))).length,
    newDeps,
    checks,
    sandbox: keep ? sandbox : null,
  };
  if (!keep) fs.rmSync(sandbox, { recursive: true, force: true });
  return record;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

function summarize(records) {
  const cell = {};
  for (const r of records) {
    const k = `${r.task}|${r.variant}`;
    (cell[k] = cell[k] || []).push(r);
  }
  const rows = [];
  for (const [k, rs] of Object.entries(cell)) {
    const [task, variant] = k.split('|');
    rows.push({
      task,
      variant,
      n: rs.length,
      hidden: `${rs.reduce((n, r) => n + r.hiddenPassed, 0)}/${rs.reduce((n, r) => n + r.hiddenTotal, 0)}`,
      medianLines: median(rs.map((r) => r.linesAdded)),
      medianSeconds: Math.round(median(rs.map((r) => r.durationMs)) / 1000),
      runsWithNewDeps: rs.filter((r) => r.newDeps.length).length,
      runsWithTests: rs.filter((r) => r.testFilesChanged > 0).length,
    });
  }
  return rows;
}

function report(records, { agentCmd }) {
  const rows = summarize(records);
  const tasks = [...new Set(rows.map((r) => r.task))];
  const lines = [
    '# ECCode paired benchmark',
    '',
    `Agent command: \`${agentCmd}\`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. Small n means a demonstration, not a statistic — read the raw rows, not just the medians.`,
    '',
    '| Task | Variant | n | Hidden checks | Median lines added | Runs adding a dependency | Runs changing a test | Median seconds |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const t of tasks) {
    for (const v of ['without', 'with']) {
      const r = rows.find((x) => x.task === t && x.variant === v);
      if (r) lines.push(`| ${t} | ${v} | ${r.n} | ${r.hidden} | ${r.medianLines} | ${r.runsWithNewDeps}/${r.n} | ${r.runsWithTests}/${r.n} | ${r.medianSeconds} |`);
    }
    const a = rows.find((x) => x.task === t && x.variant === 'without');
    const b = rows.find((x) => x.task === t && x.variant === 'with');
    if (a && b && a.medianLines !== null && b.medianLines !== null) {
      lines.push(`| ${t} | **paired Δ** |  |  | ${b.medianLines - a.medianLines >= 0 ? '+' : ''}${b.medianLines - a.medianLines} |  |  |  |`);
    }
  }
  const pairedWins = tasks.map((t) => {
    const a = rows.find((x) => x.task === t && x.variant === 'without');
    const b = rows.find((x) => x.task === t && x.variant === 'with');
    return a && b && a.medianLines !== null && b.medianLines !== null ? Math.sign(a.medianLines - b.medianLines) : 0;
  });
  const wins = pairedWins.filter((x) => x > 0).length;
  const losses = pairedWins.filter((x) => x < 0).length;
  lines.push('', `Paired medians across ${tasks.length} task(s): the "with" variant produced the smaller diff on ${wins}, the larger on ${losses}, equal on ${tasks.length - wins - losses}. Sign counts, not significance.`);
  lines.push('', '## Raw runs', '', '| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit |', '|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    lines.push(`| ${r.task} | ${r.variant} | ${r.hiddenPassed}/${r.hiddenTotal} | +${r.linesAdded}/−${r.linesRemoved} | ${r.newDeps.join(', ') || '—'} | ${r.testFilesChanged} | ${Math.round(r.durationMs / 1000)} | ${r.agentExit} |`);
  }
  const failed = records.flatMap((r) => r.checks.filter((c) => !c.passed).map((c) => `- ${r.task} (${r.variant}): \`${c.command}\`\n  \`\`\`\n${c.tail.trim()}\n  \`\`\``));
  if (failed.length) lines.push('', '## Failed hidden checks', '', ...failed);
  return lines.join('\n') + '\n';
}

function run({ suite = DEFAULT_SUITE, agentCmd, tasks: only, runs = 1, variants = ['without', 'with'], timeoutMs, keep, onProgress }) {
  if (!agentCmd) throw new EccodeError('INVALID_INPUT', 'bench requires --agent "<command run inside each sandbox>" (it must read PROMPT.md, e.g. claude -p "$(cat PROMPT.md)")');
  const tasks = listTasks(suite).filter((t) => !only || only.includes(t.id));
  if (!tasks.length) throw new EccodeError('NOT_FOUND', 'No matching benchmark tasks');
  const records = [];
  for (const task of tasks) {
    for (const variant of variants) {
      for (let i = 0; i < runs; i++) {
        if (onProgress) onProgress(`${task.id} ${variant} run ${i + 1}/${runs}`);
        records.push(runOnce(task, { agentCmd, variant, timeoutMs, keep }));
      }
    }
  }
  return { records, markdown: report(records, { agentCmd }) };
}

module.exports = { run, runOnce, listTasks, summarize, report, leanPrompt, DEFAULT_SUITE };
