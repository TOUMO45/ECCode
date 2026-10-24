'use strict';
// Mutation testing on the lines a change added: one small change at a time
// (a boundary, an equality, a logical operator, a boolean, + / -, a
// negation), the tests run, the file comes back. A mutant the tests still
// pass on (a survivor) is behavior no test checks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const bugs = require('./bugs');
const lean = require('./lean');
const { toPosix, commandEnv, newId, EccodeError } = require('./util');

const SWAP = (pairs) => (tok) => pairs[tok];
// Operators match the masked line (strings and comments blanked), so offsets
// equal the raw line's. Binary operators need whitespace on both sides: that
// keeps generics (Array<T>), arrows (=>), shifts and unary minus out.
const OPERATORS = {
  js: [
    { op: 'boundary', re: /(?<=\s)(<=|>=|<|>)(?=\s)/g, to: SWAP({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }) },
    { op: 'equality', re: /(?<=\s)(===|!==|==|!=)(?=\s)/g, to: SWAP({ '===': '!==', '!==': '===', '==': '!=', '!=': '==' }) },
    { op: 'logical', re: /(?<=\s)(&&|\|\|)(?=\s)/g, to: SWAP({ '&&': '||', '||': '&&' }) },
    { op: 'boolean', re: /\b(true|false)\b/g, to: SWAP({ true: 'false', false: 'true' }) },
    { op: 'arithmetic', re: /(?<=\s)(\+|-)(?=\s)/g, to: SWAP({ '+': '-', '-': '+' }) },
    { op: 'negation', re: /(?<![\w$)\]!])!(?!=)/g, to: () => '' },
  ],
  py: [
    { op: 'boundary', re: /(?<=\s)(<=|>=|<|>)(?=\s)/g, to: SWAP({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }) },
    { op: 'equality', re: /(?<=\s)(==|!=)(?=\s)/g, to: SWAP({ '==': '!=', '!=': '==' }) },
    { op: 'logical', re: /(?<=\s)(and|or)(?=\s)/g, to: SWAP({ and: 'or', or: 'and' }) },
    { op: 'boolean', re: /\b(True|False)\b/g, to: SWAP({ True: 'False', False: 'True' }) },
    { op: 'arithmetic', re: /(?<=\s)(\+|-)(?=\s)/g, to: SWAP({ '+': '-', '-': '+' }) },
    { op: 'negation', re: /\bnot\s+(?!in\b)/g, to: () => '' },
    { op: 'identity', re: /(?<=\s)(is not|is)(?=\s)/g, to: SWAP({ is: 'is not', 'is not': 'is' }) },
    // Not the "in" of a for clause (loops and comprehensions).
    { op: 'membership', re: /(?<!\bfor\s[^:]*)(?<=\s)(not in|in)(?=\s)/g, to: SWAP({ in: 'not in', 'not in': 'in' }) },
    { op: 'constant', re: /(?<![\w.])\d+(?![\w.])/g, to: (n) => String(Number(n) + 1) },
    // What a function returns: the whole returned expression becomes None.
    { op: 'return-value', re: /\breturn\s+(\S(?:.*\S)?)\s*$/g, group: 1, to: (e) => (e === 'None' ? null : 'None') },
  ],
};
OPERATORS.go = OPERATORS.js.filter((o) => o.op !== 'equality').concat({ op: 'equality', re: /(?<=\s)(==|!=)(?=\s)/g, to: SWAP({ '==': '!=', '!=': '==' }) });

/** Mutants for one file's text; `only` is the set of 1-based lines to mutate (null: all). */
function mutantsFor(file, text, only) {
  file = toPosix(file);
  const lang = bugs.langOf(file);
  if (!OPERATORS[lang] || !bugs.isCode(file) || lean.TEST.test(file)) return [];
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const masked = bugs.mask(raw.join('\n'), lang).split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (only && !only.has(i + 1)) continue;
    if (/^\s*(import|from|package|require|#include)\b/.test(masked[i])) continue;
    for (const o of OPERATORS[lang]) {
      o.re.lastIndex = 0;
      let m;
      while ((m = o.re.exec(masked[i]))) {
        // A capture group, when the operator has one, is the part replaced.
        const from = o.group ? m[o.group] : m[0];
        const col = o.group ? m.index + m[0].indexOf(from, m[0].length - from.length - (m[0].length - m[0].trimEnd().length)) : m.index;
        if (raw[i].substr(col, from.length) !== from) continue;
        const to = o.to(from);
        if (to === null || to === from) continue;
        out.push({ file, line: i + 1, col, op: o.op, from, to });
      }
    }
  }
  return out;
}

/** Whether `content` still parses as the file's language (null: no checker available). */
function parses(file, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-parse-'));
  try {
    const tmp = path.join(dir, path.basename(file));
    fs.writeFileSync(tmp, content);
    return parsesFile(tmp);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TypeScript and JSX have no syntax check in Node itself: the project's own
// TypeScript compiler (transpileModule reports syntax errors) is used when it
// can be resolved; without it these mutants are skipped, never counted.
const TS_LIKE = new Set(['.ts', '.tsx', '.mts', '.cts', '.jsx']);
function tsChecker(root) {
  // The project's own compiler only (its node_modules chain), never a global one.
  const dir = require('module')._nodeModulePaths(root).map((d) => path.join(d, 'typescript')).find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!dir) return null;
  try {
    const ts = require(dir);
    return (abs) => {
      const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), { fileName: abs, reportDiagnostics: true, compilerOptions: { jsx: 'preserve', allowJs: true } });
      return !(out.diagnostics || []).some((d) => d.category === ts.DiagnosticCategory.Error);
    };
  } catch {
    return null;
  }
}

function parsesFile(abs, root) {
  const ext = path.extname(abs);
  let r;
  if (TS_LIKE.has(ext)) {
    const check = root && tsChecker(root);
    return check ? check(abs) : null;
  }
  if (['.js', '.cjs', '.mjs'].includes(ext)) r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  else if (ext === '.py') r = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', abs], { encoding: 'utf8' });
  else if (ext === '.go') r = spawnSync('gofmt', ['-e', '-l', abs], { encoding: 'utf8' });
  else return null;
  if (r.error) return null; // checker not installed: unknown, counted as valid
  return r.status === 0;
}

function recoveryFile(root) {
  return path.join(root, '.eccode', 'cache', 'mutate-restore.json');
}

/** Put back a file a killed run left mutated; returns its path or null. */
function recover(root) {
  const f = recoveryFile(root);
  if (!fs.existsSync(f)) return null;
  const { file, content } = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(path.join(root, file), Buffer.from(content, 'base64'));
  fs.rmSync(f, { force: true });
  return file;
}

function sh(root, command, timeoutMs) {
  const started = Date.now();
  const r = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: commandEnv({ ECCODE_EVIDENCE: '1' }) });
  return { code: typeof r.status === 'number' ? r.status : 1, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), ms: Date.now() - started, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Up to `max` mutants, spread evenly over the list (deterministic). */
function pick(list, max) {
  if (list.length <= max) return list;
  return Array.from({ length: max }, (_, k) => list[Math.floor((k * list.length) / max)]);
}

/**
 * Run mutation testing on the code lines added since `base`. `test` is the
 * command that must pass on the unmodified code. Every file is restored, in
 * `finally` and through a recovery file a killed run leaves behind.
 */
function run(root, { test, base = 'HEAD', files = null, max = 25, timeoutMs, onProgress = () => {} } = {}) {
  if (!test) throw new EccodeError('USAGE', 'mutate needs --test "<command that passes on the current code>"');
  const recovered = recover(root);
  const added = bugs.addedLines(root, base);
  if (!added) throw new EccodeError('NOT_GIT', 'mutate needs git to find the changed lines');
  const only = files ? new Set(files.map((f) => toPosix(path.normalize(f)))) : null;
  let all = [];
  let lines = 0;
  const touched = new Set();
  for (const [file, set] of added) {
    if (only && !only.has(file)) continue;
    const text = lean.readText(root, file);
    if (text === null) continue;
    const ms = mutantsFor(file, text, set);
    if (ms.length) touched.add(file);
    lines += new Set(ms.map((m) => m.line)).size;
    all = all.concat(ms);
  }
  all.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.col - b.col));
  // A compile error would count as "killed" and inflate the score, so TS/JSX
  // mutants run only where they can be syntax-checked.
  const unchecked = tsChecker(root) ? [] : all.filter((m) => TS_LIKE.has(path.extname(m.file)));
  if (unchecked.length) all = all.filter((m) => !TS_LIKE.has(path.extname(m.file)));
  const chosen = pick(all, max);
  const res = { command: test, base, files: touched.size, lines, available: all.length, total: chosen.length, killed: 0, survived: 0, invalid: 0, timeouts: 0, skippedUnchecked: unchecked.length, score: null, baselineMs: 0, mutants: [], survivors: [], recovered };
  if (!chosen.length) return res;

  const evidence = require('./evidence');
  const store = { dir: path.join(root, '.eccode') };
  // The baseline and every mutant run inside one integrity window: the record
  // is locked meanwhile, so a change to it can only be the tests' own.
  const { tampered } = evidence.recordWindow(store, 'mutate', () => {
    const baseline = sh(root, test, timeoutMs || 600000);
    res.baselineMs = baseline.ms;
    if (baseline.code !== 0) {
      throw new EccodeError('BASELINE_RED', `The test command fails on the unmodified code (exit ${baseline.code}), so no mutant can be judged. Fix the baseline first.\n${baseline.out.split('\n').slice(-15).join('\n')}`);
    }
    const perMutant = timeoutMs || Math.max(10000, baseline.ms * 3 + 5000);
    fs.mkdirSync(path.dirname(recoveryFile(root)), { recursive: true });
    for (const [k, m] of chosen.entries()) {
      const abs = path.join(root, m.file);
      const original = fs.readFileSync(abs);
      const lines2 = original.toString('utf8').split('\n');
      const line = lines2[m.line - 1];
      lines2[m.line - 1] = line.slice(0, m.col) + m.to + line.slice(m.col + m.from.length);
      fs.writeFileSync(recoveryFile(root), JSON.stringify({ file: m.file, content: original.toString('base64') }));
      try {
        fs.writeFileSync(abs, lines2.join('\n'));
        let status;
        if (parsesFile(abs, root) === false) status = 'invalid';
        else {
          const r = sh(root, test, perMutant);
          status = r.timedOut ? 'timeout' : r.code === 0 ? 'survived' : 'killed';
        }
        res.mutants.push({ ...m, status });
        onProgress(`${k + 1}/${chosen.length} ${status} ${m.file}:${m.line} ${m.from || '(none)'} -> ${m.to || '(removed)'}`);
      } finally {
        fs.writeFileSync(abs, original);
        fs.rmSync(recoveryFile(root), { force: true });
      }
      }
  });
  if (tampered.length) res.integrity = `the test command changed the ECCode record (${tampered.join(', ')}); the change was reverted`;
  for (const m of res.mutants) {
    if (m.status === 'killed') res.killed++;
    else if (m.status === 'timeout') { res.killed++; res.timeouts++; }
    else if (m.status === 'survived') res.survived++;
    else res.invalid++;
  }
  res.survivors = res.mutants.filter((m) => m.status === 'survived').map(({ file, line, op, from, to }) => ({ file, line, op, from, to }));
  const judged = res.killed + res.survived;
  res.score = judged ? res.killed / judged : null;
  return res;
}

function format(res) {
  const pct = res.score === null ? 'n/a' : `${Math.round(res.score * 100)}%`;
  const out = [];
  if (res.recovered) out.push(`Recovered ${res.recovered} from an interrupted run before starting.`);
  out.push(`Mutation testing: ${res.total} mutant(s)${res.available > res.total ? ` (of ${res.available}, spread evenly)` : ''} on ${res.lines} changed line(s) in ${res.files} file(s) since ${res.base}; test: ${res.command}${res.baselineMs ? ` (baseline ${(res.baselineMs / 1000).toFixed(1)} s)` : ''}`);
  if (res.skippedUnchecked) out.push(`${res.skippedUnchecked} TypeScript/JSX mutant(s) skipped: no TypeScript compiler resolvable from the project to check their syntax (a compile error would otherwise count as killed).`);
  if (!res.total) return out.concat('No mutable code on the changed lines.').join('\n');
  for (const m of res.mutants) {
    const what = `${m.from.trim() || '(none)'} -> ${m.to.trim() || '(removed)'}`;
    out.push(`${m.status.toUpperCase().padEnd(8)} ${m.file}:${m.line}  ${m.op}: ${what}${m.status === 'survived' ? '   <- no test checks this behavior' : ''}`);
  }
  out.push(`Score: ${res.killed}/${res.killed + res.survived} killed (${pct})${res.invalid ? `; ${res.invalid} invalid (did not parse, not counted)` : ''}${res.timeouts ? `; ${res.timeouts} timed out (counted as killed)` : ''}.`);
  if (res.survived) out.push(`${res.survived} survivor(s): add a test that fails for each, or explain why the behavior cannot be observed.`);
  if (res.integrity) out.push(`INTEGRITY: ${res.integrity}`);
  return out.join('\n');
}

/** Store the result as evidence of kind "mutation" for reviewers to cite. */
function record(store, actor, res, { task, gate } = {}) {
  if (res.integrity) throw new EccodeError('INTEGRITY', `Not recorded: ${res.integrity}`);
  const data = {
    id: newId('ev'),
    kind: 'mutation',
    label: 'mutate',
    command: res.command,
    status: 'recorded',
    mutation: { score: res.score, total: res.total, killed: res.killed, survived: res.survived, invalid: res.invalid, timeouts: res.timeouts, base: res.base, survivors: res.survivors.slice(0, 20) },
    gate: gate || null,
    task: task || null,
  };
  store.commit('evidence.recorded', actor, data);
  return data;
}

module.exports = { mutantsFor, parses, tsChecker, run, format, record, recover, OPERATORS };
