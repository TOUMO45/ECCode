// T20 (spec: Security, SQL injection): "prepared statements only; a scan test forbids template literals in `db.prepare(` calls".
//
// The scan reads every .js, .mjs and .cjs file under src/ and scripts/, blanks out comments, finds each `.prepare(` and `.exec(` call
// (whitespace before the parenthesis is allowed) and classifies its first argument:
//   - a plain string literal, or a template literal with no `${}`: static SQL, always accepted;
//   - a template literal WITH `${expr}`: accepted only when (file, expr) is on the allow-list below, and every entry says why the
//     interpolated text can never come from a request, a header, a body, the database or any other input;
//   - string concatenation, a bare variable argument, or anything else: refused unless on the allow-list.
// The values the statements use always travel as `?` parameters.
//
// Rework-8 (SEC-G-2) closed the ways round the first version of this scan:
//   (a) an allow-list entry is not a name that is trusted wherever it appears: it carries the EXACT number of uses (a second use of
//       `where` in calls.js fails), and the text of every statement that assigns the name or declares it is pinned by hash, so
//       writing input into an allow-listed variable (`where += ... ${query.x}`) or re-declaring it fails too;
//   (b) `.exec(<non-literal>)` is a database call unless its receiver is a regular expression (a literal, `new RegExp`, or a name
//       declared as one in that file); the migration runner is the only entry;
//   (c) `.prepare` / `.exec` as anything but a call (`db.prepare.bind(db)`, `db['prepare']`, `const { prepare } = db`) is reported,
//       unless it is on the REFERENCES list with an exact count;
//   (d) .mjs and .cjs files are scanned as well.
//
// DEVIATION FROM THE LITERAL SPEC TEXT (accepted by the phase G reviewers on the conditions above): the code base (phases C to F)
// builds some statements from constants and from `?` placeholder lists with a template literal (about thirty call sites in a dozen
// files at the time of writing), so a literal ban fails on code that is correct. What the ban protects is that no INPUT reaches the
// SQL text. This scan pins exactly that: any new interpolation, in any file, fails with its file, line and text until a reviewer adds
// a justified entry here; and an existing entry cannot be reused for another purpose without changing a pinned count or hash.
//
// To re-pin after a reviewed change: run this file; the failure names the new count or prints the new statement with its hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// file (relative, POSIX) -> expression -> { why, uses, sites }.
//   uses  exact number of times the expression is interpolated into (or, for "arg:NAME", passed as) the SQL text of a call in that file
//   sites sha256 prefixes of the normalized statements that assign or declare the expression's leading name (in order of appearance);
//         [] means the name is never assigned in the file (a parameter or an import)
// Expressions are compared after collapsing whitespace.
//   also  other names the entry rests on (a helper constant): the same pin for their statements
//   fns   functions that build the text: sha256 prefix of the normalized function text
const ALLOWED = Object.freeze({
  'src/auth/sessions.js': {
    'arg:SELECT_SESSION': { why: 'a module constant SELECT statement', uses: 1, sites: ['7c639aa3'] },
  },
  'src/ai/gate.js': {
    'arg:sql': { why: 'a module-local constant string (SELECT ... FROM model_spend WHERE day = ?); the optional " AND customer_id = ?" is a template of it and a literal', uses: 1, sites: ['c13a8c8b'] },
    sql: { why: 'the constant above, extended with a literal', uses: 1, sites: ['c13a8c8b'] },
  },
  'src/auth/general-limit.js': {
    readBusyWaitMs: { why: 'a configuration integer bound by the config reader; used in PRAGMA busy_timeout only', uses: 1, sites: ['5aa616ec'] },
    normal: { why: "the connection's own busyTimeoutMs, an integer validated by openDb", uses: 1, sites: ['08efba15'] },
  },
  'src/db/connection.js': {
    busyTimeoutMs: { why: 'an integer; openDb throws a RangeError unless it is an integer from 0 to 5000', uses: 1, sites: ['ad81fdaf'] },
  },
  'src/db/migrate.js': {
    'arg:CREATE_TRACKING': { why: 'a module constant CREATE TABLE statement for the migration bookkeeping', uses: 1, sites: ['2bfe3c88'] },
    'arg:file.sql': { why: 'the text of a migration file read from src/db/migrations (shipped with the code, never input): the migration runner is the only database exec of a variable', uses: 1, sites: ['e1aa9622'] },
  },
  'src/services/extraction.js': {
    'arg:SQL_LIVE_IMAGE': { why: 'a module constant SELECT statement', uses: 3, sites: ['9d1f2fd4'] },
  },
  'src/services/requests.js': {
    'arg:HOLDING_SQL': { why: 'a module constant SELECT statement', uses: 1, sites: ['944814c2'] },
  },
  'src/services/supersession.js': {
    'placeholders(offerIds.length)': { why: 'placeholders(n): n question marks joined by commas, n the number of offer ids; the ids travel as parameters', uses: 2, sites: ['583b6040'] },
  },
  'src/services/admin.js': {
    'arg:sql': { why: 'the local helper ids(sql) of requestScope(), called only with four string literals in the same function', uses: 1, sites: [] },
    "RESET_BLOCKING_STATES.map(() => '?').join(',')": { why: 'a placeholder list: as many ? as a module constant has members', uses: 2, sites: ['91c045f3'] },
    where: {
      why: 'built in buildTimeline from afterClause() (a comparison on a fixed column with ? parameters) and fixed entity-type literals; ids go through inList() as numbers from the database and as ? parameters',
      uses: 3,
      sites: ['09e9cbb5', '8df3cb8c', '09e9cbb5', '19d498a9', '09e9cbb5', '968a1cb6'],
      also: { inList: ['d90e05d9'] },
      fns: { afterClause: '50d5776b' },
    },
    'a.sql': { why: 'the result of afterClause(): fixed column names and ? placeholders', uses: 1, sites: ['8623dd3a', '3640a2bf', '769f7b48', 'de8551d2'], fns: { afterClause: '50d5776b' } },
  },
  'src/services/calls.js': {
    OP_SELECT: { why: 'a module constant SELECT list', uses: 1, sites: ['2ff297f5'] },
    "wanted.map(() => '?').join(',')": { why: 'a placeholder list sized by `wanted`, which dueCallIds filters to the four fixed call kinds', uses: 1, sites: ['3ebd43e3'] },
    assignments: { why: 'built in moveOperation from "col = ?" for names that must be in OPERATION_COLUMNS or the call throws', uses: 1, sites: ['9de539e1'], fns: { moveOperation: 'becc9f07' } },
    where: { why: 'a constant WHERE clause in recordCall (id, send_token, status as ? parameters)', uses: 3, sites: ['a7f75207'] },
  },
  'src/services/orders.js': {
    ORDER_SELECT: { why: 'a module constant SELECT list with joins', uses: 4, sites: ['afa55190'] },
    "ids.map(() => '?').join(',')": { why: 'a placeholder list sized by the number of ids; the ids travel as parameters', uses: 1, sites: ['e96dafa0'] },
  },
  'src/services/plans.js': {
    "LIVE_RESERVATION_STATES.map(() => '?').join(',')": { why: 'a placeholder list sized by a module constant', uses: 2, sites: [] },
  },
  'src/services/reservations.js': {
    "LIVE_RESERVATION_STATES.map(() => '?').join(',')": { why: 'a placeholder list sized by a module constant', uses: 1, sites: [] },
  },
  'src/services/saga.js': {
    'arg:PLAN_OPERATIONS': { why: 'a module constant SELECT statement', uses: 1, sites: ['eaeacd50'] },
    LEASE_WHERE: { why: 'a module constant WHERE clause (id, status, executor_id, lease_epoch as ? parameters)', uses: 4, sites: ['56715359'] },
  },
  'src/services/users.js': {
    USER_SELECT: { why: 'a module constant SELECT list with joins', uses: 2, sites: ['2e315c94'] },
  },
  'src/services/view.js': {
    ph: { why: 'placeholders(n): n question marks joined by commas, n the number of ids', uses: 12, sites: ['70963aa2'], also: { placeholders: ['583b6040'] } },
    runColumns: { why: 'a ternary between two string literals', uses: 1, sites: ['66e9062c'] },
    versionColumns: { why: 'a ternary between two string literals', uses: 1, sites: ['786ff057'] },
  },
  'src/services/webhooks.js': {
    'arg:INSERT_ROW': { why: 'a module constant INSERT statement', uses: 1, sites: ['e593e5c9'] },
    column: { why: 'one of the column names of the constant lookup table WEBHOOK_EVENTS of webhooks.js (never input)', uses: 1, sites: [], also: { WEBHOOK_EVENTS: ['d8bb1d94'] } },
  },
});

// File -> { name -> exact count } of references to .prepare / .exec that are not calls.
const REFERENCES = Object.freeze({
  'src/auth/general-limit.js': { exec: { why: "typeof db.exec !== 'function': a feature test, nothing is run", count: 1 } },
});

// ---- the scanner ---------------------------------------------------------------------------------------------------------

function skipQuoted(code, i) {
  const q = code[i];
  let j = i + 1;
  while (j < code.length && code[j] !== q && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
  return j + 1;
}

// A template literal starting at code[i] === '`': { end (index after the closing backtick), interpolations[] }.
function readTemplate(code, i) {
  const interpolations = [];
  let p = i + 1;
  while (p < code.length && code[p] !== '`') {
    if (code[p] === '\\') p += 2;
    else if (code[p] === '$' && code[p + 1] === '{') {
      let depth = 1;
      let j = p + 2;
      while (j < code.length && depth > 0) {
        const c = code[j];
        if (c === '{') {
          depth += 1;
          j += 1;
        } else if (c === '}') {
          depth -= 1;
          j += 1;
        } else if (c === '`') j = readTemplate(code, j).end;
        else if (c === "'" || c === '"') j = skipQuoted(code, j);
        else j += 1;
      }
      interpolations.push(code.slice(p + 2, j - 1).replace(/\s+/g, ' ').trim());
      p = j;
    } else p += 1;
  }
  return { end: p + 1, interpolations };
}

// Replaces comments with spaces (same length, newlines kept) so offsets and line numbers stay valid. Strings, templates (with
// nested `${}`) and regular expression-free code are tracked; a `//` inside a string is not a comment.
export function blankComments(source) {
  const out = source.split('');
  const stack = []; // 'tpl' | 'expr' entries for nested template literals
  let i = 0;
  const n = source.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = source[i];
    const top = stack[stack.length - 1];
    if (top === 'tpl') {
      if (c === '\\') i += 2;
      else if (c === '`') {
        stack.pop();
        i += 1;
      } else if (c === '$' && source[i + 1] === '{') {
        stack.push('expr');
        i += 2;
      } else i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
    } else if (c === '/' && source[i + 1] === '*') {
      const j = source.indexOf('*/', i + 2);
      const end = j === -1 ? n : j + 2;
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else if (c === '`') {
      stack.push('tpl');
      i += 1;
    } else if (c === '{' && top === 'expr') {
      stack.push('expr');
      i += 1;
    } else if (c === '}' && top === 'expr') {
      stack.pop();
      i += 1;
    } else i += 1;
  }
  return out.join('');
}

// Replaces the inside of string literals and the text parts of template literals with spaces (same length), keeping the code inside
// `${}`. Used to look for names and `.prepare` references without matching words that sit inside SQL text.
export function maskLiterals(code) {
  const out = code.split('');
  const mask = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let maskTemplate;
  const walk = (start, untilBrace) => {
    let i = start;
    let depth = 0;
    while (i < code.length) {
      const c = code[i];
      if (c === "'" || c === '"') {
        const end = skipQuoted(code, i);
        mask(i + 1, end - 1);
        i = end;
      } else if (c === '`') i = maskTemplate(i);
      else if (untilBrace && c === '{') {
        depth += 1;
        i += 1;
      } else if (untilBrace && c === '}') {
        if (depth === 0) return i;
        depth -= 1;
        i += 1;
      } else i += 1;
    }
    return i;
  };
  maskTemplate = (i) => {
    let j = i + 1;
    let textStart = j;
    while (j < code.length && code[j] !== '`') {
      if (code[j] === '\\') j += 2;
      else if (code[j] === '$' && code[j + 1] === '{') {
        mask(textStart, j + 2);
        j = walk(j + 2, true) + 1;
        textStart = j;
      } else j += 1;
    }
    mask(textStart, j);
    return j + 1;
  };
  walk(0, false);
  return out.join('');
}

// Reads the first argument of the call whose '(' is at `open`: one operand, or operands joined by '+'.
// -> { kind: 'string' | 'template' | 'other' | 'concat-other', interpolations, text }
//    'string'/'template' = literals only (a chain of literals is static SQL); 'concat-other' = a '+' chain with a non-literal.
function readFirstArgument(code, open) {
  let i = open + 1;
  while (/\s/.test(code[i])) i += 1;
  const start = i;
  const first = readOperand(code, i);
  let kind = first.kind;
  const interpolations = [...first.interpolations];
  i = first.end;
  for (;;) {
    let j = i;
    while (/\s/.test(code[j])) j += 1;
    if (code[j] !== '+' || kind === 'other') break;
    j += 1;
    while (/\s/.test(code[j])) j += 1;
    const next = readOperand(code, j);
    interpolations.push(...next.interpolations);
    if (next.kind === 'other') kind = 'concat-other';
    else if (kind === 'string' && next.kind === 'template') kind = 'template';
    i = next.end;
  }
  return { kind, interpolations, text: code.slice(start, i).replace(/\s+/g, ' ').trim() };
}

function readOperand(code, i) {
  if (code[i] === '`') {
    const t = readTemplate(code, i);
    return { kind: 'template', interpolations: t.interpolations, end: t.end };
  }
  if (code[i] === "'" || code[i] === '"') {
    const q = code[i];
    let j = i + 1;
    while (j < code.length && code[j] !== q) j += code[j] === '\\' ? 2 : 1;
    return { kind: 'string', interpolations: [], end: j + 1 };
  }
  let depth = 0;
  let j = i;
  while (j < code.length && !(depth === 0 && (code[j] === ',' || code[j] === ')'))) {
    if ('([{'.includes(code[j])) depth += 1;
    if (')]}'.includes(code[j])) depth -= 1;
    j += 1;
  }
  return { kind: 'other', interpolations: [], end: j };
}

// The statement that starts at `start` (an assignment or a declaration), up to its ';' or ',' at depth 0.
function readStatement(code, start) {
  let i = start;
  let depth = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"') i = skipQuoted(code, i);
    else if (c === '`') i = readTemplate(code, i).end;
    else if ('([{'.includes(c)) {
      depth += 1;
      i += 1;
    } else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
    } else if ((c === ';' || c === ',') && depth === 0) break;
    else i += 1;
  }
  return code.slice(start, i).replace(/\s+/g, ' ').trim();
}

const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The statements that assign or declare `name` in the file (`name = ...`, `name += ...`, `const name = ...`, a default `{ name = ... }`).
// Names inside string and template text are ignored (masked); property accesses (`x.name = `) are not assignments of `name`.
function assignmentSites(code, masked, name) {
  const pattern = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*(?:\\+|-|\\*|\\|\\||&&|\\?\\?)?=(?![=>])`, 'g');
  return [...masked.matchAll(pattern)].map((m) => {
    const text = readStatement(code, m.index);
    return { text, hash: hashOf(text) };
  });
}

// The text of `function name(...) { ... }` (normalized), or null.
function functionText(code, masked, name) {
  const start = new RegExp(`(?<![\\w$.])(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`).exec(masked);
  if (!start) return null;
  let i = start.index + start[0].length;
  for (let depth = 1; i < masked.length && depth > 0; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') depth -= 1;
  }
  while (i < masked.length && masked[i] !== '{') i += 1;
  let depth = 0;
  for (; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return code.slice(start.index, i).replace(/\s+/g, ' ').trim();
}

// The name an allow-list key is built on: "arg:file.sql" -> file, "placeholders(n)" -> placeholders, "LIST.map(...)" -> LIST, "a.sql" -> a.
const leadName = (key) => /^(?:arg:)?([A-Za-z_$][\w$]*)/.exec(key)?.[1] ?? null;

const CALL = /\.\s*(prepare|exec)\s*\(/g;
const MEMBER = /\.\s*(prepare|exec)\b/g;
const BRACKET = /\[\s*(?:'(prepare|exec)'|"(prepare|exec)"|`(prepare|exec)`)\s*\]/g;
const DESTRUCTURED = /\{[^{}]*\b(prepare|exec)\b[^{}]*\}\s*=(?!=)/g;

// Is the receiver of the `.exec` at `index` a regular expression? A literal, `new RegExp(...)`, or a name this file declares as one.
function receiverIsRegExp(code, index) {
  const before = code.slice(0, index).trimEnd();
  if (/\/[dgimsuvy]*$/.test(before)) return true;
  if (/new\s+RegExp\s*\([^()]*\)$/.test(before)) return true;
  const name = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1];
  if (!name) return false;
  return new RegExp(`(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*(?:/|new\\s+RegExp)`).test(code);
}

// scanSource(source, file, allowed, references) -> { calls, problems[], usage, expected }
export function scanSource(source, file, allowed = ALLOWED, references = REFERENCES) {
  const code = blankComments(source);
  const masked = maskLiterals(code);
  const problems = [];
  const usage = new Map();
  const bump = (key) => usage.set(key, (usage.get(key) ?? 0) + 1);
  let calls = 0;
  const known = allowed[file] ?? {};
  const callStarts = new Set();
  for (const match of code.matchAll(CALL)) {
    callStarts.add(match.index);
    const line = code.slice(0, match.index).split('\n').length;
    const arg = readFirstArgument(code, match.index + match[0].length - 1);
    // `.exec(variable)` on a regular expression is not a database call.
    if (match[1] === 'exec' && arg.kind === 'other' && receiverIsRegExp(code, match.index)) continue;
    calls += 1;
    const where = `${file}:${line} .${match[1]}(`;
    if (arg.kind === 'concat-other') problems.push(`${where} builds SQL by string concatenation with a non-literal: ${arg.text.slice(0, 80)}`);
    else if (arg.kind === 'string' || (arg.kind === 'template' && arg.interpolations.length === 0)) continue;
    else if (arg.kind === 'template') {
      for (const expr of arg.interpolations) {
        if (Object.hasOwn(known, expr)) bump(expr);
        else problems.push(`${where} interpolates \${${expr}} into SQL and (${file}, ${expr}) is not on the allow-list`);
      }
    } else if (Object.hasOwn(known, `arg:${arg.text}`)) bump(`arg:${arg.text}`);
    else problems.push(`${where} passes a non-literal as SQL text: ${arg.text.slice(0, 80)}`);
  }
  // (c) .prepare / .exec that is not a call.
  const refCount = new Map();
  const refs = [];
  for (const m of masked.matchAll(MEMBER)) if (!callStarts.has(m.index)) refs.push([m.index, m[1]]);
  for (const m of masked.matchAll(DESTRUCTURED)) refs.push([m.index, m[1]]);
  for (const m of code.matchAll(BRACKET)) refs.push([m.index, m[1] ?? m[2] ?? m[3]]);
  for (const [index, name] of refs) {
    refCount.set(name, (refCount.get(name) ?? 0) + 1);
    const line = code.slice(0, index).split('\n').length;
    if (!Object.hasOwn(references[file] ?? {}, name)) problems.push(`${file}:${line} refers to .${name} without calling it (an alias, bind or destructuring would run SQL this scan does not read)`);
  }
  for (const [name, entry] of Object.entries(references[file] ?? {})) {
    if ((refCount.get(name) ?? 0) !== entry.count) problems.push(`${file}: the allow-list expects ${entry.count} non-call reference(s) to .${name} and finds ${refCount.get(name) ?? 0}`);
  }
  // (a) exact counts and pinned statements.
  const siteHashes = new Map();
  for (const [key, entry] of Object.entries(known)) {
    const found = usage.get(key) ?? 0;
    if (found !== entry.uses) problems.push(`${file}: the allow-list expects ${entry.uses} use(s) of ${key} in SQL text and finds ${found}`);
    const name = leadName(key);
    const sites = name ? assignmentSites(code, masked, name) : [];
    const expected = entry.sites ?? [];
    const actual = sites.map((s) => s.hash);
    siteHashes.set(key, actual);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${file}: statements that assign or declare ${name} (for the entry ${key}) changed: expected [${expected.join(', ')}], found [${actual.join(', ')}]; ${sites.map((s) => `${s.hash} = ${s.text.slice(0, 160)}`).join(' || ')}`);
    }
    // Other names the entry's safety rests on (a helper constant), and functions that build the text.
    const pins = new Map();
    for (const [other, hashes] of Object.entries(entry.also ?? {})) {
      const found = assignmentSites(code, masked, other);
      pins.set(other, found.map((s) => s.hash));
      if (JSON.stringify(found.map((s) => s.hash)) !== JSON.stringify(hashes)) problems.push(`${file}: statements that assign or declare ${other} (for the entry ${key}) changed: expected [${hashes.join(', ')}], found [${found.map((s) => s.hash).join(', ')}]; ${found.map((s) => `${s.hash} = ${s.text.slice(0, 160)}`).join(' || ')}`);
    }
    for (const [fn, hash] of Object.entries(entry.fns ?? {})) {
      const found = functionText(code, masked, fn);
      pins.set(`function ${fn}`, found ? [hashOf(found)] : []);
      if (!found || hashOf(found) !== hash) problems.push(`${file}: the function ${fn} (for the entry ${key}) changed: expected ${hash}, found ${found ? hashOf(found) : 'no such function'}`);
    }
    if (pins.size > 0) siteHashes.set(`${key} (pinned helpers)`, Object.fromEntries(pins));
  }
  return { calls, problems, usage, siteHashes };
}

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(path);
  }
  return out;
}

// ---- tests ---------------------------------------------------------------------------------------------------------------

const entryOf = (uses, sites = []) => ({ why: 'test', uses, sites });

test('T20: the scan is not vacuous: it refuses interpolation of input, concatenation and a variable as SQL text, and accepts static SQL and allow-listed constants', () => {
  const bad = [
    ['db.prepare(`SELECT * FROM t WHERE id = ${req.params.id}`).get()', /interpolates \$\{req\.params\.id\}/],
    ["db.prepare('SELECT * FROM t WHERE name = ' + name).get()", /string concatenation/],
    ['db.prepare(userSuppliedSql).all()', /non-literal as SQL text: userSuppliedSql/],
    ['db.exec(`DELETE FROM t WHERE x = ${x}`)', /interpolates \$\{x\}/],
    ["db.prepare('SELECT * FROM t ' + 'WHERE a = ' + a).get()", /concatenation with a non-literal/],
    ['db.prepare(`SELECT ${OTHER} FROM t`).all()', /interpolates \$\{OTHER\}/],
    // SEC-G-2 (c): whitespace before the parenthesis, and a method that is not called
    ["db.prepare (`SELECT id FROM users WHERE username = '${name}'`).get()", /interpolates \$\{name\}/],
    ["db\n  .prepare\n  (`SELECT id FROM users WHERE username = '${name}'`).get()", /interpolates \$\{name\}/],
    ["const run = db.prepare.bind(db); run(`SELECT '${name}'`).get()", /refers to \.prepare without calling it/],
    ["const run = db['prepare']; run(sql)", /refers to \.prepare without calling it/],
    ["const { prepare } = db; prepare(sql)", /refers to \.prepare without calling it/],
    ['const e = db.exec; e(sql)', /refers to \.exec without calling it/],
    // SEC-G-2 (b): a database exec of a variable is not a RegExp.exec
    ['ctx.db.exec(ctx.query.sql)', /non-literal as SQL text: ctx\.query\.sql/],
    ['const sql = ctx.query.sql; ctx.db.exec(sql)', /non-literal as SQL text: sql/],
  ];
  for (const [snippet, pattern] of bad) {
    const { problems } = scanSource(snippet, 'src/x.js', {}, {});
    assert.ok(problems.length >= 1, snippet);
    assert.match(problems.join('\n'), pattern, snippet);
  }
  const good = [
    "db.prepare('SELECT 1').get()",
    'db.prepare(`SELECT 1 FROM t WHERE a = ? AND b = ?`).get(1, 2)',
    'db\n  .prepare(\n    "SELECT * FROM t WHERE id = ?",\n  )\n  .get(1)',
    '// db.prepare(`SELECT ${x}`) in a comment\nconst y = 1;',
    "db.prepare('SELECT * FROM t ' + 'WHERE a = ?').get(1)",
    'const m = /^a(b)$/.exec(name);',
    'const RE = /^a(b)$/u; const m = RE.exec(name);',
    'const m = new RegExp(pattern).exec(name);',
    "const text = 'http://example.test'; db.prepare('SELECT 2').get();",
    "const note = 'call db.prepare later and read .exec docs'; db.prepare('SELECT 3').get();",
    'const q = `uses .prepare and .exec in prose`; db.prepare(`SELECT 4`).get();',
  ];
  for (const snippet of good) assert.deepEqual(scanSource(snippet, 'src/x.js', {}, {}).problems, [], snippet);
});

test('T20: an allow-list entry carries an exact count and pinned statements: a second use, a new assignment, a changed assignment and a stale entry all fail (SEC-G-2 a)', () => {
  const base = 'const where = "WHERE id = ?";\ndb.prepare(`SELECT * FROM t ${where}`).get(1);\n';
  const site = scanSource(base, 'src/x.js', { 'src/x.js': { where: entryOf(1, ['@@']) } }, {}).problems[0].match(/found \[([0-9a-f]{8})\]/)[1];
  const allow = { 'src/x.js': { where: entryOf(1, [site]) } };
  assert.deepEqual(scanSource(base, 'src/x.js', allow, {}).problems, [], 'the reviewed code is accepted');
  // ms-1: the allow-listed name reused for a value built from input, in a second statement
  const reuse = `${base}function f(filter) {\n  const where = \`status = '\${filter}'\`;\n  return db.prepare(\`SELECT * FROM t WHERE \${where}\`).all();\n}\n`;
  const reused = scanSource(reuse, 'src/x.js', allow, {}).problems.join('\n');
  assert.match(reused, /expects 1 use\(s\) of where in SQL text and finds 2/);
  assert.match(reused, /statements that assign or declare where .* changed/);
  // MS1: input written into the allow-listed variable before the one reviewed prepare()
  const taint = base.replace('const where = "WHERE id = ?";', 'let where = "WHERE id = ?";\nwhere += ` AND x = \'${query.x}\'`;');
  assert.match(scanSource(taint, 'src/x.js', allow, {}).problems.join('\n'), /statements that assign or declare where .* changed/);
  // a changed assignment (the constant now says something else)
  assert.match(scanSource(base.replace('WHERE id = ?', 'WHERE id = 1 OR 1'), 'src/x.js', allow, {}).problems.join('\n'), /changed/);
  // a stale entry (the use is gone)
  assert.match(scanSource('const where = "WHERE id = ?";\n', 'src/x.js', allow, {}).problems.join('\n'), /expects 1 use\(s\) of where in SQL text and finds 0/);
  // the allow-list is per file
  assert.ok(scanSource('db.prepare(`SELECT ${where} FROM t`).all()', 'src/y.js', allow, {}).problems.length >= 1);
  // an expression that is a member or a call is counted too
  const calls = 'const ph = placeholders(ids.length);\ndb.prepare(`SELECT 1 WHERE x IN (${ph})`).all(...ids);\n';
  const callSite = scanSource(calls, 'src/z.js', { 'src/z.js': { ph: entryOf(1, ['@@']) } }, {}).problems[0].match(/found \[([0-9a-f]{8})\]/)[1];
  assert.deepEqual(scanSource(calls, 'src/z.js', { 'src/z.js': { ph: entryOf(1, [callSite]) } }, {}).problems, []);
  // references that are not calls need an exact entry
  const ref = "if (typeof db.exec !== 'function') return;";
  assert.equal(scanSource(ref, 'src/r.js', {}, {}).problems.length, 1);
  assert.deepEqual(scanSource(ref, 'src/r.js', {}, { 'src/r.js': { exec: { why: 'x', count: 1 } } }).problems, []);
  assert.equal(scanSource(`${ref}\n${ref}`, 'src/r.js', {}, { 'src/r.js': { exec: { why: 'x', count: 1 } } }).problems.length, 1, 'a second reference is not covered');
});

test('T20: every .prepare( and .exec( call under src/ and scripts/ (.js, .mjs, .cjs) is static SQL or an allow-listed constant; no value reaches the SQL text', () => {
  const problems = [];
  let calls = 0;
  const seen = new Map();
  for (const dir of ['src', 'scripts']) {
    for (const path of sourceFiles(join(ROOT, dir))) {
      const file = relative(ROOT, path).split('\\').join('/');
      const result = scanSource(readFileSync(path, 'utf8'), file);
      calls += result.calls;
      problems.push(...result.problems);
      seen.set(file, result.calls);
    }
  }
  assert.ok(calls > 300, `the scan saw ${calls} prepare/exec calls in ${seen.size} files (it should see several hundred)`);
  assert.ok([...seen.keys()].some((f) => f.endsWith('.cjs')), 'the scan reads .cjs files');
  assert.deepEqual(problems, [], 'SQL text built from something that is not a reviewed constant');
});

test('T20: every file named by the allow-list or the references list exists and was scanned (a renamed file must not leave a silent entry)', () => {
  const scanned = new Set();
  for (const dir of ['src', 'scripts']) for (const path of sourceFiles(join(ROOT, dir))) scanned.add(relative(ROOT, path).split('\\').join('/'));
  const missing = [...Object.keys(ALLOWED), ...Object.keys(REFERENCES)].filter((file) => !scanned.has(file));
  assert.deepEqual(missing, []);
});

test('T20: the route and HTTP layers, which see request data first, have no allow-list at all: any SQL there is a static literal', () => {
  let calls = 0;
  for (const dir of ['src/routes', 'src/http']) {
    for (const path of sourceFiles(join(ROOT, dir))) {
      const file = relative(ROOT, path).split('\\').join('/');
      const result = scanSource(readFileSync(path, 'utf8'), file, {}, {});
      calls += result.calls;
      assert.deepEqual(result.problems, [], file);
    }
  }
  assert.ok(calls >= 1, 'the health route runs SELECT 1; the scan reached it');
});
