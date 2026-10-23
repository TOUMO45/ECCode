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
  let testLinesAdded = 0; // the part of linesAdded that is in test files
  const changed = [];
  for (const row of git(sandbox, ['diff', '--cached', '--numstat']).split('\n').filter(Boolean)) {
    const [a, r, f] = row.split('\t');
    if (f === 'PROMPT.md') continue;
    changed.push(f);
    if (a !== '-') {
      linesAdded += Number(a);
      linesRemoved += Number(r);
      if (lean.TEST.test(toPosix(f))) testLinesAdded += Number(a);
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
    testLinesAdded,
    filesChanged: changed.length,
    testFilesChanged: changed.filter((f) => lean.TEST.test(toPosix(f))).length,
    newDeps,
    checks,
    sandbox: keep ? sandbox : null,
  };
  if (!keep) fs.rmSync(sandbox, { recursive: true, force: true });
  return record;
}

/**
 * Exact two-sided permutation test on the difference of MEANS between the two
 * variants' per-run lines-added (the mean is the standard, sensitive choice;
 * the summary table still shows medians). Every C(n, k) relabeling is
 * enumerated (guarded by a cap), so the p-value is exact, not asymptotic:
 * with 5 runs a side, the smallest attainable p is 2/252 ~= 0.008.
 */
// Deterministic PRNG shared by the Monte Carlo fallbacks, so published
// p-values reproduce exactly from the same data.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutationTest(a, b, cap = 200000) {
  if (!a.length || !b.length) return null;
  const all = [...a, ...b];
  const mean = (xs) => xs.reduce((n, x) => n + x, 0) / xs.length;
  const observed = Math.abs(mean(a) - mean(b));
  // When the exact enumeration would exceed the cap (C(|a|+|b|, |a|) splits),
  // fall back to a seeded Monte Carlo permutation test instead of silence.
  let exactSplits = 1;
  for (let i = 1; i <= Math.min(a.length, b.length); i++) exactSplits = (exactSplits * (all.length - Math.min(a.length, b.length) + i)) / i;
  if (exactSplits > cap) {
    const resamples = 100000;
    const rand = mulberry32(42);
    let extreme = 0;
    for (let r = 0; r < resamples; r++) {
      const arr = all.slice();
      for (let j = arr.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [arr[j], arr[k]] = [arr[k], arr[j]];
      }
      if (Math.abs(mean(arr.slice(0, a.length)) - mean(arr.slice(a.length))) >= observed - 1e-9) extreme += 1;
    }
    return { p: (extreme + 1) / (resamples + 1), splits: resamples, monteCarlo: true, atFloor: extreme === 0 }; // atFloor: no resample was as extreme, so p is an upper bound
  }
  const idx = [];
  let count = 0;
  let extreme = 0;
  const choose = (start, need) => {
    if (count > cap) return;
    if (!need) {
      count += 1;
      const inA = new Set(idx);
      const xa = [];
      const xb = [];
      all.forEach((v, i) => (inA.has(i) ? xa : xb).push(v));
      if (Math.abs(mean(xa) - mean(xb)) >= observed - 1e-9) extreme += 1;
      return;
    }
    for (let i = start; i <= all.length - need; i++) {
      idx.push(i);
      choose(i + 1, need - 1);
      idx.pop();
    }
  };
  choose(0, a.length);
  return count > cap ? null : { p: extreme / count, splits: count };
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
      medianCodeLines: rs.every((r) => typeof r.testLinesAdded === 'number') ? median(rs.map(codeLines)) : null,
      medianSeconds: Math.round(median(rs.map((r) => r.durationMs)) / 1000),
      runsWithNewDeps: rs.filter((r) => r.newDeps.length).length,
      runsWithTests: rs.filter((r) => r.testFilesChanged > 0).length,
    });
  }
  for (const task of new Set(records.map((r) => r.task))) {
    const lines = (v) => records.filter((r) => r.task === task && r.variant === v).map((r) => r.linesAdded);
    const test = permutationTest(lines('with'), lines('without'));
    const code = (v) => records.filter((r) => r.task === task && r.variant === v).map(codeLines);
    const known = records.filter((r) => r.task === task).every((r) => typeof r.testLinesAdded === 'number');
    const codeTest = known ? permutationTest(code('with'), code('without')) : null;
    for (const row of rows.filter((x) => x.task === task)) Object.assign(row, { permutation: test, codePermutation: codeTest });
  }
  return rows;
}

// Lines added outside test files: separates "wrote more code" from "wrote the
// test the bare prompt skipped", which total lines added cannot tell apart.
function codeLines(r) {
  return r.linesAdded - r.testLinesAdded;
}

function pText(perm) {
  return perm.monteCarlo
    ? `Monte Carlo permutation p${perm.atFloor ? '≤' : '='}${perm.p < 0.001 ? perm.p.toExponential(2) : perm.p.toFixed(4)} over ${perm.splits} seeded resamples`
    : `exact permutation p=${perm.p.toFixed(3)} over ${perm.splits} splits`;
}

function report(records, { agentCmd }) {
  const rows = summarize(records);
  const tasks = [...new Set(rows.map((r) => r.task))];
  const minN = Math.min(...rows.filter((r) => r.variant !== 'paired Δ').map((r) => r.n));
  const anyMonteCarlo = rows.some((r) => r.permutation && r.permutation.monteCarlo);
  const nNote = minN >= 10
    ? `Each variant ran n >= ${minN} times per task. ${anyMonteCarlo
      ? 'Where every split can be enumerated the permutation test is exact; above that it is a seeded Monte Carlo permutation test (each row says which), and "p≤" marks a p-value at the resampling floor.'
      : 'The exact permutation test enumerates every split, so the p-values are exact, not asymptotic.'} Read the raw rows alongside the medians.`
    : 'Small n means a demonstration, not a statistic — read the raw rows, not just the medians.';
  const lines = [
    '# ECCode paired benchmark',
    '',
    `Agent command: \`${agentCmd}\`. "with" prepends the lean-change skill text to the prompt; "without" is the bare prompt. Hidden checks never exist in the sandbox while the agent works. ${nNote}`,
    '',
    '| Task | Variant | n | Hidden checks | Median lines added | Median code lines added (tests excluded) | Runs adding a dependency | Runs changing a test | Median seconds |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  const signed = (d) => `${d >= 0 ? '+' : ''}${d}`;
  for (const t of tasks) {
    for (const v of ['without', 'with']) {
      const r = rows.find((x) => x.task === t && x.variant === v);
      if (r) lines.push(`| ${t} | ${v} | ${r.n} | ${r.hidden} | ${r.medianLines} | ${r.medianCodeLines === null ? '—' : r.medianCodeLines} | ${r.runsWithNewDeps}/${r.n} | ${r.runsWithTests}/${r.n} | ${r.medianSeconds} |`);
    }
    const a = rows.find((x) => x.task === t && x.variant === 'without');
    const b = rows.find((x) => x.task === t && x.variant === 'with');
    if (a && b && a.medianLines !== null && b.medianLines !== null) {
      const perm = b.permutation ? ` (${pText(b.permutation)})` : '';
      const code = a.medianCodeLines !== null && b.medianCodeLines !== null
        ? `${signed(b.medianCodeLines - a.medianCodeLines)}${b.codePermutation ? ` (${pText(b.codePermutation)})` : ''}`
        : '—';
      lines.push(`| ${t} | **paired Δ** |  |  | ${signed(b.medianLines - a.medianLines)}${perm} | ${code} |  |  |  |`);
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
  lines.push('', '## Raw runs', '', '| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    lines.push(`| ${r.task} | ${r.variant} | ${r.hiddenPassed}/${r.hiddenTotal} | +${r.linesAdded}/−${r.linesRemoved} | ${r.newDeps.join(', ') || '—'} | ${r.testFilesChanged} | ${Math.round(r.durationMs / 1000)} | ${r.agentExit} | ${typeof r.testLinesAdded === 'number' ? r.testLinesAdded : '—'} |`);
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

// Stratified permutation test over every recorded raw run: variant labels are
// shuffled only WITHIN each task-batch (one report file x one task), so batch
// and task effects cancel and batches are never treated as independent samples
// of one another. Statistic: the unweighted mean over strata of
// (mean lines added with) - (mean lines added without). Seeded Monte Carlo.
function stratifiedTest(rows, { resamples = 20000, seed = 42 } = {}) {
  const strata = new Map();
  for (const r of rows) {
    if (!strata.has(r.stratum)) strata.set(r.stratum, { with: [], without: [] });
    const s = strata.get(r.stratum);
    if (s[r.variant]) s[r.variant].push(r.lines);
  }
  const usable = [...strata.values()].filter((s) => s.with.length && s.without.length);
  if (!usable.length) return null;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stat = (groups) => mean(groups.map((g) => mean(g.with) - mean(g.without)));
  const observed = stat(usable);
  const rand = mulberry32(seed); // deterministic, so a reported p reproduces exactly
  const pools = usable.map((s) => ({ all: s.with.concat(s.without), nWith: s.with.length }));
  let extreme = 0;
  for (let i = 0; i < resamples; i++) {
    const groups = pools.map(({ all, nWith }) => {
      const a = all.slice();
      for (let j = a.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [a[j], a[k]] = [a[k], a[j]];
      }
      return { with: a.slice(0, nWith), without: a.slice(nWith) };
    });
    if (Math.abs(stat(groups)) >= Math.abs(observed) - 1e-12) extreme += 1;
  }
  return { delta: observed, p: (extreme + 1) / (resamples + 1), atFloor: extreme === 0, resamples, strata: usable.length, runs: usable.reduce((n, s) => n + s.with.length + s.without.length, 0) };
}

// Recompute the headline numbers from recorded report files, so claims about
// past runs are derived from the records on disk rather than remembered.
// Raw-run rows are | Task | Variant | Hidden | Lines | New deps | Test files | Seconds | Agent exit |,
// plus | Lines added in tests | in reports written since that column was added.
function tally(dir) {
  const rows = [];
  const perFile = [];
  const total = { files: 0, runs: 0, hiddenPassed: 0, hiddenTotal: 0, depRuns: 0, agentFailures: 0, pairedSmaller: 0, pairedLarger: 0, pairedEqual: 0 };
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    const raw = text.split(/^## Raw runs$/m)[1];
    if (!raw) continue;
    // The model is the one the report's agent command names; effects are
    // reported per model, because pooling models can hide opposite effects.
    const model = (text.match(/--model\s+([\w.-]+)/) || [])[1] || 'unknown';
    const f = { file: name, model, runs: 0, hiddenPassed: 0, hiddenTotal: 0, depRuns: 0, agentFailures: 0 };
    for (const line of raw.split(/\n## /)[0].split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 10 || !/^\d+\/\d+$/.test(cells[3])) continue; // header, separator and summary rows fall out here
      const [passed, ran] = cells[3].split('/').map(Number);
      f.runs += 1;
      f.hiddenPassed += passed;
      f.hiddenTotal += ran;
      if (cells[5] && cells[5] !== '—' && cells[5] !== '-') f.depRuns += 1;
      if (cells[8] !== '0') f.agentFailures += 1;
      const lines = (cells[4].match(/\+(\d+)/) || [])[1];
      if ((cells[2] === 'with' || cells[2] === 'without') && lines !== undefined) {
        const inTests = /^\d+$/.test(cells[9] || '') ? Number(cells[9]) : null;
        rows.push({ stratum: `${name}|${cells[1]}`, model, variant: cells[2], lines: Number(lines), codeLines: inTests === null ? null : Number(lines) - inTests, wroteTests: Number(cells[6]) > 0 });
      }
    }
    perFile.push(f);
    total.files += 1;
    for (const k of ['runs', 'hiddenPassed', 'hiddenTotal', 'depRuns', 'agentFailures']) total[k] += f[k];
  }
  // Paired-median signs per task-batch, derived from the raw runs (never from
  // a report's own summary cells): negative = with-variant smaller diff.
  const byStratum = new Map();
  for (const r of rows) {
    if (!byStratum.has(r.stratum)) byStratum.set(r.stratum, { with: [], without: [] });
    byStratum.get(r.stratum)[r.variant].push(r.lines);
  }
  for (const g of byStratum.values()) {
    if (!g.with.length || !g.without.length) continue;
    const d = median(g.with) - median(g.without);
    total[d < 0 ? 'pairedSmaller' : d > 0 ? 'pairedLarger' : 'pairedEqual'] += 1;
  }
  const byModel = {};
  for (const m of [...new Set(rows.map((r) => r.model))].sort()) {
    const mine = rows.filter((r) => r.model === m);
    const tests = (v) => { const vr = mine.filter((r) => r.variant === v); return { wrote: vr.filter((r) => r.wroteTests).length, runs: vr.length }; };
    // Tests excluded, over the runs whose reports record test lines.
    const code = mine.filter((r) => r.codeLines !== null).map((r) => ({ ...r, lines: r.codeLines }));
    byModel[m] = { runs: mine.length, stratified: stratifiedTest(mine), codeStratified: stratifiedTest(code), testsWith: tests('with'), testsWithout: tests('without') };
  }
  return { perFile, total, stratified: stratifiedTest(rows), byModel };
}

module.exports = { run, tally, stratifiedTest, runOnce, listTasks, summarize, report, leanPrompt, permutationTest, DEFAULT_SUITE };
