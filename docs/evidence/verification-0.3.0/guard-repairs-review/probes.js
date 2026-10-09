'use strict';
// Adversarial probes of commit ffbdc8d (scripts/hooks/guard.js) run against the worktree checkout.
// Each probe feeds PreToolUse JSON to the guard exactly as tests/guard-verification-repairs.test.js
// does; nothing is executed by the guard. `expect` is the reviewer's judgement of the correct answer;
// a mismatch is a finding (or, when marked `note`, a classified residual). Throwaway projects are
// created under os.tmpdir() by tests/helpers.js and removed at the end.
const WT = process.env.GUARD_WT || '/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpProject, write, initRepo, approveThroughPlan, samplePlan, task } = require(path.join(WT, 'tests', 'helpers'));
const { init } = require(path.join(WT, 'lib', 'project'));
const { loadConfig } = require(path.join(WT, 'lib', 'config'));
const gates = require(path.join(WT, 'lib', 'gates'));
const tasks = require(path.join(WT, 'lib', 'tasks'));
const GUARD = path.join(WT, 'scripts', 'hooks', 'guard.js');

function hook(payload, env = {}) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '', ...env },
  });
  if (res.status !== 0 || res.stderr.trim()) return { permissionDecision: 'ERROR', permissionDecisionReason: res.stderr };
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}
const agentOf = (role) => (role ? { agent_type: `eccode:${role}` } : {});
const results = [];
let section = '';
function probe(id, { cwd, tool = 'Bash', role = null, command, file, env = {}, expect, note }) {
  const input = tool === 'Bash' ? { command } : { file_path: file };
  const out = hook({ cwd, tool_name: tool, ...agentOf(role), tool_input: input }, env);
  const decision = out ? out.permissionDecision : 'allow';
  const ok = expect === decision;
  const row = { section, id, role: role || 'main', tool, input: tool === 'Bash' ? command : file, decision, expect, ok, note: note || '', reason: out ? out.permissionDecisionReason.slice(0, 140) : '' };
  results.push(row);
  return row;
}

const cleanup = [];
const { execFileSync } = require('child_process');
function commitAll(dir) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'files'], { cwd: dir });
}
function nestedPair() {
  const outer = tmpProject();
  cleanup.push(outer.dir);
  write(outer.dir, 'src/server.js', '// outer\n');
  write(outer.dir, 'src/web/a.js', '// outer web\n');
  const inner = path.join(outer.dir, 'examples', 'app');
  fs.mkdirSync(inner, { recursive: true });
  initRepo(inner);
  const store = init(inner, { name: 'App', idea: 'nested app' });
  write(inner, 'src/x.js', '// inner\n');
  const innerCtx = { dir: inner, store, config: loadConfig(inner) };
  return { outer, inner, innerCtx };
}

// ------------------------------------------------------------------ 1. NEW-6 clobber redirect
section = 'NEW-6';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  write(ctx.dir, 'src/server.js', 'x\n');
  const rev = 'technical-reviewer';
  const b = (id, command, role, expect, note) => probe(id, { cwd: ctx.dir, command, role, expect, note });
  b('clobber', 'echo x >| src/server.js', rev, 'deny');
  b('clobber-nospace', 'echo x >|src/server.js', rev, 'deny');
  b('clobber-fd1', 'echo x 1>| src/server.js', rev, 'deny');
  b('clobber-fd2', 'echo x 2>| src/server.js', rev, 'deny');
  b('clobber-append', 'echo x >>| src/server.js', rev, 'deny', 'bash syntax error; over-deny harmless');
  b('clobber-both', 'echo x &>| src/server.js', rev, 'deny', 'bash syntax error; over-deny harmless');
  b('clobber-quoted-target', "echo x >| 'src/server.js'", rev, 'deny');
  b('clobber-dquoted-target', 'echo x >| "src/server.js"', rev, 'deny');
  b('clobber-tab', 'echo x >|\tsrc/server.js', rev, 'deny');
  b('clobber-sh-c', "sh -c 'echo x >| src/server.js'", rev, 'deny');
  b('clobber-bash-c-dq', 'bash -c "echo x >| src/server.js"', rev, 'deny');
  b('clobber-then-pipe', 'echo x >| src/server.js | cat', rev, 'deny');
  b('clobber-after-pipe', 'cat a | tee >| src/server.js', rev, 'deny');
  b('tee', 'echo x | tee src/server.js', rev, 'deny');
  b('clobber-impl-noclaim', 'echo x >| src/server.js', 'backend-engineer', 'deny');
  b('clobber-record', 'echo x >| .eccode/state.json', 'backend-engineer', 'deny');
  b('clobber-record-main', 'echo x >| .eccode/events.jsonl', null, 'deny');
  b('clobber-draft-reviewer', 'echo x >| .eccode/reviews/drafts/r.json', rev, 'allow');
  b('clobber-draft-generic', 'echo x >| .eccode/drafts/n.md', 'backend-engineer', 'allow');
  b('pipe-plain', 'cat src/server.js | grep x', rev, 'allow');
  b('pipe-nospace', 'cat src/server.js |grep x', rev, 'allow');
  b('or-list', 'test -f src/server.js || echo missing', rev, 'allow');
  b('pipe-stderr', 'cat src/server.js |& grep x', rev, 'allow');
  b('dup-then-pipe', 'node t.js 2>&1 | tail -5', rev, 'allow');
  b('stderr-dup-pipe', 'echo x >&2 | cat', rev, 'allow');
  b('devnull-pipe', 'echo x > /dev/null | cat', rev, 'allow');
  // A quoted or escaped bar is a file literally named "|" in the cwd; the guard reads it as the
  // clobber operator and judges the next word instead.
  b('quoted-bar-reviewer', 'echo x >"|" src/server.js', rev, 'deny', 'over-deny: bash writes ./| and src/server.js is only an argument');
  b('escaped-bar-reviewer', 'echo x >\\| src/server.js', rev, 'deny', 'over-deny, same');
}
{
  // The quoted-bar misread from an implementer: the guard judges the claimed file, bash writes ./|
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  write(ctx.dir, 'src/server/a.js', 'x\n');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  commitAll(ctx.dir);
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  probe('quoted-bar-impl', { cwd: ctx.dir, command: 'echo x >"|" src/server/a.js', role: 'backend-engineer', expect: 'deny', note: 'bash writes <cwd>/| (outside src/server/**); guard binds the next word' });
  probe('impl-inside-claim', { cwd: ctx.dir, command: 'echo x >| src/server/a.js', role: 'backend-engineer', expect: 'allow' });
  probe('impl-outside-claim', { cwd: ctx.dir, command: 'echo x >| src/web/a.js', role: 'backend-engineer', expect: 'deny' });
}

// ------------------------------------------------------------------ 2. nested root
section = 'NESTED';
{
  const { outer, inner, innerCtx } = nestedPair();
  const env = { CLAUDE_PROJECT_DIR: outer.dir };
  const draft = path.join(inner, '.eccode', 'reviews', 'drafts', 'architecture-1.json');
  const art = path.join(inner, '.eccode', 'artifacts', 'brief.md');
  for (const [label, cwd] of [['outer-cwd', outer.dir], ['inner-cwd', inner]]) {
    probe(`draft-write-${label}`, { cwd, tool: 'Write', file: draft, role: 'technical-reviewer', env, expect: 'allow' });
    probe(`draft-edit-${label}`, { cwd, tool: 'Edit', file: draft, role: 'architecture-reviewer', env, expect: 'allow' });
    probe(`artifact-write-${label}`, { cwd, tool: 'Write', file: art, role: 'product-architect', env, expect: 'allow' });
    probe(`artifact-write-reviewer-${label}`, { cwd, tool: 'Write', file: art, role: 'technical-reviewer', env, expect: 'deny' });
    const rel = path.relative(cwd, draft);
    probe(`draft-redirect-${label}`, { cwd, command: `echo x > ${rel}`, role: 'technical-reviewer', env, expect: 'allow' });
    probe(`draft-clobber-${label}`, { cwd, command: `echo x >| ${rel}`, role: 'technical-reviewer', env, expect: 'allow' });
    probe(`draft-cp-${label}`, { cwd, command: `cp /tmp/r.json ${rel}`, role: 'technical-reviewer', env, expect: 'allow' });
    probe(`draft-tee-${label}`, { cwd, command: `echo x | tee ${rel}`, role: 'technical-reviewer', env, expect: 'allow' });
    probe(`artifact-redirect-${label}`, { cwd, command: `echo x > ${path.relative(cwd, art)}`, role: 'technical-designer', env, expect: 'allow' });
    // inner record files: every role and the main session
    for (const role of [null, 'technical-reviewer', 'backend-engineer', 'product-architect']) {
      for (const f of ['state.json', 'events.jsonl', 'config.json', 'reviews/architecture-1.json', 'memory/m.json', 'evidence/e.log']) {
        const abs = path.join(inner, '.eccode', f);
        probe(`inner-record-write-${label}-${role || 'main'}-${f}`, { cwd, tool: 'Write', file: abs, role, env, expect: 'deny' });
        probe(`inner-record-redirect-${label}-${role || 'main'}-${f}`, { cwd, command: `echo x > ${path.relative(cwd, abs)}`, role, env, expect: 'deny' });
      }
      probe(`inner-record-cp-${label}-${role || 'main'}`, { cwd, command: `cp a ${path.relative(cwd, path.join(inner, '.eccode', 'state.json'))}`, role, env, expect: 'deny' });
      probe(`inner-record-abs-${label}-${role || 'main'}`, { cwd, command: `echo x > ${path.join(inner, '.eccode', 'state.json')}`, role, env, expect: 'deny' });
    }
    probe(`inner-git-checkout-record-${label}`, { cwd, command: `git checkout -- ${path.relative(cwd, path.join(inner, '.eccode'))}`, role: null, env, expect: 'deny' });
  }
  // inner source without an inner claim
  probe('inner-src-noclaim-write', { cwd: inner, tool: 'Write', file: path.join(inner, 'src', 'x.js'), role: 'backend-engineer', env, expect: 'deny' });
  probe('inner-src-noclaim-redirect', { cwd: inner, command: 'echo x > src/x.js', role: 'backend-engineer', env, expect: 'deny' });
  probe('inner-src-noclaim-from-outer', { cwd: outer.dir, command: 'echo x > examples/app/src/x.js', role: 'backend-engineer', env, expect: 'deny' });
  probe('inner-src-reviewer', { cwd: inner, tool: 'Write', file: path.join(inner, 'src', 'x.js'), role: 'technical-reviewer', env, expect: 'deny' });
  probe('inner-src-main', { cwd: inner, tool: 'Write', file: path.join(inner, 'src', 'x.js'), role: null, env, expect: 'allow' });
  // Now give the inner project a claim through the engine: plan with a task owning src/**.
  const plan = { phases: samplePlan().phases, tasks: [task('core', 'backend-engineer', ['src/**'])] };
  approveThroughPlan(innerCtx, plan);
  gates.startGate(innerCtx.store, innerCtx.config, 'phase:core', 'orchestrator');
  commitAll(inner);
  tasks.claim(innerCtx.store, innerCtx.config, 'core', 'backend-engineer');
  probe('inner-src-claim-write-inner-cwd', { cwd: inner, tool: 'Write', file: path.join(inner, 'src', 'x.js'), role: 'backend-engineer', env, expect: 'allow' });
  probe('inner-src-claim-write-rel', { cwd: inner, tool: 'Write', file: 'src/x.js', role: 'backend-engineer', env, expect: 'allow' });
  probe('inner-src-claim-redirect-inner-cwd', { cwd: inner, command: 'echo x > src/x.js', role: 'backend-engineer', env, expect: 'allow' });
  probe('inner-src-claim-clobber', { cwd: inner, command: 'echo x >| src/new.js', role: 'backend-engineer', env, expect: 'allow' });
  probe('inner-src-claim-cp', { cwd: inner, command: 'cp /tmp/a src/y.js', role: 'backend-engineer', env, expect: 'allow' });
  probe('inner-src-claim-tee', { cwd: inner, command: 'echo x | tee src/y.js', role: 'backend-engineer', env, expect: 'allow' });
  probe('inner-src-claim-sed', { cwd: inner, command: 'sed -i s/a/b/ src/x.js', role: 'backend-engineer', env, expect: 'allow' });
  probe('inner-src-claim-from-outer-cwd', { cwd: outer.dir, command: 'echo x > examples/app/src/x.js', role: 'backend-engineer', env, expect: 'allow' });
  probe('inner-src-claim-write-from-outer-cwd', { cwd: outer.dir, tool: 'Write', file: path.join(inner, 'src', 'x.js'), role: 'backend-engineer', env, expect: 'allow' });
  // outer source from the inner cwd: judged by the outer record (no outer claim -> deny)
  probe('outer-src-from-inner-climb', { cwd: inner, command: 'echo x > ../../src/server.js', role: 'backend-engineer', env, expect: 'deny' });
  probe('outer-src-from-inner-climb-write', { cwd: inner, tool: 'Write', file: '../../src/server.js', role: 'backend-engineer', env, expect: 'deny' });
  probe('outer-src-from-inner-abs', { cwd: inner, command: `echo x > ${path.join(outer.dir, 'src', 'server.js')}`, role: 'backend-engineer', env, expect: 'deny' });
  probe('outer-src-from-inner-dotdot-inside', { cwd: inner, command: 'echo x > src/../../../src/server.js', role: 'backend-engineer', env, expect: 'deny' });
  probe('outer-record-from-inner-climb', { cwd: inner, tool: 'Write', file: '../../.eccode/state.json', role: 'backend-engineer', env, expect: 'deny' });
  probe('outer-record-from-inner-climb-bash', { cwd: inner, command: 'echo x > ../../.eccode/state.json', role: 'backend-engineer', env, expect: 'deny' });
  probe('outer-draft-from-inner-climb', { cwd: inner, tool: 'Write', file: '../../.eccode/reviews/drafts/r.json', role: 'technical-reviewer', env, expect: 'allow' });
  // a directory with no record of its own above it except the outer: judged by the outer
  probe('outer-docs-from-inner', { cwd: inner, command: 'echo x > ../../docs/notes.md', role: 'backend-engineer', env, expect: 'deny' });
  probe('outer-other-example', { cwd: inner, tool: 'Write', file: path.join(outer.dir, 'examples', 'other', 'src', 'y.js'), role: 'backend-engineer', env, expect: 'deny' });
  // symlinks from inner into the outer record / outer tree
  fs.symlinkSync(path.join(outer.dir, '.eccode', 'state.json'), path.join(inner, 'src', 'link-state.json'));
  fs.symlinkSync(path.join(outer.dir, '.eccode'), path.join(inner, 'src', 'rec'));
  fs.symlinkSync(path.join(outer.dir, 'src'), path.join(inner, 'src', 'osrc'));
  probe('symlink-file-into-outer-record', { cwd: inner, tool: 'Write', file: path.join(inner, 'src', 'link-state.json'), role: 'backend-engineer', env, expect: 'deny' });
  probe('symlink-file-into-outer-record-bash', { cwd: inner, command: 'echo x > src/link-state.json', role: 'backend-engineer', env, expect: 'deny' });
  probe('symlink-dir-into-outer-record', { cwd: inner, tool: 'Write', file: path.join(inner, 'src', 'rec', 'state.json'), role: 'backend-engineer', env, expect: 'deny' });
  probe('symlink-dir-into-outer-record-bash', { cwd: inner, command: 'echo x > src/rec/state.json', role: 'backend-engineer', env, expect: 'deny' });
  probe('symlink-dir-into-outer-src', { cwd: inner, tool: 'Write', file: path.join(inner, 'src', 'osrc', 'server.js'), role: 'backend-engineer', env, expect: 'deny' });
  probe('symlink-dir-into-outer-src-bash', { cwd: inner, command: 'echo x > src/osrc/server.js', role: 'backend-engineer', env, expect: 'deny' });
  // the main session in the inner cwd
  probe('main-inner-record', { cwd: inner, tool: 'Write', file: path.join(inner, '.eccode', 'state.json'), role: null, env, expect: 'deny' });
  probe('main-outer-record-from-inner', { cwd: inner, tool: 'Write', file: path.join(outer.dir, '.eccode', 'state.json'), role: null, env, expect: 'deny' });
  // identity in the inner cwd: unchanged rules
  probe('inner-actor-user', { cwd: inner, command: 'eccode gate reopen design --actor user --resolution ok', role: null, env, expect: 'deny' });
  probe('inner-role-mismatch', { cwd: inner, command: 'eccode task claim core --actor backend-engineer', role: 'technical-reviewer', env, expect: 'deny' });
  probe('inner-role-ok', { cwd: inner, command: 'eccode task claim core --actor backend-engineer', role: 'backend-engineer', env, expect: 'allow' });
  // same-project symlinked directory inside a claim (pre-existing behaviour, for the record)
  fs.symlinkSync(path.join(inner, 'lib'), path.join(inner, 'src', 'tolib'));
  fs.mkdirSync(path.join(inner, 'lib'), { recursive: true });
  probe('symlink-dir-same-project', { cwd: inner, tool: 'Write', file: path.join(inner, 'src', 'tolib', 'z.js'), role: 'backend-engineer', env, expect: 'deny', note: 'pre-existing: a symlinked directory inside the claim resolves to lib/ (not ..), so the lexical path is judged' });
}

// ------------------------------------------------------------------ 2b. bogus nearest root
section = 'BOGUS-ROOT';
{
  // (a) implementer with a directory claim: can a bogus record be created through guard-visible channels?
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
  b('bogus-touch', 'mkdir -p src/server/.eccode && touch src/server/.eccode/events.jsonl', impl, 'deny');
  b('bogus-redirect', 'mkdir -p src/server/.eccode; echo x > src/server/.eccode/events.jsonl', impl, 'deny');
  b('bogus-cp-file', 'cp .eccode/events.jsonl src/server/.eccode/events.jsonl', impl, 'deny');
  b('bogus-cp-dir', 'cp -r .eccode src/server/.eccode', impl, 'allow', 'guard-visible channel: copies the whole real record into the claim (cp target src/server/.eccode is owned)');
  b('bogus-cp-dir-variant', 'cp -r src/server/tpl src/server/.eccode', impl, 'allow', 'a prepared directory copied into place');
  b('bogus-mv-dir', 'mv src/server/tpl src/server/.eccode', impl, 'allow');
  b('bogus-rsync', 'rsync -a src/server/tpl/ src/server/.eccode/', impl, 'allow');
  b('bogus-cli-init', 'eccode init --root src/server --name x --idea y --actor backend-engineer', impl, 'allow', 'the CLI itself creates src/server/.eccode/events.jsonl; any actor is accepted by init');
  b('bogus-cli-init-reviewer', 'eccode init --root .eccode/reviews/drafts --name x --idea y --actor technical-reviewer', 'technical-reviewer', 'allow');
  b('bogus-cli-init-main', 'eccode init --root .eccode --name x --idea y', null, 'allow', 'main session creates .eccode/.eccode/events.jsonl through the CLI');
  b('bogus-cp-dir-main', 'cp -r .eccode .eccode/.eccode', null, 'allow');
  b('bogus-cli-init-outside-claim', 'eccode init --root src/web --name x --idea y --actor backend-engineer', impl, 'allow', 'the CLI writes outside the claim; the guard does not check ownership of CLI writes');
  // Write src/server/b.js before any bogus root: allowed (claim). Then plant the bogus record.
  b('pre-bogus-write', 'echo x > src/server/b.js', impl, 'allow');
  fs.cpSync(path.join(ctx.dir, '.eccode'), path.join(ctx.dir, 'src', 'server', '.eccode'), { recursive: true });
  b('post-bogus-copy-write-inside', 'echo x > src/server/b.js', impl, 'deny', 'copied record: claims are src/server/** relative to the bogus root -> b.js is outside -> the implementer locks itself out');
  probe('post-bogus-copy-write-tool', { cwd: ctx.dir, tool: 'Write', file: path.join(ctx.dir, 'src', 'server', 'b.js'), role: impl, expect: 'deny', note: 'same' });
  b('post-bogus-copy-record-of-bogus', 'echo x > src/server/.eccode/state.json', impl, 'deny');
  b('post-bogus-copy-outside', 'echo x > src/web/a.js', impl, 'deny', 'outside the bogus root: still the real record');
  // Replace the bogus copy with a crafted record whose claim owns everything (what a script could build).
  fs.rmSync(path.join(ctx.dir, 'src', 'server', '.eccode'), { recursive: true, force: true });
  const bogusDir = path.join(ctx.dir, 'src', 'server');
  const bstore = init(bogusDir, { name: 'bogus', idea: 'crafted' });
  const bctx = { dir: bogusDir, store: bstore, config: loadConfig(bogusDir) };
  approveThroughPlan(bctx, { phases: samplePlan().phases, tasks: [task('all', 'backend-engineer', ['**'])] });
  gates.startGate(bctx.store, bctx.config, 'phase:core', 'orchestrator');
  tasks.claim(bctx.store, bctx.config, 'all', 'backend-engineer');
  b('crafted-write-inside', 'echo x > src/server/b.js', impl, 'allow', 'inside the real claim anyway');
  b('crafted-write-git', 'echo x > src/server/.git/hooks/pre-commit', impl, 'deny');
  b('crafted-outside', 'echo x > src/web/a.js', impl, 'deny', 'the crafted record cannot reach above its own directory');
  probe('crafted-real-record', { cwd: ctx.dir, tool: 'Write', file: path.join(ctx.dir, '.eccode', 'state.json'), role: impl, expect: 'deny' });
  // what a crafted record gains an implementer with a NON-prefix claim: a different project
  const ctx2 = tmpProject();
  cleanup.push(ctx2.dir);
  write(ctx2.dir, 'src/a.js', 'x\n');
  approveThroughPlan(ctx2, { phases: samplePlan().phases, tasks: [task('js', 'backend-engineer', ['src/**/*.js'])] });
  gates.startGate(ctx2.store, ctx2.config, 'phase:core', 'orchestrator');
  commitAll(ctx2.dir);
  tasks.claim(ctx2.store, ctx2.config, 'js', 'backend-engineer');
  const b2 = (id, command, role, expect, note) => probe(id, { cwd: ctx2.dir, command, role, expect, note });
  b2('nonprefix-yaml-before', 'echo x > src/config.yaml', impl, 'deny');
  b2('nonprefix-bogus-cp', 'cp -r src/tpl src/.eccode', impl, 'deny', 'src/.eccode is not owned by src/**/*.js');
  b2('nonprefix-bogus-cli-init', 'eccode init --root src --name x --idea y --actor backend-engineer', impl, 'allow', 'the CLI may create the empty record at src/');
  // simulate the empty record the CLI would create (no nested git: the outer repository sees the files)
  init(path.join(ctx2.dir, 'src'), { name: 'b', idea: 'b' });
  b2('nonprefix-yaml-after-empty', 'echo x > src/config.yaml', impl, 'deny', 'empty bogus record: no claim -> deny (self lock-out)');
  b2('nonprefix-js-after-empty', 'echo x > src/a.js', impl, 'deny', 'the implementer has locked itself out of its own claim');
  // now a crafted record (script channel) with a ** claim
  const s2 = { dir: path.join(ctx2.dir, 'src'), store: new (require(path.join(WT, 'lib', 'store')).Store)(path.join(ctx2.dir, 'src')), config: loadConfig(path.join(ctx2.dir, 'src')) };
  approveThroughPlan(s2, { phases: samplePlan().phases, tasks: [task('all', 'backend-engineer', ['**'])] });
  gates.startGate(s2.store, s2.config, 'phase:core', 'orchestrator');
  tasks.claim(s2.store, s2.config, 'all', 'backend-engineer');
  b2('nonprefix-yaml-after-crafted', 'echo x > src/config.yaml', impl, 'deny', 'LOOSENING if allow: real claim is src/**/*.js; crafted src/.eccode claims **');
  probe('nonprefix-yaml-after-crafted-write', { cwd: ctx2.dir, tool: 'Write', file: path.join(ctx2.dir, 'src', 'config.yaml'), role: impl, expect: 'deny', note: 'same, Write tool' });
  // Engine accounting of the crafted record: what does completion say about src/.eccode/* ?
  fs.writeFileSync(path.join(ctx2.dir, 'src', 'config.yaml'), 'y\n');
  fs.writeFileSync(path.join(ctx2.dir, 'src', 'a.js'), '// changed\n');
  const { passCheck, handoffFor } = require(path.join(WT, 'tests', 'helpers'));
  const ev = passCheck(ctx2.store, 'backend-engineer');
  let completion;
  try {
    tasks.complete(ctx2.store, ctx2.config, 'js', 'backend-engineer', handoffFor('js', 'backend-engineer', [ev.id], ['src/a.js']));
    completion = 'ACCEPTED';
  } catch (err) {
    completion = `${err.code}: ${err.message}`;
  }
  results.push({ section, id: 'engine-completion-with-crafted-record', role: impl, tool: 'engine', input: 'task complete js (src/.eccode/* and src/config.yaml present)', decision: completion.slice(0, 600), expect: 'refused (unaccounted files)', ok: /INVALID_HANDOFF/.test(completion), note: '', reason: '' });

  // (b) the main session: a bogus root inside the real record unprotects the record for the Write tool
  const ctx3 = tmpProject();
  cleanup.push(ctx3.dir);
  const b3 = (id, command, role, expect, note) => probe(id, { cwd: ctx3.dir, command, role, expect, note });
  const rec = (f) => path.join(ctx3.dir, '.eccode', f);
  probe('main-record-before', { cwd: ctx3.dir, tool: 'Write', file: rec('state.json'), role: null, expect: 'deny' });
  probe('main-events-before', { cwd: ctx3.dir, tool: 'Edit', file: rec('events.jsonl'), role: null, expect: 'deny' });
  b3('main-init-inside-record', 'eccode init --root .eccode --name x --idea y', null, 'allow', 'guard-visible step 1');
  // simulate exactly what that CLI command does
  init(rec(''), { name: 'x', idea: 'y' });
  probe('main-record-after', { cwd: ctx3.dir, tool: 'Write', file: rec('state.json'), role: null, expect: 'deny', note: 'BYPASS if allow: nearest root is .eccode/.eccode, rel = state.json' });
  probe('main-events-after', { cwd: ctx3.dir, tool: 'Edit', file: rec('events.jsonl'), role: null, expect: 'deny' });
  probe('main-config-after', { cwd: ctx3.dir, tool: 'Write', file: rec('config.json'), role: null, expect: 'deny' });
  probe('main-review-after', { cwd: ctx3.dir, tool: 'Write', file: rec('reviews/architecture-1.json'), role: null, expect: 'deny' });
  probe('main-memory-after', { cwd: ctx3.dir, tool: 'Write', file: rec('memory/m-1.json'), role: null, expect: 'deny' });
  probe('main-evidence-after', { cwd: ctx3.dir, tool: 'Write', file: rec('evidence/ev-1.log'), role: null, expect: 'deny' });
  b3('main-record-after-bash', 'echo x > .eccode/state.json', null, 'deny', 'the textual SHELL_WRITE regex still holds on bash');
  b3('main-record-after-bash-abs', `echo x > ${rec('state.json')}`, null, 'deny');
  probe('reviewer-record-after', { cwd: ctx3.dir, tool: 'Write', file: rec('state.json'), role: 'technical-reviewer', expect: 'deny' });
  probe('reviewer-review-after', { cwd: ctx3.dir, tool: 'Write', file: rec('reviews/design-1.json'), role: 'technical-reviewer', expect: 'deny' });
  probe('reviewer-draft-after', { cwd: ctx3.dir, tool: 'Write', file: rec('reviews/drafts/d.json'), role: 'technical-reviewer', expect: 'allow', note: 'collateral: with the bogus root the reviewer loses its draft area too' });
  // an implementer whose claim is **/*.json
  const ctx4 = tmpProject();
  cleanup.push(ctx4.dir);
  approveThroughPlan(ctx4, { phases: samplePlan().phases, tasks: [task('cfg', 'backend-engineer', ['**/*.json'])] });
  gates.startGate(ctx4.store, ctx4.config, 'phase:core', 'orchestrator');
  commitAll(ctx4.dir);
  tasks.claim(ctx4.store, ctx4.config, 'cfg', 'backend-engineer');
  probe('impl-json-record-before', { cwd: ctx4.dir, tool: 'Write', file: path.join(ctx4.dir, '.eccode', 'state.json'), role: impl, expect: 'deny' });
  probe('impl-json-init-inside-record', { cwd: ctx4.dir, command: 'eccode init --root .eccode --name x --idea y --actor backend-engineer', role: impl, expect: 'allow', note: 'guard-visible step 1 (identity matches)' });
  init(path.join(ctx4.dir, '.eccode'), { name: 'x', idea: 'y' });
  probe('impl-json-record-after', { cwd: ctx4.dir, tool: 'Write', file: path.join(ctx4.dir, '.eccode', 'state.json'), role: impl, expect: 'deny', note: 'BYPASS if allow: rel = state.json matches **/*.json (owns() only excludes paths that still start with .eccode/)' });
  probe('impl-json-config-after', { cwd: ctx4.dir, tool: 'Write', file: path.join(ctx4.dir, '.eccode', 'config.json'), role: impl, expect: 'deny' });
  // pre-existing, for the record: whole-record replacement by the main session through a directory copy
  const ctx5 = tmpProject();
  cleanup.push(ctx5.dir);
  probe('main-rsync-whole-record', { cwd: ctx5.dir, command: 'rsync -a /tmp/forged/ .eccode/', role: null, expect: 'deny', note: 'pre-existing: the record patterns need a file name after .eccode/' });
  probe('main-cp-whole-record', { cwd: ctx5.dir, command: 'cp -r /tmp/forged/. .eccode', role: null, expect: 'deny', note: 'pre-existing' });
  probe('impl-rsync-whole-record', { cwd: ctx5.dir, command: 'rsync -a /tmp/forged/ .eccode/', role: impl, expect: 'deny' });
}

// ------------------------------------------------------------------ 3. NEW-9 inline variables
section = 'NEW-9';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  const ld = 'learning-debugger';
  const b = (id, command, role, expect, env, note) => probe(id, { cwd: ctx.dir, command, role, expect, env, note });
  b('inline', 'ECCODE_SHARED_MEMORY=/tmp/forged eccode memory search race --actor learning-debugger', ld, 'deny');
  b('inline-quoted', 'ECCODE_SHARED_MEMORY="/tmp/forged" eccode memory search race --actor learning-debugger', ld, 'deny');
  b('inline-squoted-name', "'ECCODE_SHARED_MEMORY'=/tmp/x eccode memory search race --actor learning-debugger", ld, 'deny');
  b('env', 'env ECCODE_SHARED_MEMORY=/tmp/x eccode memory search race --actor learning-debugger', ld, 'deny');
  b('env-i', 'env -i ECCODE_SHARED_MEMORY=/tmp/x node bin/eccode.js memory search race --actor learning-debugger', ld, 'deny');
  b('env-S', "env -S 'ECCODE_SHARED_MEMORY=/tmp/x eccode memory search race --actor learning-debugger'", ld, 'deny');
  b('export-semicolon', 'export ECCODE_SHARED_MEMORY=/tmp/x; eccode memory search race --actor learning-debugger', ld, 'deny');
  b('export-and', 'export ECCODE_ROOT=/tmp/x && eccode gate start design --actor orchestrator', null, 'deny');
  b('assign-semicolon', 'ECCODE_SHARED_MEMORY=/tmp/x ; eccode memory search race --actor learning-debugger', ld, 'deny');
  b('declare-x', 'declare -x ECCODE_ROOT=/tmp/x; eccode status', null, 'deny');
  b('sh-c', "sh -c 'ECCODE_SHARED_MEMORY=/tmp/x eccode memory search race --actor learning-debugger'", ld, 'deny');
  b('bash-c-export', 'bash -c "export ECCODE_SHARED_MEMORY=/tmp/x; eccode memory search race --actor learning-debugger"', ld, 'deny');
  b('eval', 'eval "ECCODE_SHARED_MEMORY=/tmp/x eccode memory search race --actor learning-debugger"', ld, 'deny');
  b('export-alone', 'export ECCODE_SHARED_MEMORY=/tmp/x', ld, 'deny', {}, 'fail closed on any command (persistent shells)');
  b('export-alone-root', 'export ECCODE_ROOT=/tmp/x', null, 'deny');
  b('hooks-off-alone', 'export ECCODE_HOOKS=off', null, 'deny');
  b('sequential-alone', 'ECCODE_SEQUENTIAL_ROLES=1 true', null, 'deny');
  b('exported-in-environment', 'eccode memory search race --actor learning-debugger', ld, 'allow', { ECCODE_SHARED_MEMORY: '/tmp/x' }, 'the environment is the user\'s; unaffected');
  b('exported-root-in-environment', 'eccode status --brief', 'technical-reviewer', 'allow', { ECCODE_ROOT: ctx.dir });
  b('root-flag', 'eccode memory search race --actor learning-debugger --root /tmp/forged', ld, 'allow', {}, 'note: --root <elsewhere> is the flag form of ECCODE_ROOT and stays allowed');
  b('indirect-name', 'V=ECCODE_SHARED_MEMORY; export $V=/tmp/x; eccode memory search race --actor learning-debugger', ld, 'deny', {}, 'variable indirection of the NAME (bash exports ECCODE_SHARED_MEMORY)');
  b('indirect-printf', 'printf -v ECCODE_SHARED_MEMORY /tmp/x; export ECCODE_SHARED_MEMORY; eccode memory search race --actor learning-debugger', ld, 'deny');
  b('split-name-no-cli', "export ECC''ODE_SHARED_MEMORY=/tmp/x", ld, 'deny', {}, 'raw text has neither eccode nor ECCODE_: the identity gate is skipped (persistent shells)');
  b('split-name-with-cli', "export ECC''ODE_SHARED_MEMORY=/tmp/x; eccode memory search race --actor learning-debugger", ld, 'deny');
  b('read-from-file', 'set -a; . ./env.sh; set +a; eccode memory search race --actor learning-debugger', ld, 'deny', {}, 'a sourced file the guard cannot read (residual 1)');
  b('unrelated-var', 'FOO=1 eccode status --brief', 'technical-reviewer', 'allow');
  b('prefix-lookalike', 'ECCODE_ROOTX=1 eccode status --brief', 'technical-reviewer', 'allow', {}, 'ECCODE_ROOTX is not ECCODE_ROOT');
}

// ------------------------------------------------------------------ 4. NEW-7 shell wrappers
section = 'NEW-7';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  const rev = 'technical-reviewer';
  const b = (id, command, role, expect, note) => probe(id, { cwd: ctx.dir, command, role, expect, note });
  b('fn-braces', 'e() { eccode "$@"; }; e gate reopen design --actor user --resolution ok', null, 'deny');
  b('fn-braces-impersonate', 'e() { eccode "$@"; }; e task claim api --actor backend-engineer', rev, 'deny');
  b('fn-nospace', 'e(){ eccode "$@"; }; e task claim api --actor backend-engineer', rev, 'deny');
  b('fn-keyword', 'function e { eccode "$@"; }; e task claim api --actor backend-engineer', rev, 'deny');
  b('fn-keyword-parens', 'function e() { eccode "$@"; }; e task claim api --actor backend-engineer', rev, 'deny', 'valid bash (function NAME () compound)');
  b('fn-keyword-subshell', 'function e ( eccode "$@" ); e task claim api --actor backend-engineer', rev, 'deny');
  b('fn-subshell-body', 'e() ( eccode "$@" ); e task claim api --actor backend-engineer', rev, 'deny', 'valid bash: body is a subshell');
  b('fn-if-body', 'e() if true; then eccode "$@"; fi; e task claim api --actor backend-engineer', rev, 'deny', 'valid bash: body is an if compound');
  b('fn-leading-space', '  e() { eccode "$@"; }; e task claim api --actor backend-engineer', rev, 'deny');
  b('fn-after-then', 'if true; then e() { eccode "$@"; }; fi; e task claim api --actor backend-engineer', rev, 'deny');
  b('fn-in-group', '{ e() { eccode "$@"; }; }; e task claim api --actor backend-engineer', rev, 'deny');
  b('fn-after-and', 'true && e() { eccode "$@"; }; e task claim api --actor backend-engineer', rev, 'deny');
  b('fn-newlines', 'e() {\n  eccode "$@"\n}\ne task claim api --actor backend-engineer', rev, 'deny');
  b('fn-newline-before-brace', 'e()\n{\n  eccode "$@"\n}\ne gate reopen design --actor user', null, 'deny');
  b('fn-defined-later-line', 'e task claim api --actor backend-engineer\ne() { eccode "$@"; }', rev, 'deny', 'bash runs e before it exists (error), still refused');
  b('bash-c-fn', "bash -c 'e() { eccode \"$@\"; }; e task claim api --actor backend-engineer'", rev, 'deny', 'the wrapper check is not applied to nested command strings');
  b('bash-c-fn-user', "bash -c 'e() { eccode \"$@\"; }; e gate reopen design --actor user'", null, 'deny');
  b('sh-c-fn-dq', 'sh -c "e() { eccode \\"\\$@\\"; }; e task claim api --actor backend-engineer"', rev, 'deny');
  b('evidence-run-fn', 'eccode evidence run --actor backend-engineer --label t -- \'e() { eccode "$@"; }; e gate review design --actor technical-reviewer\'', 'backend-engineer', 'deny', 'the CLI runs the string in a shell; the nested call acts as another role');
  b('alias', 'alias e=eccode; e task claim api --actor backend-engineer', rev, 'deny', 'aliases do not expand in non-interactive bash; over-deny harmless');
  b('alias-expand', 'shopt -s expand_aliases; alias e=eccode; e task claim api --actor backend-engineer', rev, 'deny');
  b('eval-string', 'eval "eccode gate reopen design --actor user"', null, 'deny');
  b('eval-impersonate', "eval 'eccode task claim api --actor backend-engineer'", rev, 'deny');
  b('subst', '$(eccode gate reopen design --actor user)', null, 'deny');
  b('subst-impersonate', 'x=$(eccode task claim api --actor backend-engineer); echo $x', rev, 'deny');
  b('backtick', '`eccode task claim api --actor backend-engineer`', rev, 'deny');
  b('var-command', 'c=eccode; $c task claim api --actor backend-engineer', rev, 'deny');
  b('split-word', 'node bin/ecc"ode".js task claim api --actor backend-engineer', rev, 'deny', 'raw text has no eccode: identity gate skipped?');
  b('split-word-user', "node bin/ecc'ode'.js gate reopen design --actor user", null, 'deny');
  b('escaped-word', 'node bin/ecc\\ode.js task claim api --actor backend-engineer', rev, 'deny');
  b('exec-cli', 'exec eccode task claim api --actor backend-engineer', rev, 'deny');
  b('command-cli', 'command eccode task claim api --actor backend-engineer', rev, 'deny');
  // false positives
  b('fp-unrelated-fn', 'f() { echo hi; }; f', rev, 'allow');
  b('fp-unrelated-fn-comment', 'f() { echo hi; }; f # see the eccode docs', rev, 'allow', 'a comment mentioning eccode next to an unrelated function');
  b('fp-fn-then-cli', 'f() { echo hi; }; f; eccode status --brief', rev, 'deny', 'by design: any function in a line that calls the CLI is refused (acceptable over-deny)');
  b('fp-grep-fn', "grep -n 'e() {' scripts/x.sh && eccode status --brief", rev, 'allow', "a quoted pattern, not a definition: prefix before e is a quote");
  b('fp-evidence-run-fn', "eccode evidence run --actor backend-engineer --label t -- 'f() { npm test; }; f'", 'backend-engineer', 'allow', 'a function in the evidence command that never calls the CLI');
  b('plain', 'eccode status --brief', rev, 'allow');
}

// ------------------------------------------------------------------ report
const failures = results.filter((r) => !r.ok);
const lines = [];
lines.push(`# Guard probes against ${GUARD}`);
lines.push(`# node ${process.version}; ${results.length} probes; ${failures.length} mismatches with the reviewer's expectation`);
lines.push('');
lines.push('section | id | role | tool | decision | expect | ok | note | reason');
for (const r of results) lines.push([r.section, r.id, r.role, r.tool, r.decision, r.expect, r.ok ? 'ok' : 'MISMATCH', r.note, r.reason.replace(/\s+/g, ' ')].join(' | '));
lines.push('');
lines.push('## Inputs');
for (const r of results) lines.push(`${r.section}/${r.id}: ${JSON.stringify(r.input)}`);
const outFile = path.join(__dirname, 'results.txt');
fs.writeFileSync(outFile, lines.join('\n') + '\n');
process.stdout.write(lines.slice(0, 4 + results.length).join('\n') + '\n');
for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
