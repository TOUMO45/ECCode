'use strict';
// Fourth-review probes for 9c4d5aa: the "creates a link and writes" rule (over-denials) and realize()'s
// manual hop through dangling links (correctness + loop safety + draft-area links). Same harness.
const WT = process.env.GUARD_WT || '/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { tmpProject, write, approveThroughPlan } = require(path.join(WT, 'tests', 'helpers'));
const gates = require(path.join(WT, 'lib', 'gates'));
const tasks = require(path.join(WT, 'lib', 'tasks'));
const GUARD = path.join(WT, 'scripts', 'hooks', 'guard.js');

function hook(payload, env = {}) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000, env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '', ...env } });
  if (res.error) return { permissionDecision: 'TIMEOUT/ERROR', permissionDecisionReason: String(res.error) };
  if (res.status !== 0 || res.stderr.trim()) return { permissionDecision: 'ERROR', permissionDecisionReason: res.stderr };
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}
const agentOf = (role) => (role ? { agent_type: `eccode:${role}` } : {});
const results = [];
let section = '';
function probe(id, { cwd, tool = 'Bash', role = null, command, file, expect, note }) {
  const input = tool === 'Bash' ? { command } : { file_path: file };
  const out = hook({ cwd, tool_name: tool, ...agentOf(role), tool_input: input });
  const decision = out ? out.permissionDecision : 'allow';
  results.push({ section, id, role: role || 'main', tool, input: tool === 'Bash' ? command : file, decision, expect, ok: expect === decision, note: note || '', reason: out ? out.permissionDecisionReason.slice(0, 130) : '' });
}
function commitAll(dir) { execFileSync('git', ['add', '-A'], { cwd: dir }); execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'f'], { cwd: dir }); }
const cleanup = [];

// ------------------------------------------------- A. link rule: over-denials and true positives
section = 'LINK-RULE';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  write(ctx.dir, 'src/server/a.js', 'x\n');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  commitAll(ctx.dir);
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  const D = ctx.dir;
  const impl = 'backend-engineer';
  const devops = 'devops-engineer';
  const bm = (id, command, expect, note) => probe(id, { cwd: D, command, role: null, expect, note });
  // plain link creation, one target → allowed
  bm('plain-ln', 'ln -s a b', 'allow', 'one target (b); no other write');
  bm('plain-ln-f', 'ln -sf node_modules/.bin/x bin/x', 'allow', 'postinstall symlink');
  bm('plain-ln-hard', 'ln a b', 'allow', 'hard link, one target');
  bm('plain-cp-l', 'cp -l a b', 'allow', 'cp hard link');
  bm('plain-cp-s', 'cp -s /abs/a b', 'allow', 'cp symlink');
  bm('plain-mklink', 'mklink b a', 'allow', 'windows mklink (one target)');
  bm('ln-then-read', 'ln -s a b && cat b', 'allow', 'read after link is not a second write');
  bm('ln-then-ls', 'ln -s a b; ls -l b', 'allow');
  bm('ln-then-grep', 'ln -s src/server/a.js link.js && grep foo link.js', 'allow');
  // link creation PLUS another write, all outside the record → OVER-DENIAL candidates
  bm('ln-and-redirect-stamp', 'ln -sf ../lib/cli.js bin/cli && echo built > .build-stamp', 'allow', 'OVER-DENIAL if deny: common build step, no record touched');
  bm('ln-and-touch', 'ln -s a b && touch c', 'allow', 'OVER-DENIAL if deny');
  bm('two-links', 'ln -s a b && ln -s c d', 'allow', 'OVER-DENIAL if deny: two symlinks, no record');
  bm('ln-and-rm-build', 'ln -s a b; rm -rf dist', 'allow', 'OVER-DENIAL if deny');
  bm('ln-and-cp-src', 'ln -sf ../x y && cp p q', 'allow', 'OVER-DENIAL if deny');
  bm('ln-and-tee-log', 'ln -s a b | tee setup.log', 'allow', 'OVER-DENIAL if deny');
  bm('postinstall-chain', 'mkdir -p bin && ln -sf ../lib/cli.js bin/cli && chmod +x bin/cli', 'allow', 'mkdir/chmod are not writers; one link target');
  bm('devops-ln-build', 'ln -sf dist/current releases/latest && echo $(date) > releases/latest.txt', 'allow', 'OVER-DENIAL if deny');
  probe('devops-ln-build-role', { cwd: D, command: 'ln -sf dist/current releases/latest && echo x > releases/stamp', role: devops, expect: 'allow', note: 'OVER-DENIAL if deny (devops)' });
  // the true positive the rule is for (record via same-line alias) → deny
  bm('tp-alias-state', 'ln -s "$PWD/.eccode" lk && echo x > lk/state.json', 'deny', 'H1: the rule fires');
  bm('tp-alias-memory', 'ln -s "$PWD/.eccode" lk && echo x > lk/memory/m.json', 'deny');
  bm('tp-cp-s-alias', 'cp -s "$PWD/.eccode" lk && echo x > lk/config.json', 'deny');
  bm('tp-alias-two-writes-nonrecord', 'ln -s "$PWD/.eccode" lk && echo a > b && echo c > lk/state.json', 'deny');
  // a link whose write target is itself the only write and lands outside the record → allowed even though a link is made
  bm('ln-single-nonrecord', 'ln -sf ../a.js b.js', 'allow');
}

// ------------------------------------------------- B. realize() manual hop
section = 'REALIZE-HOP';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  const D = ctx.dir;
  fs.mkdirSync(path.join(D, 'src'), { recursive: true });
  fs.mkdirSync(path.join(D, '.eccode', 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(D, '.eccode', 'reviews', 'drafts'), { recursive: true });
  const W = (id, file, role, expect, note) => probe(id, { cwd: D, tool: 'Write', file, role, expect, note });
  const b = (id, command, role, expect, note) => probe(id, { cwd: D, command, role, expect, note });
  // dangling link to a dangling link into the record
  fs.symlinkSync(path.join(D, '.eccode', 'newrec.json'), path.join(D, 'l2'));       // l2 -> .eccode/newrec.json (absent)
  fs.symlinkSync(path.join(D, 'l2'), path.join(D, 'l1'));                            // l1 -> l2 (chain, both unresolved)
  W('dangling-chain-record', path.join(D, 'l1'), null, 'deny', 'l1->l2->.eccode/newrec.json');
  b('dangling-chain-record-bash', 'echo x > l1', null, 'deny');
  // a link whose target is relative with .. INTO the record (correct spelling this time)
  fs.symlinkSync('../.eccode', path.join(D, 'src', 'rel'));                          // /proj/src/rel -> /proj/.eccode
  W('rel-dotdot-into-record', path.join(D, 'src', 'rel', 'state.json'), null, 'deny');
  b('rel-dotdot-into-record-bash', 'echo x > src/rel/state.json', null, 'deny');
  W('rel-dotdot-memory', path.join(D, 'src', 'rel', 'memory', 'm.json'), 'backend-engineer', 'deny');
  // link to a directory that does not exist, with a tail
  fs.symlinkSync(path.join(D, '.eccode', 'subdir'), path.join(D, 'dl'));             // dl -> .eccode/subdir (absent dir)
  W('link-missing-dir-tail', path.join(D, 'dl', 'x.json'), null, 'deny', 'dl/x.json -> .eccode/subdir/x.json');
  b('link-missing-dir-tail-bash', 'echo x > dl/x.json', null, 'deny');
  // dangling link into a DRAFT area (deep missing tail) → allowed for a reviewer
  fs.symlinkSync(path.join(D, '.eccode', 'reviews', 'drafts', 'sub', 'deep.json'), path.join(D, 'dd'));
  W('dangling-into-draft-deep', path.join(D, 'dd'), 'technical-reviewer', 'allow', 'dd -> .eccode/reviews/drafts/sub/deep.json');
  b('dangling-into-draft-deep-bash', 'echo x > dd', 'technical-reviewer', 'allow');
  // link cycle a->b->a with a tail: must not hang or crash, must return a decision
  fs.symlinkSync(path.join(D, 'cycB'), path.join(D, 'cycA'));
  fs.symlinkSync(path.join(D, 'cycA'), path.join(D, 'cycB'));
  W('cycle-write', path.join(D, 'cycA', 'x.json'), null, 'allow', 'cycle resolves to no record; must not hang (64-hop cap)');
  b('cycle-write-bash', 'echo x > cycA/x.json', null, 'allow');
  // self link
  fs.symlinkSync(path.join(D, 'selfl'), path.join(D, 'selfl2'));
  W('self-chain', path.join(D, 'selfl2'), null, 'allow', 'dangling self-ish chain, no record');
  // a link into the record used only as a READ source → no over-denial
  fs.symlinkSync(path.join(D, '.eccode', 'state.json'), path.join(D, 'rs'));
  b('read-through-link', 'cat rs', null, 'allow', 'cat is not a writer');
  b('cp-from-record-link', 'cp rs /tmp/out.json', null, 'allow', 'record (via link) as a source; target is /tmp');
  // an existing link to the record dir, write through (resolvable, the normal real-path path)
  fs.symlinkSync(path.join(D, '.eccode'), path.join(D, 'recdir'));
  W('existing-link-record', path.join(D, 'recdir', 'config.json'), null, 'deny');
  b('existing-link-record-bash', 'echo x > recdir/events.jsonl', null, 'deny');
  W('existing-link-record-draft', path.join(D, 'recdir', 'drafts', 'n.md'), 'backend-engineer', 'allow', 'recdir/drafts resolves to a draft area');
}

const failures = results.filter((r) => !r.ok);
const lines = [`# Link-rule and realize-hop probes against ${GUARD}`, `# node ${process.version}; ${results.length} probes; ${failures.length} mismatches`, '', 'section | id | role | tool | decision | expect | ok | note | reason'];
for (const r of results) lines.push([r.section, r.id, r.role, r.tool, r.decision, r.expect, r.ok ? 'ok' : 'MISMATCH', r.note, r.reason.replace(/\s+/g, ' ')].join(' | '));
lines.push('', '## Inputs');
for (const r of results) lines.push(`${r.section}/${r.id}: ${JSON.stringify(r.input)}`);
fs.writeFileSync(path.join(__dirname, 'results5.txt'), lines.join('\n') + '\n');
process.stdout.write(lines.slice(0, 4 + results.length).join('\n') + '\n');
for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
