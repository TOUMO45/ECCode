'use strict';
// Re-review follow-ups: the main-session symlink-alias chain against d0e2a3b (and the parent a088c6a for
// classification), a symlinked record inside a claim in a clean project, init through a symlink into the
// record, and the trailing-slash false positive on review drafts.
const WT = process.env.GUARD_WT || '/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix';
const LIBWT = '/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { tmpProject, write, approveThroughPlan } = require(path.join(LIBWT, 'tests', 'helpers'));
const { init } = require(path.join(LIBWT, 'lib', 'project'));
const gates = require(path.join(LIBWT, 'lib', 'gates'));
const tasks = require(path.join(LIBWT, 'lib', 'tasks'));
const GUARD = path.join(WT, 'scripts', 'hooks', 'guard.js');

function hook(payload, env = {}) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '', ...env } });
  if (res.status !== 0 || res.stderr.trim()) return { permissionDecision: 'ERROR', permissionDecisionReason: res.stderr };
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}
const agentOf = (role) => (role ? { agent_type: `eccode:${role}` } : {});
const results = [];
function probe(id, { cwd, tool = 'Bash', role = null, command, file, expect, note }) {
  const input = tool === 'Bash' ? { command } : { file_path: file };
  const out = hook({ cwd, tool_name: tool, ...agentOf(role), tool_input: input });
  const decision = out ? out.permissionDecision : 'allow';
  results.push({ id, role: role || 'main', tool, input: tool === 'Bash' ? command : file, decision, expect, ok: expect === decision, note: note || '', reason: out ? out.permissionDecisionReason.slice(0, 140) : '' });
}
function plant(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === '.eccode' || name === '.lock') continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) plant(s, d); else fs.copyFileSync(s, d);
  }
}
function commitAll(dir) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'files'], { cwd: dir });
}
const cleanup = [];

// A. main-session alias chain
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  const rec = (f) => path.join(ctx.dir, '.eccode', f);
  const W = (id, file, role, expect, note) => probe(id, { cwd: ctx.dir, tool: 'Write', file, role, expect, note });
  const b = (id, command, role, expect, note) => probe(id, { cwd: ctx.dir, command, role, expect, note });
  fs.symlinkSync(rec(''), path.join(ctx.dir, 'rec'));
  W('alias-no-plant', path.join(ctx.dir, 'rec', 'state.json'), null, 'deny', 'without a planted record the realpath check holds');
  b('plant-step-pwd', 'cp -r ./.eccode/. "$PWD/.eccode/.eccode"', null, 'deny', 'guard-visible planting of a record inside the record');
  b('plant-step-rel', 'mkdir -p .eccode/.eccode && cp -r ./.eccode/. .eccode/.eccode/', null, 'deny');
  b('plant-step-rsync', 'rsync -a ./.eccode/ ./.eccode/.eccode/', null, 'deny');
  b('alias-step', 'ln -s "$PWD/.eccode" rec', null, 'deny', 'guard-visible alias of the record');
  plant(rec(''), rec('.eccode'));
  W('alias-state-after-plant', path.join(ctx.dir, 'rec', 'state.json'), null, 'deny', 'CHAIN: planted root under the alias is not lexically inside a record');
  probe('alias-events-after-plant', { cwd: ctx.dir, tool: 'Edit', file: path.join(ctx.dir, 'rec', 'events.jsonl'), role: null, expect: 'deny' });
  W('alias-review-after-plant', path.join(ctx.dir, 'rec', 'reviews', 'architecture-1.json'), null, 'deny');
  W('alias-config-after-plant', path.join(ctx.dir, 'rec', 'config.json'), null, 'deny');
  b('alias-bash-after-plant', 'echo x > rec/state.json', null, 'deny');
  W('alias-state-reviewer', path.join(ctx.dir, 'rec', 'state.json'), 'technical-reviewer', 'deny');
  W('direct-state-after-plant', rec('state.json'), null, 'deny', 'the lexical path is still denied');
}

// B. a symlinked record inside a claim, clean project
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  write(ctx.dir, 'src/server/a.js', 'x\n');
  write(ctx.dir, 'src/web/a.js', 'x\n');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  commitAll(ctx.dir);
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  const impl = 'backend-engineer';
  const b = (id, command, role, expect, note) => probe(id, { cwd: ctx.dir, command, role, expect, note });
  b('ln-record-into-claim-abs', `ln -s ${ctx.dir}/.eccode src/server/.eccode`, impl, 'allow', 'target owned; source is a prefixed path (RECORD_DIR_WRITE misses it); harmless alone');
  b('ln-record-into-claim-rel', 'ln -s ../../.eccode src/server/.eccode', impl, 'allow');
  fs.symlinkSync(path.join(ctx.dir, '.eccode'), path.join(ctx.dir, 'src', 'server', '.eccode'));
  probe('symlinked-root-lockout', { cwd: ctx.dir, tool: 'Write', file: path.join(ctx.dir, 'src', 'server', 'b.js'), role: impl, expect: 'deny', note: 'root becomes src/server through the link; real claims do not match b.js' });
  probe('symlinked-root-record', { cwd: ctx.dir, tool: 'Write', file: path.join(ctx.dir, 'src', 'server', '.eccode', 'state.json'), role: impl, expect: 'deny' });
  probe('symlinked-root-outside', { cwd: ctx.dir, tool: 'Write', file: path.join(ctx.dir, 'src', 'web', 'a.js'), role: impl, expect: 'deny' });
}

// C. init through a symlink into the record (existing target), and the drafts trailing slash
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  fs.mkdirSync(path.join(ctx.dir, '.eccode', 'drafts'), { recursive: true });
  fs.symlinkSync(path.join(ctx.dir, '.eccode', 'drafts'), path.join(ctx.dir, 'work'));
  let r;
  try { init(path.join(ctx.dir, 'work'), { name: 'a', idea: 'b' }); r = `OK: created ${fs.existsSync(path.join(ctx.dir, '.eccode', 'drafts', '.eccode', 'events.jsonl'))}`; } catch (err) { r = `${err.code}: ${err.message}`; }
  results.push({ id: 'init-via-symlink-into-record', role: 'engine', tool: 'engine', input: 'init(work -> .eccode/drafts)', decision: r.slice(0, 160), expect: 'INVALID_INPUT', ok: /^INVALID_INPUT/.test(r), note: 'lexical check on the given path', reason: '' });
  const rev = 'technical-reviewer';
  const b = (id, command, role, expect, note) => probe(id, { cwd: ctx.dir, command, role, expect, note });
  b('mv-review-drafts-slash', 'mv x.json .eccode/reviews/drafts/', rev, 'allow', 'trailing slash: resolve() strips it and reviews/ then matches the record area');
  b('mv-review-drafts-named', 'mv x.json .eccode/reviews/drafts/x.json', rev, 'allow');
  b('cp-review-drafts-slash', 'cp x.json .eccode/reviews/drafts/', rev, 'allow');
  b('mv-drafts-slash', 'mv x.md .eccode/drafts/', rev, 'allow');
  probe('write-review-drafts-dir', { cwd: ctx.dir, tool: 'Write', file: '.eccode/reviews/drafts/', role: rev, expect: 'allow', note: 'degenerate but same normalisation' });
}

const failures = results.filter((r) => !r.ok);
const lines = [`# Follow-up probes against ${GUARD}`, `# ${results.length} probes; ${failures.length} mismatches`, '', 'id | role | tool | decision | expect | ok | note | reason'];
for (const r of results) lines.push([r.id, r.role, r.tool, r.decision, r.expect, r.ok ? 'ok' : 'MISMATCH', r.note, r.reason.replace(/\s+/g, ' ')].join(' | '));
lines.push('', '## Inputs');
for (const r of results) lines.push(`${r.id}: ${JSON.stringify(r.input)}`);
const outName = process.env.GUARD_WT ? 'results3-oldguard.txt' : 'results3.txt';
fs.writeFileSync(path.join(__dirname, outName), lines.join('\n') + '\n');
process.stdout.write(lines.slice(0, 4 + results.length).join('\n') + '\n');
for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
