'use strict';
// Observed team standards (Phase 3, part E). What the project already does,
// read from its git history and its source and config files: commit-subject
// conventions, naming, test layout, error handling, and the rules its own
// linters state. Every result is labelled `observed` and none is enforced:
// the list is shown at onboarding and stored as a project-layer memory
// record (which is never promoted or reviewed), nothing more. Counts, not
// semantics: regex heuristics over text, deterministic, no network. PR review
// comments would need a hosting API and are not read.

const path = require('path');
const { git } = require('./project');
const lean = require('./lean');
const { mask } = require('./bugs');
const { readJson, exists, EccodeError } = require('./util');
const { loadSchema } = require('./schema');
const { Memory } = require('./memory/records');

const KINDS = ['commit-message', 'naming', 'test-layout', 'error-handling', 'forbidden-pattern'];
const GIT_HISTORY = 'git-history';
const SOURCE_FILES = 'source-files';
const MAX_FILES = 3000;
const MIN_EVIDENCE = 3;

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?:\s/i;
const TOPIC_PREFIX = /^[A-Za-z][^:\n]{1,40}:\s\S/;
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b|(?:^|[\s([])#\d+\b/;
const NOT_A_VERB = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'its', 'our', 'my', 'all', 'no', 'new', 'more', 'some', 'initial', 'misc', 'wip', 'phase', 'part', 'step', 'v', 'version', 'release', 'and', 'or', 'also', 'first', 'second', 'final', 'minor', 'major', 'small', 'quick']);
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e)\//;
const LANG_OF = { js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', py: 'py' };

// ---------------------------------------------------------------- helpers

function share(n, d) {
  return d ? Math.round((n / d) * 1000) / 1000 : 0;
}

function percent(x) {
  return `${Math.round(x * 100)}%`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function count(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function tally(items) {
  const counts = new Map();
  for (const it of items) if (it !== null && it !== undefined) counts.set(it, (counts.get(it) || 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  return { sorted, total: items.filter((x) => x !== null && x !== undefined).length };
}

function examplesOf(list, n = 3) {
  return [...new Set(list.map(String))].slice(0, n);
}

function rule(kind, text, confidence, examples, source) {
  return { kind, rule: text, confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000, examples: examplesOf(examples || []), source };
}

function langOf(file) {
  return LANG_OF[(file.match(/\.([a-z]+)$/i) || [])[1]] || null;
}

/** Identifier style; null when a single word gives no evidence either way. */
function styleOf(name) {
  const n = String(name).replace(/^_+|_+$/g, '');
  if (!n) return null;
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(n)) return 'UPPER_SNAKE';
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(n)) return 'snake_case';
  if (/^[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+$/.test(n)) return 'camelCase';
  if (/^[A-Z][A-Za-z0-9]*$/.test(n) && /[a-z]/.test(n)) return 'PascalCase';
  return null;
}

function fileStyle(base) {
  const b = base.replace(/\.(test|spec)$/, '').replace(/^test_/, '').replace(/_test$/, '');
  if (!b || /^(index|main|app|__init__|conftest|setup|cli)$/.test(b)) return null;
  if (b.includes('-')) return 'kebab-case';
  if (b.includes('_')) return 'snake_case';
  if (/^[a-z][a-z0-9]*[A-Z]/.test(b)) return 'camelCase';
  if (/^[A-Z][a-z0-9]+[A-Z]/.test(b)) return 'PascalCase';
  return null;
}

/** `key = [ … ]` or `key = value` inside one TOML/INI section's text. */
function tomlList(section, key) {
  const m = section.match(new RegExp(`^\\s*${key.replace(/[-.]/g, '\\$&')}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function tomlValue(section, key) {
  const m = section.match(new RegExp(`^\\s*${key.replace(/[-.]/g, '\\$&')}\\s*=\\s*([^\\n#]+)`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** The text of `[name]` (TOML or INI) up to the next section header. */
function section(text, name) {
  const re = new RegExp(`^\\[${name.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&')}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- commit messages

function commitRules(root, limit, scanned) {
  const out = git(root, ['log', '-n', String(limit), '--format=%s']);
  if (out === null) return [];
  const subjects = out.split('\n').map((s) => s.trim()).filter(Boolean);
  scanned.commits = subjects.length;
  const n = subjects.length;
  if (n < MIN_EVIDENCE) return [];
  const rules = [];

  const conv = subjects.filter((s) => CONVENTIONAL.test(s));
  const topic = subjects.filter((s) => !CONVENTIONAL.test(s) && TOPIC_PREFIX.test(s));
  const plain = subjects.filter((s) => !CONVENTIONAL.test(s) && !TOPIC_PREFIX.test(s));
  if (conv.length / n >= 0.5) {
    const types = tally(conv.map((s) => s.match(CONVENTIONAL)[1].toLowerCase()));
    const scoped = conv.filter((s) => /^\w+\(/.test(s)).length;
    const typeList = types.sorted.map(([t, c]) => `${t} (${c})`).join(', ');
    rules.push(rule('commit-message', `Commit subjects follow the conventional-commits form "type: summary" in ${percent(conv.length / n)} of the last ${n} commits; types seen: ${typeList}${scoped ? `; ${percent(scoped / conv.length)} of them carry a (scope)` : ''}.`, conv.length / n, conv.slice(0, 3), GIT_HISTORY));
  } else if (topic.length / n >= 0.5) {
    rules.push(rule('commit-message', `Commit subjects start with a topic prefix, "Topic: summary", in ${percent(topic.length / n)} of the last ${n} commits (no conventional-commit types).`, topic.length / n, topic.slice(0, 3), GIT_HISTORY));
  } else {
    rules.push(rule('commit-message', `Commit subjects are plain summaries without a type or topic prefix in ${percent(plain.length / n)} of the last ${n} commits.`, plain.length / n, plain.slice(0, 3), GIT_HISTORY));
  }

  const lengths = subjects.map((s) => s.length).sort((a, b) => a - b);
  const p90 = lengths[Math.max(0, Math.ceil(lengths.length * 0.9) - 1)];
  const within = lengths.filter((l) => l <= p90).length;
  rules.push(rule('commit-message', `Commit subjects stay within ${p90} characters (90th percentile of the last ${n}; the longest is ${lengths[lengths.length - 1]}).`, within / n, subjects.filter((s) => s.length === p90).slice(0, 1), GIT_HISTORY));

  const summaries = subjects.map((s) => s.replace(CONVENTIONAL, '').replace(/^[A-Za-z][^:\n]{1,40}:\s+/, ''));
  const firstWords = summaries.map((s) => (s.match(/^([A-Za-z]+)/) || [])[1]).filter(Boolean);
  if (firstWords.length >= MIN_EVIDENCE) {
    // A verb-shaped first word: not a determiner or label, not -ed/-ing, not third person.
    const imperative = firstWords.filter((w) => !NOT_A_VERB.has(w.toLowerCase()) && !/(ed|ing)$/i.test(w) && !/[^s]s$/i.test(w));
    const imp = imperative.length / firstWords.length;
    if (imp >= 0.6) {
      const common = tally(imperative.map((w) => w.toLowerCase())).sorted.map(([w]) => w);
      rules.push(rule('commit-message', `Commit summaries read as imperative mood ("${common.slice(0, 2).join('", "')}", not "added"/"adding") in ${percent(imp)} of the last ${n} commits (first-word heuristic).`, imp, common, GIT_HISTORY));
    }
    const capital = summaries.filter((s) => /^[A-Z]/.test(s)).length / n;
    if (capital >= 0.6) rules.push(rule('commit-message', `Commit summaries (after any type or topic prefix) start with a capital letter in ${percent(capital)} of the last ${n} commits.`, capital, summaries.filter((s) => /^[A-Z]/.test(s)).slice(0, 2), GIT_HISTORY));
    else if (capital <= 0.4) rules.push(rule('commit-message', `Commit summaries (after any type or topic prefix) start in lower case in ${percent(1 - capital)} of the last ${n} commits.`, 1 - capital, summaries.filter((s) => /^[a-z]/.test(s)).slice(0, 2), GIT_HISTORY));
  }

  const tickets = subjects.map((s) => (s.match(TICKET) || [])[0]).filter(Boolean).map((t) => t.trim());
  if (tickets.length / n >= 0.3) {
    rules.push(rule('commit-message', `Commit subjects reference a ticket id (${tickets[0]}) in ${percent(tickets.length / n)} of the last ${n} commits.`, tickets.length / n, tickets, GIT_HISTORY));
  }
  return rules;
}

// ---------------------------------------------------------------- source scan

/** One pass over the readable Python and JS/TS files: everything the naming and error-handling rules count. */
function scanSources(root, files, scanned) {
  const acc = {
    py: { funcs: [], classes: [], testFuncs: [], files: [], exceptions: [], excepts: 0, broad: 0, swallowed: 0, raises: 0, logs: 0, httpRaises: 0, httpFiles: 0, httpFileRaises: 0, fastapi: false },
    js: { funcs: [], classes: [], testCalls: [], files: [], exceptions: [], throws: [], throwTotal: 0, catches: 0, emptyCatches: 0, logs: 0, results: 0 },
  };
  let read = 0;
  for (const f of files) {
    const lang = langOf(f);
    if (!lang || lean.GENERATED.test(f) || /^\.claude\//.test(f)) continue;
    if (read >= MAX_FILES) {
      scanned.unscanned += 1;
      continue;
    }
    const raw = lean.readText(root, f);
    if (raw === null) continue;
    read += 1;
    const a = acc[lang];
    a.files.push(f);
    const text = mask(raw, lang);
    const isTest = lean.TEST.test(f);
    if (lang === 'py') {
      for (const m of text.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm)) {
        if (/^__\w+__$/.test(m[1])) continue;
        (isTest ? a.testFuncs : a.funcs).push(m[1]);
      }
      for (const m of text.matchAll(/^\s*class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/gm)) {
        a.classes.push(m[1]);
        if (/(Error|Exception)$/.test(m[1])) a.exceptions.push({ name: m[1], base: (m[2] || 'object').split(',')[0].trim().split('.').pop() || 'object', file: f });
      }
      for (const m of text.matchAll(/^\s*except\b([^:\n]*):[ \t]*(pass[ \t]*)?$/gm)) {
        a.excepts += 1;
        const what = m[1].trim();
        if (!what || /^\(?\s*(?:Exception|BaseException)\b/.test(what)) a.broad += 1;
        if (m[2]) a.swallowed += 1;
      }
      a.swallowed += count(text, /^\s*except\b[^:\n]*:\s*\n\s*pass\s*$/gm);
      const raises = count(text, /^\s*raise\b/gm);
      a.raises += raises;
      a.logs += count(text, /\b(?:logger|logging|log|LOGGER|_logger|_log)\.(?:error|exception|critical|warning|warn)\(/g);
      const http = count(text, /\braise\s+HTTPException\s*\(/g);
      if (http) {
        a.httpRaises += http;
        a.httpFiles += 1;
        a.httpFileRaises += raises;
      }
      if (/^\s*(?:from\s+fastapi\b|import\s+fastapi\b)/m.test(text)) a.fastapi = true;
    } else {
      for (const m of text.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) a.funcs.push(m[1]);
      for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) a.funcs.push(m[1]);
      for (const m of text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([\w$.]+))?/g)) {
        a.classes.push(m[1]);
        if (/(Error|Exception)$/.test(m[1])) a.exceptions.push({ name: m[1], base: (m[2] || 'none').split('.').pop(), file: f });
      }
      if (isTest) for (const m of text.matchAll(/(?:^|[^\w$.])(test|it|describe)\s*\(/g)) a.testCalls.push(m[1]);
      a.throwTotal += count(text, /\bthrow\b/g);
      for (const m of text.matchAll(/\bthrow\s+new\s+([A-Za-z_$][\w$.]*)\s*\(/g)) a.throws.push(m[1].split('.').pop());
      a.catches += count(text, /\bcatch\b/g);
      a.emptyCatches += count(text, /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g);
      a.logs += count(text, /\b(?:console|logger|log)\.(?:error|warn)\(/g);
      a.results += count(text, /\breturn\s*\{\s*(?:ok|success|errors?)\s*:/g);
    }
  }
  scanned.files = read;
  scanned.py = acc.py.files.length;
  scanned.js = acc.js.files.length;
  return acc;
}

// ---------------------------------------------------------------- naming

function namingRules(acc) {
  const rules = [];
  const labels = { py: 'Python', js: 'JS/TS' };
  for (const lang of ['py', 'js']) {
    const a = acc[lang];
    const L = labels[lang];
    const funcs = tally(a.funcs.map(styleOf).filter((s) => s === 'snake_case' || s === 'camelCase'));
    if (funcs.total >= MIN_EVIDENCE) {
      const [style, c] = funcs.sorted[0];
      rules.push(rule('naming', `${L} function names are ${style} (${percent(c / funcs.total)} of ${funcs.total} multi-word names${funcs.sorted[1] ? `; ${funcs.sorted[1][1]} are ${funcs.sorted[1][0]}` : ''}).`, c / funcs.total, a.funcs.filter((n) => styleOf(n) === style), SOURCE_FILES));
    }
    const classes = tally(a.classes.map((n) => (/^[A-Z][A-Za-z0-9]*$/.test(n) ? 'PascalCase' : n.includes('_') ? 'snake_case' : 'other')));
    if (classes.total >= MIN_EVIDENCE) {
      const [style, c] = classes.sorted[0];
      rules.push(rule('naming', `${L} class names are ${style} (${percent(c / classes.total)} of ${classes.total} classes).`, c / classes.total, a.classes.filter((n) => (/^[A-Z][A-Za-z0-9]*$/.test(n) ? 'PascalCase' : n.includes('_') ? 'snake_case' : 'other') === style), SOURCE_FILES));
    }
    const bases = a.files.map((f) => fileStyle(path.posix.basename(f).replace(/\.[a-z]+$/i, '')));
    const fileStyles = tally(bases);
    if (fileStyles.total >= MIN_EVIDENCE) {
      const [style, c] = fileStyles.sorted[0];
      rules.push(rule('naming', `${L} file names are ${style} (${percent(c / fileStyles.total)} of ${fileStyles.total} multi-word file names).`, c / fileStyles.total, a.files.filter((f, i) => bases[i] === style).map((f) => path.posix.basename(f)), SOURCE_FILES));
    }
  }
  const py = acc.py;
  if (py.testFuncs.length >= MIN_EVIDENCE) {
    const prefixed = py.testFuncs.filter((n) => /^test_/.test(n));
    const helpers = py.testFuncs.length - prefixed.length;
    rules.push(rule('naming', `Python test functions are named test_<behaviour> (${percent(prefixed.length / py.testFuncs.length)} of ${py.testFuncs.length} functions in test files${helpers === 1 ? '; the other one is a helper or fixture' : helpers ? `; the other ${helpers} are helpers or fixtures` : ''}).`, prefixed.length / py.testFuncs.length, prefixed, SOURCE_FILES));
  }
  const calls = tally(acc.js.testCalls.filter((c) => c !== 'describe'));
  if (calls.total >= MIN_EVIDENCE) {
    const [name, c] = calls.sorted[0];
    const describes = acc.js.testCalls.filter((x) => x === 'describe').length;
    rules.push(rule('naming', `JS/TS tests are written as ${name}('…') blocks (${percent(c / calls.total)} of ${calls.total} test calls${describes ? `, ${describes} describe() groups` : ', no describe() groups'}).`, c / calls.total, [`${name}(`], SOURCE_FILES));
  }
  return rules;
}

// ---------------------------------------------------------------- test layout

function testLayoutRules(root, files, scanned) {
  const rules = [];
  // Package markers and pytest's conftest.py are support files, not tests.
  const tests = files.filter((f) => lean.TEST.test(f) && lean.CODE.test(f) && !lean.GENERATED.test(f) && !/^\.claude\//.test(f) && !/(^|\/)(__init__|conftest)\.py$/.test(f));
  scanned.tests = tests.length;
  if (tests.length) {
    const where = tests.map((f) => {
      const m = TEST_DIR.exec(f);
      if (!m) return 'next to the source files they test';
      return m.index === 0 ? `${m[2]}/ at the project root` : `${m[2]}/ directories beside the source`;
    });
    const w = tally(where);
    const [place, c] = w.sorted[0];
    rules.push(rule('test-layout', `Tests live in ${place} (${percent(c / w.total)} of ${plural(w.total, 'test file')}${w.sorted[1] ? `; ${w.sorted[1][1]} in ${w.sorted[1][0]}` : ''}).`, c / w.total, tests.filter((f, i) => where[i] === place), SOURCE_FILES));
    const pattern = (f) => {
      const b = path.posix.basename(f);
      if (/^test_.*\.py$/.test(b)) return 'test_<module>.py';
      if (/_test\.py$/.test(b)) return '<module>_test.py';
      if (/_test\.go$/.test(b)) return '<name>_test.go';
      const m = b.match(/\.(test|spec)\.([a-z]+)$/);
      if (m) return `<name>.${m[1]}.${m[2]}`;
      if (/Tests?\.(java|kt|cs|swift)$/.test(b)) return `<Name>Test.${b.split('.').pop()}`;
      return null;
    };
    const names = tests.map(pattern);
    const p = tally(names);
    if (p.total) {
      const [pat, c] = p.sorted[0];
      rules.push(rule('test-layout', `Test files are named ${pat} (${percent(c / p.total)} of ${p.total} recognisable test file names).`, c / p.total, tests.filter((f, i) => names[i] === pat).map((f) => path.posix.basename(f)), SOURCE_FILES));
    }
  }

  // Runners, from configuration (confidence 1: the project states them).
  const pyproject = exists(path.join(root, 'pyproject.toml')) ? lean.readText(root, 'pyproject.toml') || '' : '';
  if (section(pyproject, 'tool.pytest.ini_options') !== null) {
    const s = section(pyproject, 'tool.pytest.ini_options');
    const testpaths = tomlList(s, 'testpaths');
    rules.push(rule('test-layout', `The Python test runner is pytest, configured in pyproject.toml [tool.pytest.ini_options]${testpaths ? ` with testpaths ${testpaths.join(', ')}` : ''}.`, 1, testpaths || [], 'pyproject.toml'));
  } else if (exists(path.join(root, 'pytest.ini'))) {
    rules.push(rule('test-layout', 'The Python test runner is pytest, configured in pytest.ini.', 1, [], 'pytest.ini'));
  } else {
    for (const [file, name] of [['setup.cfg', 'tool:pytest'], ['tox.ini', 'pytest']]) {
      if (exists(path.join(root, file)) && section(lean.readText(root, file) || '', name) !== null) {
        rules.push(rule('test-layout', `The Python test runner is pytest, configured in ${file} [${name}].`, 1, [], file));
        break;
      }
    }
  }
  const pkg = exists(path.join(root, 'package.json')) ? readJson(path.join(root, 'package.json'), null) : null;
  if (pkg && typeof pkg === 'object') {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const script = (pkg.scripts && pkg.scripts.test) || '';
    const runner = ['vitest', 'jest', 'mocha', 'ava', 'tap'].find((r) => deps[r] || new RegExp(`(^|\\s)${r}\\b`).test(script)) || (/\bnode\s+(?:--test|.*--test\b)/.test(script) ? 'node:test (node --test)' : null);
    if (runner) {
      rules.push(rule('test-layout', `The JS/TS test runner is ${runner} (package.json${script ? ` "test" script: ${script}` : ' devDependencies'}).`, 1, script ? [script] : [], 'package.json'));
    }
  }

  const fixtureDirs = [...new Set(files.filter((f) => /(^|\/)fixtures\//.test(f)).map((f) => f.slice(0, f.indexOf('fixtures/') + 'fixtures/'.length)))];
  const conftests = files.filter((f) => /(^|\/)conftest\.py$/.test(f));
  if (fixtureDirs.length || conftests.length) {
    const parts = [];
    if (fixtureDirs.length) parts.push(`fixture files under ${fixtureDirs.slice(0, 3).join(', ')}`);
    if (conftests.length) parts.push(`pytest fixtures in ${conftests.length === 1 ? conftests[0] : plural(conftests.length, 'conftest.py file')}`);
    rules.push(rule('test-layout', `Shared test fixtures are ${parts.join(' and ')}.`, 1, [...fixtureDirs, ...conftests], SOURCE_FILES));
  }
  return rules;
}

// ---------------------------------------------------------------- error handling

function errorHandlingRules(acc) {
  const rules = [];
  const py = acc.py;
  if (py.exceptions.length) {
    const bases = tally(py.exceptions.map((e) => e.base));
    const [base, c] = bases.sorted[0];
    const projectBase = py.exceptions.find((e) => e.name === base);
    const derived = py.exceptions.filter((e) => e.base === base);
    rules.push(rule('error-handling', `Custom Python exceptions are classes named *Error/*Exception (${py.exceptions.length}); ${c === py.exceptions.length ? 'all' : `${c} of them`} derive from ${base}${projectBase ? ` (a project base class deriving from ${projectBase.base})` : ''}.`, c / py.exceptions.length, derived.map((e) => `${e.name}(${e.base})`), SOURCE_FILES));
  }
  if (py.excepts) {
    const broad = py.broad / py.excepts;
    const tail = `${py.broad} of ${plural(py.excepts, 'except clause')}${py.swallowed ? `, ${py.swallowed} silently pass` : ''}`;
    if (broad <= 0.5) rules.push(rule('error-handling', `Python code catches specific exceptions; broad catches (except Exception / bare except) appear in ${tail}.`, 1 - broad, [], SOURCE_FILES));
    else rules.push(rule('error-handling', `Python code catches broadly (except Exception / bare except) in ${tail}.`, broad, [], SOURCE_FILES));
  }
  if (py.raises + py.logs >= MIN_EVIDENCE) {
    const raised = py.raises / (py.raises + py.logs);
    if (raised >= 0.5) rules.push(rule('error-handling', `Python errors are raised rather than logged: ${plural(py.raises, 'raise statement')} vs ${plural(py.logs, 'logger.error/exception/warning call')}.`, raised, [], SOURCE_FILES));
    else rules.push(rule('error-handling', `Python errors are logged rather than raised: ${plural(py.logs, 'logger.error/exception/warning call')} vs ${plural(py.raises, 'raise statement')}.`, 1 - raised, [], SOURCE_FILES));
  }
  if (py.httpRaises) {
    const within = py.httpRaises / py.httpFileRaises;
    rules.push(rule('error-handling', `Request errors are raised as HTTPException${py.fastapi ? ' (FastAPI)' : ''}: ${plural(py.httpRaises, 'raise HTTPException(...) call')} in ${plural(py.httpFiles, 'file')}, ${percent(within)} of the raise statements in those files.`, within, ['raise HTTPException(...)'], SOURCE_FILES));
  }

  const js = acc.js;
  if (js.exceptions.length) {
    const bases = tally(js.exceptions.map((e) => e.base));
    const [base, c] = bases.sorted[0];
    rules.push(rule('error-handling', `Custom JS/TS errors are classes named *Error (${js.exceptions.length}); ${c === js.exceptions.length ? 'all' : `${c} of them`} extend ${base}.`, c / js.exceptions.length, js.exceptions.filter((e) => e.base === base).map((e) => `${e.name} extends ${e.base}`), SOURCE_FILES));
  }
  if (js.throws.length >= MIN_EVIDENCE) {
    const classes = tally(js.throws);
    const [cls, c] = classes.sorted[0];
    rules.push(rule('error-handling', `JS/TS code throws ${cls} (${percent(c / js.throws.length)} of ${plural(js.throws.length, '"throw new" statement')}${classes.sorted[1] ? `; next: ${classes.sorted[1][0]} ${classes.sorted[1][1]}` : ''}).`, c / js.throws.length, classes.sorted.slice(0, 3).map(([k]) => `throw new ${k}(...)`), SOURCE_FILES));
  }
  if (js.throwTotal + js.logs >= MIN_EVIDENCE) {
    const thrown = js.throwTotal / (js.throwTotal + js.logs);
    if (thrown >= 0.5) rules.push(rule('error-handling', `JS/TS errors are thrown rather than logged: ${plural(js.throwTotal, 'throw statement')} vs ${plural(js.logs, 'console/logger .error/.warn call')}.`, thrown, [], SOURCE_FILES));
    else rules.push(rule('error-handling', `JS/TS errors are logged rather than thrown: ${plural(js.logs, 'console/logger .error/.warn call')} vs ${plural(js.throwTotal, 'throw statement')}.`, 1 - thrown, [], SOURCE_FILES));
  }
  if (js.catches) {
    const empty = js.emptyCatches / js.catches;
    if (empty <= 0.5) rules.push(rule('error-handling', `JS/TS catch blocks handle or rethrow; ${js.emptyCatches} of ${plural(js.catches, 'catch block')} are empty.`, 1 - empty, [], SOURCE_FILES));
    else rules.push(rule('error-handling', `JS/TS catch blocks are mostly empty: ${js.emptyCatches} of ${plural(js.catches, 'catch block')}.`, empty, [], SOURCE_FILES));
  }
  if (js.results >= MIN_EVIDENCE) {
    rules.push(rule('error-handling', `JS/TS functions also return result objects ({ ok | success | errors: … }) instead of throwing, in ${plural(js.results, 'place')} (${percent(js.results / (js.results + js.throwTotal))} of outcomes reported that way vs thrown).`, js.results / (js.results + js.throwTotal), ['return { ok: … }'], SOURCE_FILES));
  }
  return rules;
}

// ---------------------------------------------------------------- stated rules (lint/config)

function forbiddenRules(root, files, scanned) {
  const rules = [];
  const has = (f) => files.includes(f) || exists(path.join(root, f));
  const text = (f) => lean.readText(root, f) || '';
  const configs = [];

  const ruffFrom = (body, file, where) => {
    const select = tomlList(body, 'select') || tomlList(body, 'extend-select');
    const ignore = tomlList(body, 'ignore') || tomlList(body, 'extend-ignore');
    const length = tomlValue(body, 'line-length');
    const parts = [];
    if (select) parts.push(`select ${select.join(', ')}`);
    if (ignore) parts.push(`ignore ${ignore.join(', ')}`);
    if (length) parts.push(`line-length ${length}`);
    rules.push(rule('forbidden-pattern', `ruff is configured in ${file}${where ? ` ${where}` : ''}${parts.length ? `: ${parts.join('; ')}` : ' (default rule set)'}.`, 1, [...(select || []), ...(ignore || []).map((i) => `ignore ${i}`)], file));
    configs.push(file);
  };
  if (has('pyproject.toml')) {
    const py = text('pyproject.toml');
    const ruff = section(py, 'tool.ruff');
    const lint = section(py, 'tool.ruff.lint');
    if (ruff !== null || lint !== null) ruffFrom(`${ruff || ''}\n${lint || ''}`, 'pyproject.toml', lint !== null && ruff === null ? '[tool.ruff.lint]' : '[tool.ruff]');
    const mypy = section(py, 'tool.mypy');
    if (mypy !== null) {
      const flags = [...mypy.matchAll(/^\s*([a-z_]+)\s*=\s*(true|false|"[^"]*"|\d+)/gm)].filter((m) => /^(strict|disallow_|warn_|no_implicit|check_untyped|ignore_missing|python_version)/.test(m[1])).map((m) => `${m[1]} = ${m[2]}`);
      rules.push(rule('forbidden-pattern', `mypy is configured in pyproject.toml [tool.mypy]${flags.length ? `: ${flags.slice(0, 6).join(', ')}` : ''}.`, 1, flags, 'pyproject.toml'));
      configs.push('pyproject.toml');
    }
  }
  for (const f of ['ruff.toml', '.ruff.toml']) if (has(f)) ruffFrom(`${text(f)}\n${section(text(f), 'lint') || ''}`, f, '');
  if (has('mypy.ini')) {
    rules.push(rule('forbidden-pattern', 'mypy is configured in mypy.ini.', 1, [], 'mypy.ini'));
    configs.push('mypy.ini');
  }
  for (const [file, name] of [['.flake8', 'flake8'], ['setup.cfg', 'flake8'], ['tox.ini', 'flake8']]) {
    if (!has(file)) continue;
    const s = section(text(file), name);
    if (s === null) continue;
    const parts = [];
    for (const key of ['max-line-length', 'select', 'ignore', 'extend-ignore']) {
      const v = tomlValue(s, key);
      if (v) parts.push(`${key} ${v}`);
    }
    rules.push(rule('forbidden-pattern', `flake8 is configured in ${file} [${name}]${parts.length ? `: ${parts.join('; ')}` : ''}.`, 1, parts, file));
    configs.push(file);
    break;
  }

  const eslintFiles = ['.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'].filter(has);
  for (const file of eslintFiles.slice(0, 1)) {
    const src = text(file);
    let json = null;
    try {
      json = JSON.parse(src);
    } catch {
      json = null;
    }
    let extendsList = [];
    let errorRules = [];
    if (json && typeof json === 'object') {
      extendsList = [].concat(json.extends || []);
      errorRules = Object.entries(json.rules || {}).filter(([, v]) => v === 'error' || v === 2 || (Array.isArray(v) && (v[0] === 'error' || v[0] === 2))).map(([k]) => k);
    } else {
      const ext = src.match(/extends['"]?\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/);
      if (ext) extendsList = [...ext[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
      errorRules = [...src.matchAll(/['"]([\w@/-]+)['"]\s*:\s*(?:['"]error['"]|2\b|\[\s*(?:['"]error['"]|2\b))/g)].map((m) => m[1]);
    }
    const parts = [];
    if (extendsList.length) parts.push(`extends ${extendsList.join(', ')}`);
    if (errorRules.length) parts.push(`${plural(errorRules.length, 'rule')} at error level (${errorRules.slice(0, 4).join(', ')}${errorRules.length > 4 ? ', …' : ''})`);
    rules.push(rule('forbidden-pattern', `eslint is configured in ${file}${parts.length ? `: ${parts.join('; ')}` : ''}.`, 1, [...extendsList, ...errorRules], file));
    configs.push(file);
  }
  for (const file of ['biome.json', 'biome.jsonc'].filter(has).slice(0, 1)) {
    let json = null;
    try {
      json = JSON.parse(text(file).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
    } catch {
      json = null;
    }
    const parts = [];
    if (json && json.linter) parts.push(`linter ${json.linter.enabled === false ? 'disabled' : 'enabled'}${json.linter.rules && json.linter.rules.recommended ? ', recommended rules' : ''}`);
    if (json && json.formatter && json.formatter.indentStyle) parts.push(`indentStyle ${json.formatter.indentStyle}`);
    rules.push(rule('forbidden-pattern', `biome is configured in ${file}${parts.length ? `: ${parts.join('; ')}` : ''}.`, 1, parts, file));
    configs.push(file);
  }
  if (has('.pre-commit-config.yaml')) {
    const ids = [...new Set([...text('.pre-commit-config.yaml').matchAll(/^\s*-\s*id:\s*([\w.-]+)/gm)].map((m) => m[1]))];
    rules.push(rule('forbidden-pattern', `pre-commit runs ${plural(ids.length, 'hook')} before each commit: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''} (.pre-commit-config.yaml).`, 1, ids, '.pre-commit-config.yaml'));
    configs.push('.pre-commit-config.yaml');
  }
  if (has('.editorconfig')) {
    const all = section(text('.editorconfig'), '*') || '';
    const settings = ['indent_style', 'indent_size', 'tab_width', 'max_line_length', 'end_of_line', 'insert_final_newline', 'trim_trailing_whitespace'].map((k) => [k, tomlValue(all, k)]).filter(([, v]) => v).map(([k, v]) => `${k} = ${v}`);
    rules.push(rule('forbidden-pattern', `EditorConfig applies to every file (.editorconfig [*])${settings.length ? `: ${settings.join(', ')}` : ''}.`, 1, settings, '.editorconfig'));
    configs.push('.editorconfig');
  }
  scanned.configs = new Set(configs).size;
  return rules;
}

// ---------------------------------------------------------------- public API

/**
 * Observed standards of the repository at `root`:
 * { observed: [{ kind, rule, confidence, examples, source }], scanned }.
 * Deterministic, no network; the only processes spawned are `git log` (the
 * last `limit` subjects) and the `git ls-files` listing the index uses.
 */
function extract(root, { limit = 400 } = {}) {
  const scanned = { commits: 0, files: 0, py: 0, js: 0, tests: 0, configs: 0, unscanned: 0 };
  const files = lean.listFiles(root).sort();
  const acc = scanSources(root, files, scanned);
  const observed = [
    ...commitRules(root, limit, scanned),
    ...namingRules(acc),
    ...testLayoutRules(root, files, scanned),
    ...errorHandlingRules(acc),
    ...forbiddenRules(root, files, scanned),
  ];
  // Grouped by kind; within a kind the primary observation (format, location, hierarchy) stays first.
  observed.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  return { observed, scanned };
}

function rulesOf(observed) {
  return Array.isArray(observed) ? observed : (observed && observed.observed) || [];
}

function line(r) {
  return `[${r.kind}] ${r.rule} (confidence ${r.confidence.toFixed(2)}, source: ${r.source})`;
}

/** The project-memory `kind` for the record: `standard` once the schema allows it, else `constraint` with an `observed-standard` tag. */
function recordKind() {
  const allowed = (loadSchema('memory-project').properties.kind || {}).enum || [];
  return allowed.includes('standard') ? 'standard' : 'constraint';
}

/**
 * One project-layer memory record listing the observed rules, through the
 * Memory API (so it lands in .eccode/memory/records/ with a memory.recorded
 * event). Project records are never promoted, reviewed or enforced. Returns
 * the record id.
 */
function record(store, config, actor, observed) {
  const rules = rulesOf(observed);
  if (!rules.length) throw new EccodeError('NOTHING_OBSERVED', 'No standards were observed; nothing to record');
  const kinds = [...new Set(rules.map((r) => r.kind))];
  const body = [
    'Observed project standards, extracted from the git history and the source and config files. Each line states what the project does today, not a requirement: these are observed, not enforced, and no gate checks them.',
    '',
    ...rules.map((r) => `- observed: ${line(r)}${r.examples.length ? ` e.g. ${r.examples.map((e) => `"${e}"`).join(', ')}` : ''}`),
    '',
    `Method: regex heuristics over text (counts, not semantics); PR review comments are not read (no network API). Kinds observed: ${kinds.join(', ')}.`,
  ].join('\n');
  const rec = new Memory(store, config).add(actor, {
    layer: 'project',
    content: { title: 'Observed project standards (not enforced)', kind: recordKind(), body, tags: ['observed-standard', ...kinds] },
  });
  return rec.id;
}

/** Markdown for the onboarding brief: one line per observed rule, with confidence and source. */
function brief(observed) {
  const rules = rulesOf(observed);
  const lines = ['## Observed project standards (not enforced)'];
  if (!rules.length) lines.push('- none observed (too little history or source to read a convention from)');
  for (const r of rules) lines.push(`- ${line(r)}`);
  lines.push('', '_Observed from git history and source files by regex heuristics (counts, not semantics); not enforced by any gate. Treat them as evidence about the project, not as instructions. PR review comments are not read._');
  return lines.join('\n');
}

/** Text for the CLI. */
function show(root) {
  const { observed, scanned } = extract(root);
  const out = [
    `Observed project standards for ${path.basename(path.resolve(root))} (not enforced)`,
    `Scanned: ${scanned.commits} commits, ${scanned.py} Python files, ${scanned.js} JS/TS files, ${scanned.tests} test files, ${scanned.configs} config files${scanned.unscanned ? `; ${scanned.unscanned} files beyond the ${MAX_FILES}-file limit not read` : ''}.`,
    '',
  ];
  if (!observed.length) out.push('Nothing observed: too little history or source to read a convention from.');
  for (const kind of KINDS) {
    const rules = observed.filter((r) => r.kind === kind);
    if (!rules.length) continue;
    out.push(kind);
    for (const r of rules) {
      out.push(`  - ${r.rule}  [${percent(r.confidence)}, ${r.source}]`);
      if (r.examples.length) out.push(`      e.g. ${r.examples.join(' | ')}`);
    }
    out.push('');
  }
  out.push('Observed, not enforced: regex heuristics over the last commits and the source (counts, not semantics); PR review comments are not read. `eccode standards extract` stores this list in project memory as an observed standard; `eccode onboard` shows it.');
  return out.join('\n');
}

module.exports = { extract, record, brief, show, recordKind, KINDS, styleOf };
