'use strict';
// Reproduction probe: an UNQUOTED native Windows path as a shell redirect target is read by the
// guard's POSIX tokenizer (splitCommands) as backslash escapes, so `C:\Users\me\Temp\notes.md`
// becomes the word `C:UsersmeTempnotes.md`. On win32 that is a drive-RELATIVE path, which
// path.resolve binds under the hook cwd (the project), so a reviewer's redirect is judged as a
// project-file edit and denied. The quoted form keeps the backslashes and is judged correctly.
//
// Runs the INSTALLED guard bytes (~/.claude/eccode/scripts/hooks/guard.js), unmodified:
//   A. its own splitCommands on the unquoted and quoted lines (tokenizer evidence);
//   B. end-to-end on Linux with posix fixtures (control: per-target root / outside logic works);
//   C. end-to-end with win32 path semantics through win32-path-shim.js (the CI shape).
// Exit 1 = the ad69e6d test lines (unquoted) are over-denied (symptom reproduced) while the
// quoted lines and the controls behave; exit 2 = a control failed (experiment not trustworthy).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ECC = fs.realpathSync(path.join(os.homedir(), '.claude', 'eccode'));
const GUARD = path.join(ECC, 'scripts', 'hooks', 'guard.js');
const REPO_GUARD = '/home/user/ECCode/scripts/hooks/guard.js';
const SHIM = path.join(__dirname, 'win32-path-shim.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const DENY_RE = /reviews\/designs but does not edit project files/;

const results = [];
let symptom = 0;
let controlFailed = 0;
function record(section, label, out, expect, kind) {
  const got = out ? out.permissionDecision : null;
  const ok = expect === 'null' ? out === null : got === 'deny';
  results.push({ section, label, kind, expect, got, reason: out ? out.permissionDecisionReason : null, ok });
  if (!ok && kind === 'ad69e6d-test-line') symptom++;
  if (!ok && kind !== 'ad69e6d-test-line') controlFailed++;
}

function hook(payload, { win = false, sandbox = '', env = {} } = {}) {
  const args = win ? ['-r', SHIM, GUARD] : [GUARD];
  const res = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '', WIN_SANDBOX: sandbox, WIN_ECC_DIR: ECC, ...env },
  });
  if (res.status !== 0 || res.stderr.trim()) {
    // The guard fails open on an internal error; an "allowed" here would be meaningless.
    throw new Error(`guard error (status ${res.status}): ${res.stderr}`);
  }
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}
const agent = (role) => (role ? { agent_type: `eccode:${role}` } : {});
const bash = (cwd, command, role, o) => hook({ cwd, tool_name: 'Bash', ...agent(role), tool_input: { command } }, o);
const write = (cwd, file, role, o) => hook({ cwd, tool_name: 'Write', ...agent(role), tool_input: { file_path: file } }, o);
function mkRecord(dir) {
  fs.mkdirSync(path.join(dir, '.eccode', 'reviews', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.eccode', 'events.jsonl'), '');
}

console.log(`installed guard ${GUARD} sha256 ${sha(GUARD)}`);
console.log(`repo guard      ${REPO_GUARD} sha256 ${sha(REPO_GUARD)}`);
console.log(`node ${process.version} ${process.platform}`);

// ---- A. tokenizer (the installed guard's own splitCommands)
const { splitCommands } = require(GUARD);
const NATIVE = 'C:\\Users\\me\\Temp\\notes.md';
const tok = {};
for (const [k, cmd] of [['unquoted', `echo x > ${NATIVE}`], ['quoted', `echo x > "${NATIVE}"`]]) {
  const words = splitCommands(cmd)[0].map((w) => w.text);
  tok[k] = words[words.indexOf('>') + 1];
  console.log(`A tokenizer ${k}: ${JSON.stringify(cmd)} -> words ${JSON.stringify(words)}`);
}
const winCwd = 'C:\\Users\\me\\AppData\\Local\\Temp\\eccode-proj';
for (const k of ['unquoted', 'quoted']) {
  const t = tok[k];
  const abs = path.win32.resolve(winCwd, t);
  console.log(`A win32 ${k}: target ${JSON.stringify(t)} isAbsolute=${path.win32.isAbsolute(t)} resolve(cwd)=${abs} relative(cwd)=${JSON.stringify(path.win32.relative(winCwd, abs))}`);
}

// ---- B. end-to-end on Linux, posix fixtures (control)
const P = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-posix-'));
const pProj = path.join(P, 'proj');
const pHome = path.join(P, 'home');
const pOuter = path.join(P, 'outer');
const pInner = path.join(pOuter, 'examples', 'app');
mkRecord(pProj);
mkRecord(pOuter);
mkRecord(pInner);
fs.mkdirSync(pHome, { recursive: true });
const pDraft = path.join(pInner, '.eccode', 'reviews', 'drafts', 'architecture-1.json');
record('B-posix', 'reviewer scratch redirect outside (posix path, unquoted)', bash(pProj, `echo x > ${path.join(pHome, 'notes.md')}`, 'technical-reviewer'), 'null', 'control');
record('B-posix', 'inner draft by redirect from the outer cwd (posix path, unquoted)', bash(pOuter, `echo x > ${pDraft}`, 'architecture-reviewer', { env: { CLAUDE_PROJECT_DIR: pOuter } }), 'null', 'control');
record('B-posix', 'reviewer redirect into a project file (posix)', bash(pProj, 'echo x > src/x.js', 'technical-reviewer'), 'deny', 'control');
// Informational: on posix a Windows path is not absolute in either spelling.
for (const [k, cmd] of [['unquoted', `echo x > ${NATIVE}`], ['quoted', `echo x > "${NATIVE}"`]]) {
  const out = bash(pProj, cmd, 'technical-reviewer');
  results.push({ section: 'B-posix', label: `native Windows path ${k} on posix (informational)`, kind: 'info', got: out ? out.permissionDecision : null, reason: out ? out.permissionDecisionReason : null });
}

// ---- C. end-to-end with win32 path semantics (installed guard bytes, win32-path-shim.js)
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-win-c-')); // stands for drive C:\
const W = (rel) => `C:\\${rel}`;
const L = (rel) => path.join(S, ...rel.split('\\'));
const wProj = 'Users\\me\\AppData\\Local\\Temp\\eccode-proj';
const wOuter = 'Users\\me\\AppData\\Local\\Temp\\eccode-outer';
const wInner = `${wOuter}\\examples\\app`;
mkRecord(L(wProj));
mkRecord(L(wOuter));
mkRecord(L(wInner));
fs.mkdirSync(L('Users\\me\\Temp'), { recursive: true });
const o = { win: true, sandbox: S };
const oNested = { win: true, sandbox: S, env: { CLAUDE_PROJECT_DIR: W(wOuter) } };
const scratch = W('Users\\me\\Temp\\notes.md');
const draft = W(`${wInner}\\.eccode\\reviews\\drafts\\architecture-1.json`);
// The two test lines as they were on ad69e6d (unquoted) and after d9c1cc6 (quoted).
record('C-win32', 'reviewer scratch redirect outside, UNQUOTED (ad69e6d line)', bash(W(wProj), `echo x > ${scratch}`, 'technical-reviewer', o), 'null', 'ad69e6d-test-line');
record('C-win32', 'inner draft by redirect from the outer cwd, UNQUOTED (ad69e6d line)', bash(W(wOuter), `echo x > ${draft}`, 'architecture-reviewer', oNested), 'null', 'ad69e6d-test-line');
record('C-win32', 'reviewer scratch redirect outside, QUOTED (d9c1cc6 line)', bash(W(wProj), `echo x > "${scratch}"`, 'technical-reviewer', o), 'null', 'control');
record('C-win32', 'inner draft by redirect from the outer cwd, QUOTED (d9c1cc6 line)', bash(W(wOuter), `echo x > "${draft}"`, 'architecture-reviewer', oNested), 'null', 'control');
// Controls that the emulation keeps the guard's other decisions intact.
record('C-win32', 'reviewer Write tool to scratch outside', write(W(wProj), scratch, 'technical-reviewer', o), 'null', 'control');
record('C-win32', 'reviewer Write tool to inner draft from outer cwd', write(W(wOuter), draft, 'architecture-reviewer', oNested), 'null', 'control');
record('C-win32', 'reviewer redirect into a project file, quoted', bash(W(wProj), `echo x > "${W(`${wProj}\\src\\x.js`)}"`, 'technical-reviewer', o), 'deny', 'control');
record('C-win32', 'main session redirect into the inner record, quoted', bash(W(wOuter), `echo x > "${W(`${wInner}\\.eccode\\state.json`)}"`, null, oNested), 'deny', 'control');
// Where the unquoted target actually lands on win32: inside the project, as a garbage file name.
const mangledScratch = splitCommands(`echo x > ${scratch}`)[0].map((w) => w.text)[3];
const mangledDraft = splitCommands(`echo x > ${draft}`)[0].map((w) => w.text)[3];
console.log(`C unquoted scratch target word ${JSON.stringify(mangledScratch)} -> win32 resolve ${path.win32.resolve(W(wProj), mangledScratch)}`);
console.log(`C unquoted nested target word ${JSON.stringify(mangledDraft)} -> win32 resolve ${path.win32.resolve(W(wOuter), mangledDraft)}`);

for (const r of results) console.log(`${r.section} | ${r.kind} | ${r.label} | expect ${r.expect || '-'} | got ${r.got} | ${r.ok === undefined ? 'info' : r.ok ? 'OK' : 'MISMATCH'}${r.reason ? ` | ${r.reason}` : ''}`);
const reasonsMatchCi = results.filter((r) => r.kind === 'ad69e6d-test-line' && r.got === 'deny').every((r) => DENY_RE.test(r.reason));
console.log(JSON.stringify({ symptomReproduced: symptom, controlFailures: controlFailed, denyReasonsMatchCi: reasonsMatchCi }));
fs.rmSync(P, { recursive: true, force: true });
fs.rmSync(S, { recursive: true, force: true });
process.exit(controlFailed ? 2 : symptom ? 1 : 0);
