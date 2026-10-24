'use strict';
// Bug detection on the lines a change adds. A few high-precision patterns
// that are almost always wrong (built in, zero dependencies), plus the
// findings of whatever real analyzers are installed (ruff, go vet, eslint,
// semgrep), all limited to the scanned lines so a finding is attributable to
// the change. Task completion runs the built-in rules: an added error must be
// fixed or declared in handoff.acceptedFindings.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { git } = require('./project');
const lean = require('./lean');
const { toPosix, commandEnv, matchesAny } = require('./util');

const LANG_OF = { js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', py: 'py', go: 'go' };

function langOf(file) {
  return LANG_OF[(file.match(/\.([a-z]+)$/i) || [])[1]] || null;
}

function isCode(file) {
  return lean.CODE.test(file) && !lean.GENERATED.test(file) && !lean.SKIP_DIRS.test(file);
}

// ---------------------------------------------------------------- masking
// String contents and comments become spaces; delimiters, newlines and
// offsets stay, so rules see only code and report the right line.

function blankRange(out, a, b) {
  for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
}

const REGEX_PREFIX = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_WORDS = /^(return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new|instanceof)$/;

/** Whether a "/" at i starts a regex literal rather than a division (JS heuristic). */
function regexAllowed(src, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true;
  if (REGEX_PREFIX.has(src[k])) return true;
  if (/[\w$]/.test(src[k])) {
    let s = k;
    while (s >= 0 && /[\w$]/.test(src[s])) s--;
    return REGEX_WORDS.test(src.slice(s + 1, k + 1));
  }
  return false;
}

function maskJs(src) {
  const out = src.split('');
  const n = src.length;
  const templateDepths = []; // brace depth at which each open ${ … } returns to its template
  let depth = 0;
  // Scans template text from j; returns the index of the closing ` or of a "${".
  const templateText = (j) => {
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') break;
      j++;
    }
    return j;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blankRange(out, i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blankRange(out, i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blankRange(out, i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '`' || (c === '}' && templateDepths.length && depth - 1 === templateDepths[templateDepths.length - 1])) {
      if (c === '}') {
        templateDepths.pop();
        depth--;
      }
      const j = templateText(i + 1);
      blankRange(out, i + 1, j);
      if (src[j] === '$') {
        templateDepths.push(depth);
        depth++;
        i = j + 2;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '/' && regexAllowed(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j++;
      }
      if (src[j] === '/') {
        blankRange(out, i + 1, j);
        i = j + 1;
        continue;
      }
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return out.join('');
}

function maskPy(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blankRange(out, i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let p = i - 1;
      while (p >= 0 && /[rRbBuUfF]/.test(src[p]) && i - p <= 2) p--;
      const raw = /[rR]/.test(src.slice(p + 1, i)) && !(p >= 0 && /[\w]/.test(src[p]));
      const triple = src.startsWith(c.repeat(3), i);
      const open = triple ? 3 : 1;
      let j = i + open;
      while (j < n) {
        if (src[j] === '\\' && !raw) { j += 2; continue; }
        if (triple ? src.startsWith(c.repeat(3), j) : src[j] === c) break;
        if (!triple && src[j] === '\n') break;
        j++;
      }
      blankRange(out, i + open, j);
      i = j + (triple ? 3 : 1);
      continue;
    }
    i++;
  }
  return out.join('');
}

function maskGo(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blankRange(out, i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blankRange(out, i, j);
      i = j;
      continue;
    }
    if (c === '`') {
      let j = src.indexOf('`', i + 1);
      if (j < 0) j = n;
      blankRange(out, i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blankRange(out, i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

function mask(src, lang) {
  if (lang === 'js') return maskJs(src);
  if (lang === 'py') return maskPy(src);
  if (lang === 'go') return maskGo(src);
  return src;
}

// ---------------------------------------------------------------- rules
// Each rule must be almost always a bug or a leftover that must not ship.
// error: refused at completion unless declared; warning: recorded.

const TYPEOF_RESULTS = new Set(['undefined', 'object', 'boolean', 'number', 'string', 'function', 'symbol', 'bigint']);

const RULES = [
  { id: 'js/focused-test', lang: 'js', tests: true, severity: 'error', re: /\b(?:describe|it|test|context|suite)\.only\s*\(|(?:^|[^\w$.])(?:fdescribe|fit|fcontext)\s*\(/, message: 'focused test: every other test in the file stops running', hint: 'remove .only / the f prefix' },
  { id: 'js/skipped-test', lang: 'js', tests: true, severity: 'warning', re: /\b(?:describe|it|test|context|suite)\.skip\s*\(|(?:^|[^\w$.])(?:xdescribe|xit|xtest|xcontext)\s*\(/, message: 'skipped test: the behavior it covers is no longer checked', hint: 'fix the test or delete it with a reason; do not skip it to get green' },
  { id: 'js/debugger', lang: 'js', severity: 'error', re: /(?:^|[;{}])\s*debugger\s*(?:;|\}|$)/, message: '`debugger` statement left in code', hint: 'remove it' },
  { id: 'js/nan-compare', lang: 'js', severity: 'error', re: /[!=]==?\s*NaN\b|\bNaN\s*[!=]==?/, message: 'comparison with NaN is always false (or always true with !==)', hint: 'use Number.isNaN(x)' },
  { id: 'js/typeof-typo', lang: 'js', severity: 'error', test: typeofTypo, message: 'typeof compared with a string typeof never returns, so the condition is constant', hint: 'use one of: undefined, object, boolean, number, string, function, symbol, bigint' },
  { id: 'js/async-foreach', lang: 'js', severity: 'error', re: /\.forEach\(\s*async\b/, message: 'forEach does not await async callbacks: errors are lost and work finishes after the caller continues', hint: 'use for…of with await, or await Promise.all(items.map(async …))' },
  // Only the typo shape: the right side is a literal or a plain name. Assigning
  // a call's result (if (m = re.exec(s))) is a common intended idiom.
  { id: 'js/assign-in-condition', lang: 'js', severity: 'error', re: /\bif\s*\(\s*[A-Za-z_$][\w$.]*(?:\[[^\]]*\])*\s*=(?![=>])\s*(?:-?\d[\w.]*|(['"`])\s*\1|true|false|null|undefined|[A-Za-z_$][\w$.]*)\s*(?:\)|&&|\|\|)/, message: 'assignment inside an if condition (= where === was meant?)', hint: 'compare with ===, or wrap an intended assignment in extra parentheses' },
  { id: 'js/async-promise-executor', lang: 'js', severity: 'warning', re: /\bnew\s+Promise\s*\(\s*async\b/, message: 'async Promise executor: a throw inside it never rejects the promise', hint: 'make the outer function async instead' },
  { id: 'js/empty-catch', lang: 'js', severity: 'warning', test: emptyCatch, message: 'empty catch block silently swallows errors', hint: 'handle, log or rethrow; if ignoring is intended, say why in a comment inside the block' },
  { id: 'py/debugger', lang: 'py', severity: 'error', re: /\bbreakpoint\(\s*\)|\b(?:pdb|ipdb|pudb)\.set_trace\(/, message: 'debugger breakpoint left in code', hint: 'remove it' },
  // A warning, not an error: measured on the Python standard library, every
  // hit was an intended cache, sentinel or read-only default. It is a bug only
  // when the function mutates the argument.
  { id: 'py/mutable-default', lang: 'py', severity: 'warning', re: /\bdef\s+\w+\s*\([^)]*?=\s*(?:\[|\{|(?:list|dict|set|bytearray|defaultdict|OrderedDict|deque)\s*\()/, message: 'mutable default argument is shared between calls (a bug if the function mutates it)', hint: 'default to None and create the object inside the function' },
  { id: 'py/is-literal', lang: 'py', severity: 'error', re: /\bis\s+(?:not\s+)?(?:-?\d|[rRbBuUfF]{0,2}['"]|\(\s*\)|\[\s*\]|\{\s*\})/, message: '`is` compares identity, not value: with a literal the result depends on interning', hint: 'use == / !=' },
  { id: 'py/assert-tuple', lang: 'py', severity: 'error', re: /^\s*assert\s*\((?:[^()]|\([^()]*\))*,(?:[^()]|\([^()]*\))*\)\s*$/, message: 'assert on a parenthesized tuple is always true', hint: 'write assert condition, "message" without the parentheses' },
  { id: 'py/bare-except', lang: 'py', severity: 'warning', re: /^\s*except\s*:/, message: 'bare except also catches KeyboardInterrupt and SystemExit', hint: 'catch the specific exception, or Exception' },
  { id: 'py/except-pass', lang: 'py', severity: 'warning', test: exceptPass, message: 'every exception silently swallowed (bare or Exception: pass)', hint: 'catch the specific exception, handle or log it; if ignoring is intended, say why in a comment' },
  { id: 'py/skipped-test', lang: 'py', tests: true, severity: 'warning', re: /@(?:pytest\.mark\.skip|unittest\.skip)\b(?!if|If|Unless)/, message: 'skipped test: the behavior it covers is no longer checked', hint: 'fix the test or delete it with a reason' },
  { id: 'go/skipped-test', lang: 'go', tests: true, severity: 'warning', test: goSkip, message: 'unconditional skip: the behavior this test covers is no longer checked', hint: 'fix the test or delete it with a reason; skip only under a condition (platform, -short)' },
  { id: 'all/merge-marker', lang: '*', severity: 'error', test: mergeMarker, message: 'merge conflict marker left in the file', hint: 'resolve the conflict' },
];

function typeofTypo(masked, raw) {
  const re = /typeof\s+[\w$.]+(?:\[[^\]]*\])?\s*[!=]==?\s*(['"`])([^'"`]*)\1|(['"`])([^'"`]*)\3\s*[!=]==?\s*typeof\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const at = m.index + m[0].indexOf('typeof', m[1] ? 0 : m[0].length - 6);
    if (masked.slice(at, at + 6) !== 'typeof') continue; // the match is inside a string or comment
    if (!TYPEOF_RESULTS.has(m[2] !== undefined ? m[2] : m[4])) return true;
  }
  return false;
}

/** A comment in the raw line that masking blanked (the author explained the code). */
function commented(masked, raw, lang) {
  if (lang === 'py') return raw.includes('#') && !masked.includes('#');
  return /\/\/|\/\*/.test(raw) && !/\/\/|\/\*/.test(masked);
}

// Only broad catches (bare, Exception, BaseException): swallowing a specific
// exception such as KeyError is ordinary control flow.
function exceptPass(masked, raw, lines, i, rawLines) {
  if (!/^\s*except\s*(?::|\(?\s*(?:Exception|BaseException)\b)/.test(masked) || commented(masked, raw, 'py')) return false;
  if (/:\s*pass\s*$/.test(masked)) return true;
  if (!/:\s*$/.test(masked)) return false;
  for (let k = i + 1; k < lines.length; k++) {
    if (!lines[k].trim()) continue;
    if (!/^\s*pass\s*$/.test(lines[k]) || commented(lines[k], rawLines[k], 'py')) return false;
    return k; // the body line the finding also spans
  }
  return false;
}

function emptyCatch(masked, raw) {
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{(\s*)\}/g;
  let m;
  while ((m = re.exec(masked))) {
    const open = m.index + m[0].lastIndexOf('{');
    if (!raw.slice(open + 1, open + 1 + m[1].length).trim()) return true; // no explaining comment inside
  }
  return false;
}

// Unconditional skips only: a skip inside an if/switch (platform, -short) is legitimate.
function goSkip(masked, raw, lines, i) {
  if (!/\b[tb]\.Skip(?:Now|f)?\s*\(/.test(masked)) return false;
  if (/\b(?:if|case|switch)\b/.test(masked.slice(0, masked.search(/\b[tb]\.Skip/)))) return false;
  for (let k = i - 1; k >= 0; k--) {
    if (!lines[k].trim()) continue;
    return !/^\s*(?:\}\s*else\b.*|if\b.*|else\b.*|switch\b.*|case\b.*|default\s*):?\s*\{?\s*$/.test(lines[k]);
  }
  return true;
}

function mergeMarker(masked, raw) {
  const m = /^(?:<{7}(?: |$)|={7}$|>{7}(?: |$))/.exec(raw);
  return Boolean(m) && masked.startsWith(raw.slice(0, 7));
}

// A comment that tells linters a line is intended: honored by every rule.
const SUPPRESS = /\b(?:noqa|eslint-disable(?:-next)?-line|nolint|eccode-allow)\b/;

/**
 * Minified or bundled output is generated, not written: more than 10% of its
 * characters sit in lines over 1000 characters. Found by the held-out run
 * (bundles in Playwright and Prettier), where it was every error-rule hit.
 */
function minified(lines) {
  let total = 0;
  let long = 0;
  for (const l of lines) {
    total += l.length + 1;
    if (l.length > 1000) long += l.length;
  }
  return total > 0 && long / total > 0.1;
}

/**
 * Findings of the built-in rules in one file's text. `only` limits them to a
 * set of 1-based line numbers (the lines a change added); null means all.
 */
function checkText(file, text, only = null) {
  file = toPosix(file);
  if (!isCode(file)) return [];
  const lang = langOf(file);
  const isTest = lean.TEST.test(file);
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  if (minified(rawLines)) return [];
  const masked = mask(rawLines.join('\n'), lang).split('\n');
  const rules = RULES.filter((r) => (r.lang === '*' || r.lang === lang) && (!r.tests || isTest));
  const findings = [];
  for (let i = 0; i < rawLines.length; i++) {
    for (const r of rules) {
      const hit = r.re ? r.re.test(masked[i]) : r.test(masked[i], rawLines[i], masked, i, rawLines);
      if (!hit) continue;
      const spans = typeof hit === 'number' ? [i + 1, hit + 1] : [i + 1];
      if (only && !spans.some((l) => only.has(l))) continue;
      if (SUPPRESS.test(rawLines[i]) || (i > 0 && /eslint-disable-next-line|eccode-allow-next-line/.test(rawLines[i - 1]))) continue;
      findings.push({ tool: 'eccode', rule: r.id, severity: r.severity, file, line: i + 1, message: r.message, hint: r.hint, text: rawLines[i].trim().slice(0, 160) });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- scope

/**
 * Lines added since `base`, per project-relative file: a Set of 1-based
 * line numbers, or null for a new untracked file (every line is new).
 * Returns null outside git.
 */
function addedLines(root, base = 'HEAD') {
  const diff = git(root, ['-c', 'core.quotepath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--relative', base]);
  if (diff === null) return null;
  const map = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t.*$/, '');
      file = p === '/dev/null' ? null : toPosix(p.replace(/^"?b\//, '').replace(/"$/, ''));
      if (file && !map.has(file)) map.set(file, new Set());
      continue;
    }
    const h = file && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      for (let k = 0; k < count; k++) map.get(file).add(start + k);
    }
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  for (const f of (untracked || '').split('\n').filter(Boolean)) map.set(toPosix(f), null);
  for (const [f, set] of map) if (set && !set.size) map.delete(f); // deletions only
  return map;
}

// ---------------------------------------------------------------- analyzers

function hasTool(cmd) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).status === 0;
}

function run(root, cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024, env: commandEnv() });
}

function rel(root, file) {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  return toPosix(path.relative(fs.realpathSync(root), fs.existsSync(abs) ? fs.realpathSync(abs) : abs));
}

// Ruff codes that are bugs rather than style: undefined or shadowed names,
// `is` with literals, duplicate keys, statements outside their construct, syntax.
const RUFF_ERRORS = new Set(['F821', 'F822', 'F823', 'F811', 'F632', 'F601', 'F602', 'F631', 'F701', 'F702', 'F704', 'F706', 'F707', 'E999']);
// The rule families ruff runs for a bug scan, whatever the project's own lint
// config selects: pyflakes, syntax errors, bugbear, async misuse, pylint
// errors, dangling asyncio tasks. Style (import order, simplifications) is
// the project linter's job (eccode stack), not a bug report's.
const RUFF_BUG_RULES = 'F,E9,B,ASYNC,PLE,RUF006';
// FastAPI's parameter functions are meant to be called in defaults (B008).
const FASTAPI_PARAMS = /\x60(Depends|Query|Path|Body|Header|Cookie|File|Form|Security|UploadFile)\x60/;

const ANALYZERS = [
  {
    tool: 'ruff',
    applies: (root, files) => files.some((f) => f.endsWith('.py')) && hasTool('ruff'),
    run(root, files) {
      const r = run(root, 'ruff', ['check', '--output-format', 'json', '--exit-zero', '--no-cache', '--select', RUFF_BUG_RULES, ...files.filter((f) => f.endsWith('.py'))]);
      if (r.status !== 0) throw new Error((r.stderr || r.error || 'ruff failed').toString().slice(0, 300));
      return JSON.parse(r.stdout || '[]').filter((x) => !(x.code === 'B008' && FASTAPI_PARAMS.test(x.message || ''))).map((x) => {
        const code = x.code || 'E999';
        return { rule: code, severity: RUFF_ERRORS.has(code) ? 'error' : 'warning', file: rel(root, x.filename), line: x.location && x.location.row, message: x.message };
      });
    },
  },
  {
    tool: 'go vet',
    applies: (root, files) => files.some((f) => f.endsWith('.go')) && fs.existsSync(path.join(root, 'go.mod')) && hasTool('go'),
    run(root) {
      const r = run(root, 'go', ['vet', './...']);
      const out = [];
      for (const line of `${r.stdout || ''}\n${r.stderr || ''}`.split('\n')) {
        const m = /^(?:vet: )?(\.{0,2}\/?[^:\s][^:]*\.go):(\d+):(?:\d+:)? (.+)$/.exec(line.trim());
        if (m) out.push({ rule: 'vet', severity: 'error', file: rel(root, m[1]), line: Number(m[2]), message: m[3] });
      }
      if (r.status !== 0 && !out.length) throw new Error(`${r.stderr || r.error || 'go vet failed'}`.slice(0, 300));
      return out;
    },
  },
  {
    tool: 'eslint',
    applies: (root, files) => files.some((f) => langOf(f) === 'js')
      && fs.readdirSync(root).some((f) => /^(eslint\.config\.(js|mjs|cjs|ts)|\.eslintrc(\.(js|cjs|json|ya?ml))?)$/.test(f))
      && (fs.existsSync(path.join(root, 'node_modules', '.bin', 'eslint')) || hasTool('eslint')),
    run(root, files) {
      const local = path.join(root, 'node_modules', '.bin', 'eslint');
      const r = run(root, fs.existsSync(local) ? local : 'eslint', ['--format', 'json', '--no-error-on-unmatched-pattern', ...files.filter((f) => langOf(f) === 'js')]);
      if (!r.stdout) throw new Error(`${r.stderr || r.error || 'eslint failed'}`.slice(0, 300));
      return JSON.parse(r.stdout).flatMap((f) => f.messages.map((m) => ({ rule: m.ruleId || 'parse', severity: m.severity === 2 ? 'error' : 'warning', file: rel(root, f.filePath), line: m.line, message: m.message })));
    },
  },
  {
    tool: 'semgrep',
    applies: (root) => fs.existsSync(path.join(root, '.semgrep.yml')) && hasTool('semgrep'),
    run(root, files) {
      const r = run(root, 'semgrep', ['--config', '.semgrep.yml', '--json', '--quiet', '--metrics=off', ...files]);
      if (!r.stdout) throw new Error(`${r.stderr || r.error || 'semgrep failed'}`.slice(0, 300));
      return JSON.parse(r.stdout).results.map((x) => ({ rule: x.check_id, severity: x.extra && x.extra.severity === 'ERROR' ? 'error' : 'warning', file: rel(root, x.path), line: x.start && x.start.line, message: x.extra && x.extra.message }));
    },
  },
];

// Analyzer rules that report the same thing as a built-in rule: on the same
// line, only the built-in finding is shown (its hint is ECCode's own).
const EQUIVALENT = {
  'py/is-literal': ['F632'], 'py/mutable-default': ['B006'], 'py/bare-except': ['E722'], 'py/debugger': ['T100'],
  'js/debugger': ['no-debugger'], 'js/nan-compare': ['use-isnan'], 'js/typeof-typo': ['valid-typeof'],
  'js/async-promise-executor': ['no-async-promise-executor'], 'js/empty-catch': ['no-empty'], 'js/assign-in-condition': ['no-cond-assign'],
};

function runAnalyzers(root, targets) {
  const files = [...targets.keys()];
  const findings = [];
  const analyzers = [];
  for (const a of ANALYZERS) {
    let applies = false;
    try {
      applies = a.applies(root, files);
    } catch { /* treat as not applicable */ }
    if (!applies) continue;
    try {
      const found = a.run(root, files).filter((f) => targets.has(f.file) && (targets.get(f.file) === null || targets.get(f.file).has(f.line)));
      findings.push(...found.map((f) => ({ tool: a.tool, ...f, hint: null, text: null })));
      analyzers.push({ tool: a.tool, ran: true, findings: found.length });
    } catch (err) {
      analyzers.push({ tool: a.tool, ran: false, error: String(err.message || err).trim() });
    }
  }
  return { findings, analyzers };
}

// ---------------------------------------------------------------- scan

/**
 * Scan the lines added since `base` (default HEAD: working tree and untracked
 * files), or whole files with `all`. `files` narrows the scan; `external`
 * (default true) adds the installed analyzers' findings on the same lines.
 */
function scan(root, { base = 'HEAD', all = false, files = null, external = true } = {}) {
  let targets;
  if (all) {
    targets = new Map(lean.listFiles(root).map((f) => [toPosix(f), null]));
  } else {
    targets = addedLines(root, base);
    if (!targets) throw new Error('bugs needs git to find the changed lines; use --all to scan whole files');
  }
  const only = files ? new Set(files.map((f) => toPosix(path.normalize(f)))) : null;
  for (const f of [...targets.keys()]) {
    if (!isCode(f) || (only && !only.has(f)) || !fs.existsSync(path.join(root, f))) targets.delete(f);
  }
  const findings = [];
  let lines = 0;
  for (const [f, set] of targets) {
    const text = lean.readText(root, f);
    if (text === null) continue;
    lines += set ? set.size : text.split('\n').length;
    findings.push(...checkText(f, text, set));
  }
  const ext = external && targets.size ? runAnalyzers(root, targets) : { findings: [], analyzers: [] };
  const same = new Set(findings.flatMap((f) => (EQUIVALENT[f.rule] || []).map((r) => `${f.file}:${f.line}:${r}`)));
  findings.push(...ext.findings.filter((f) => !same.has(`${f.file}:${f.line}:${f.rule}`)));
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : 1)));
  return { base: all ? null : base, files: targets.size, lines, findings, analyzers: ext.analyzers };
}

function format(res) {
  const errors = res.findings.filter((f) => f.severity === 'error').length;
  const warnings = res.findings.length - errors;
  const ran = res.analyzers.map((a) => (a.ran ? `${a.tool} (${a.findings} on these lines)` : `${a.tool} (failed: ${a.error.split('\n')[0]})`));
  const out = [`Bug scan: ${res.files} file(s), ${res.lines} ${res.base ? `line(s) added since ${res.base}` : 'line(s), whole files'}; analyzers: ${ran.length ? ran.join(', ') : 'built-in rules only'}`];
  if (!res.findings.length) return out.concat('No bug patterns on the scanned lines.').join('\n');
  for (const f of res.findings) {
    out.push(`${f.severity.toUpperCase()} ${f.file}:${f.line} ${f.tool === 'eccode' ? f.rule : `${f.tool}:${f.rule}`} - ${f.message}${f.hint ? ` (fix: ${f.hint})` : ''}`);
    if (f.text) out.push(`  > ${f.text}`);
  }
  out.push(`${errors} error(s), ${warnings} warning(s). At task completion, built-in errors are refused unless declared in handoff.acceptedFindings.`);
  return out.join('\n');
}

/**
 * The completion gate: built-in rules on the lines the task added. Errors
 * (and, at lean level strict, warnings) must be fixed or declared in
 * handoff.acceptedFindings [{rule, file, reason}]; at lite they are recorded.
 */
function checkCompletion(root, config, task, handoff, gitChanged) {
  const level = lean.levelOf(config);
  if (level === 'off') return { errors: [], stats: null };
  const base = task.claim && task.claim.baseCommit;
  const listed = (Array.isArray(handoff.filesChanged) ? handoff.filesChanged : []).filter((f) => typeof f === 'string').map((f) => toPosix(path.normalize(f)));
  const touched = new Set([...listed, ...(gitChanged || []).filter((f) => matchesAny(f, task.files || []))]);
  const added = base ? addedLines(root, base) : null;
  const findings = [];
  for (const f of touched) {
    if (f.startsWith('.eccode/') || !isCode(f) || (added && !added.has(f))) continue;
    const text = lean.readText(root, f);
    if (text !== null) findings.push(...checkText(f, text, added ? added.get(f) : null));
  }
  const declared = new Set((Array.isArray(handoff.acceptedFindings) ? handoff.acceptedFindings : [])
    .filter((a) => a && typeof a.rule === 'string' && typeof a.file === 'string')
    .map((a) => `${a.rule} ${toPosix(path.normalize(a.file))}`));
  const accepted = new Set();
  const blocking = [];
  for (const f of findings) {
    const key = `${f.rule} ${f.file}`;
    if (declared.has(key)) accepted.add(key);
    else if (f.severity === 'error' || level === 'strict') blocking.push(f);
  }
  const stats = {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    findings: findings.slice(0, 20).map((f) => `${f.severity} ${f.file}:${f.line} ${f.rule}`),
    accepted: [...accepted],
    ...(added ? {} : { note: 'no claim base: whole changed files were scanned' }),
  };
  if (level === 'lite') return { errors: [], stats };
  return {
    errors: blocking.map((f) => `bugs: ${f.file}:${f.line} ${f.rule} - ${f.message}. Fix it (${f.hint}), or if it is intended declare it in handoff.acceptedFindings: {"rule": "${f.rule}", "file": "${f.file}", "reason": "<why>"}`),
    stats,
  };
}

module.exports = { mask, checkText, addedLines, scan, format, checkCompletion, hasTool, RULES, isCode, langOf };
