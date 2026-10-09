'use strict';
// Final-confirmation probes for beb7fbb: attack the I1 narrowing of the link-and-write rule.
// The rule now fires only when the line names a record (assignment values counted) OR a link operand
// is computed. Try to reach the record while keeping every word literal and record-free.
const WT = process.env.GUARD_WT || '/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { tmpProject, write, approveThroughPlan } = require(path.join(WT, 'tests', 'helpers'));
const gates = require(path.join(WT, 'lib', 'gates'));
const tasks = require(path.join(WT, 'lib', 'tasks'));
const GUARD = path.join(WT, 'scripts', 'hooks', 'guard.js');
function hook(payload) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000, env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '' } });
  if (res.error) return { permissionDecision: 'TIMEOUT', permissionDecisionReason: String(res.error) };
  if (res.status !== 0 || res.stderr.trim()) return { permissionDecision: 'ERROR', permissionDecisionReason: res.stderr };
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}
const agentOf = (role) => (role ? { agent_type: `eccode:${role}` } : {});
const results = [];
let section = '';
function probe(id, { cwd, tool = 'Bash', role = null, command, file, expect, note }) {
  const out = hook({ cwd, tool_name: tool, ...agentOf(role), tool_input: tool === 'Bash' ? { command } : { file_path: file } });
  const decision = out ? out.permissionDecision : 'allow';
  results.push({ section, id, role: role || 'main', tool, input: tool === 'Bash' ? command : file, decision, expect, ok: expect === decision, note: note || '', reason: out ? out.permissionDecisionReason.slice(0, 120) : '' });
}
function commitAll(dir) { execFileSync('git', ['add', '-A'], { cwd: dir }); execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'f'], { cwd: dir }); }
const cleanup = [];

section = 'DEFEAT-NARROWING';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  const D = ctx.dir;
  const bm = (id, command, expect, note) => probe(id, { cwd: D, command, role: null, expect, note });
  // vectors the narrowing SHOULD still catch
  bm('assign-value-record', 'D=.eccode; ln -s $D lk && echo x > lk/state.json', 'deny', 'assignment value names the record');
  bm('computed-operand-split', 'D=$PWD; ln -s $D/.ecc"ode" lk && echo x > lk/state.json', 'deny', 'computed link operand');
  bm('cmdsubst-operand', 'ln -s "$(echo .eccode)" lk && echo x > lk/state.json', 'deny', 'command substitution operand (dynamic)');
  bm('cmdsubst-pwd', 'ln -s "$(pwd)/.eccode" lk && echo x > lk/state.json', 'deny');
  bm('eval-link', 'eval \'ln -s "$PWD/.eccode" lk\'; echo x > lk/state.json', 'deny', 'link built inside eval');
  bm('array-link', 'a=(ln -s "$PWD/.eccode" lk); "${a[@]}"; echo x > lk/state.json', 'deny', 'link verb/operands in an array');
  bm('assign-pwd-var', 'D=$PWD; E=.eccode; ln -s $D/$E lk && echo x > lk/state.json', 'deny');
  bm('backtick-operand', 'ln -s `pwd`/.eccode lk && echo x > lk/state.json', 'deny', 'backtick is dynamic');
  bm('param-default', 'ln -s "${X:-$PWD/.eccode}" lk && echo x > lk/state.json', 'deny', 'dynamic default');
  bm('literal-record-operand', 'ln -s .eccode lk && echo x > lk/state.json', 'deny', 'bare literal .eccode operand');
  bm('literal-record-abs', `ln -s ${D}/.eccode lk && echo x > lk/state.json`, 'deny', 'literal absolute .eccode operand');
  // the HOLE candidate: a pre-existing innocuous symlink to the record, aliased again this line with
  // literal non-record operands (no word names .eccode; no operand is dynamic).
  fs.symlinkSync(path.join(D, '.eccode'), path.join(D, 'a'));   // a -> .eccode, created in a PRIOR turn
  bm('chained-alias-literal', 'ln -s a b && echo x > b/state.json', 'deny', 'HOLE if allow: b->a->.eccode; operands a,b literal and record-free');
  bm('chained-alias-cp-s', 'cp -s a b && echo x > b/config.json', 'deny', 'HOLE if allow');
  bm('chained-alias-memory', 'ln -s a b && echo x > b/memory/m.json', 'deny', 'HOLE if allow');
  bm('chained-write-direct', 'echo x > a/state.json', 'deny', 'control: direct write through the existing link is caught by realize');
  // a two-hop entirely in prior turns, then plain write this line
  fs.symlinkSync(path.join(D, 'a'), path.join(D, 'c'));         // c -> a -> .eccode, both pre-existing
  bm('twohop-preexisting-write', 'echo x > c/state.json', 'deny', 'control: resolvable two-hop, caught');
  // record-free build/release lines must STILL pass (I1 regression guard), main session
  bm('ok-stamp', 'ln -sf ../lib/cli.js bin/cli && echo built > .build-stamp', 'allow');
  bm('ok-touch', 'ln -s p q && touch r', 'allow');
  bm('ok-two-links', 'ln -s p q && ln -s s t', 'allow');
  bm('ok-rm-build', 'ln -s p q; rm -rf dist', 'allow');
  bm('ok-release', 'ln -sf dist/current releases/latest && echo ok > releases/latest.txt', 'allow');
  bm('ok-cp-l', 'cp -l a2 b2 && echo x > c2', 'allow', 'hard link + unrelated write');
  bm('ok-computed-nonrecord', 'D=$PWD; ln -s $D/src/x y && echo x > z', 'allow', 'computed operand but NOT a record -> should pass? (computed fires regardless)');
}

const failures = results.filter((r) => !r.ok);
const lines = [`# Defeat-the-narrowing probes against ${GUARD}`, `# node ${process.version}; ${results.length} probes; ${failures.length} mismatches`, '', 'section | id | role | tool | decision | expect | ok | note | reason'];
for (const r of results) lines.push([r.section, r.id, r.role, r.tool, r.decision, r.expect, r.ok ? 'ok' : 'MISMATCH', r.note, r.reason.replace(/\s+/g, ' ')].join(' | '));
lines.push('', '## Inputs');
for (const r of results) lines.push(`${r.section}/${r.id}: ${JSON.stringify(r.input)}`);
fs.writeFileSync(path.join(__dirname, 'results6.txt'), lines.join('\n') + '\n');
process.stdout.write(lines.slice(0, 4 + results.length).join('\n') + '\n');
for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
