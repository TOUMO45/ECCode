'use strict';
// Third-review probes for 3fa6298: attack the real-path (realize) logic and look for over-denials in
// ordinary orchestrator/role commands. Same harness. Every symlink is created on disk before the probe
// so realize() sees it; TOCTOU cases create the link in an earlier word of the SAME command line (so it
// does not exist when the guard runs). bash semantics of the exotic forms are in bashsem.sh.
const WT = process.env.GUARD_WT || '/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { tmpProject, write, approveThroughPlan, samplePlan, task } = require(path.join(WT, 'tests', 'helpers'));
const { init } = require(path.join(WT, 'lib', 'project'));
const gates = require(path.join(WT, 'lib', 'gates'));
const tasks = require(path.join(WT, 'lib', 'tasks'));
const GUARD = path.join(WT, 'scripts', 'hooks', 'guard.js');

function hook(payload, env = {}) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '', ...env } });
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
  results.push({ section, id, role: role || 'main', tool, input: tool === 'Bash' ? command : file, decision, expect, ok: expect === decision, note: note || '', reason: out ? out.permissionDecisionReason.slice(0, 150) : '' });
}
function commitAll(dir) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'f'], { cwd: dir });
}
const cleanup = [];

// ------------------------------------------------------------------ A. real-path attacks on the record
section = 'REALPATH';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  const D = ctx.dir;
  const rec = (f) => path.join(D, '.eccode', f);
  fs.mkdirSync(path.join(D, '.eccode', 'reviews', 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(D, '.eccode', 'drafts'), { recursive: true });
  const W = (id, file, role, expect, note) => probe(id, { cwd: D, tool: 'Write', file, role, expect, note });
  const b = (id, command, role, expect, note) => probe(id, { cwd: D, command, role, expect, note });
  // symlink chain a -> b -> .eccode
  fs.symlinkSync(path.join(D, '.eccode'), path.join(D, 'b'));
  fs.symlinkSync(path.join(D, 'b'), path.join(D, 'a'));
  W('chain-write-state', path.join(D, 'a', 'state.json'), null, 'deny', 'a->b->.eccode');
  W('chain-write-events-role', path.join(D, 'a', 'events.jsonl'), 'backend-engineer', 'deny');
  b('chain-redirect', 'echo x > a/state.json', null, 'deny');
  b('chain-cp', 'cp /tmp/forged a/config.json', null, 'deny');
  b('chain-tee', 'echo x | tee a/events.jsonl', null, 'deny');
  // symlink that appears MID-path: src/link -> .eccode, write src/link/memory/m.json
  fs.mkdirSync(path.join(D, 'src'), { recursive: true });
  fs.symlinkSync(path.join(D, '.eccode'), path.join(D, 'src', 'link'));
  W('midpath-memory', path.join(D, 'src', 'link', 'memory', 'm.json'), null, 'deny');
  b('midpath-redirect', 'echo x > src/link/memory/m.json', null, 'deny');
  b('midpath-deep-new', 'echo x > src/link/evidence/sub/deep/new.log', null, 'deny', 'new tail under a mid-path link');
  // mid-path link to a draft area stays writable
  fs.symlinkSync(path.join(D, '.eccode', 'reviews', 'drafts'), path.join(D, 'draftlink'));
  W('midpath-draft-link', path.join(D, 'draftlink', 'r.json'), 'technical-reviewer', 'allow', 'link to a draft area is still a draft');
  b('midpath-draft-link-bash', 'echo x > draftlink/r.json', 'technical-reviewer', 'allow');
  // a directory symlink INSIDE a draft area pointing at the record (the review's own scratch tricked)
  fs.symlinkSync(path.join(D, '.eccode'), path.join(D, '.eccode', 'reviews', 'drafts', 'esc'));
  W('draft-escape-link', path.join(D, '.eccode', 'reviews', 'drafts', 'esc', 'state.json'), 'technical-reviewer', 'deny', 'ATTACK: draft/esc -> .eccode; esc/state.json is the record');
  b('draft-escape-link-bash', 'echo x > .eccode/reviews/drafts/esc/state.json', 'technical-reviewer', 'deny');
  W('draft-escape-link-events', path.join(D, '.eccode', 'reviews', 'drafts', 'esc', 'events.jsonl'), 'technical-reviewer', 'deny');
  W('draft-escape-link-deep', path.join(D, '.eccode', 'reviews', 'drafts', 'esc', 'memory', 'm.json'), 'backend-engineer', 'deny');
  // but a plain file under drafts/esc that is itself a draft of the LINKED record (esc -> .eccode so esc/drafts is .eccode/drafts)
  W('draft-escape-link-to-draft', path.join(D, '.eccode', 'reviews', 'drafts', 'esc', 'drafts', 'n.md'), 'technical-reviewer', 'allow', 'esc/drafts resolves to .eccode/drafts, a draft area');
  // relative link and .. through a link
  fs.symlinkSync('../../.eccode', path.join(D, 'src', 'rel'));
  W('rel-link', path.join(D, 'src', 'rel', 'state.json'), null, 'deny', 'relative symlink to the record');
  b('rel-link-bash', 'echo x > src/rel/state.json', null, 'deny');
  b('dotdot-through-link', 'echo x > src/link/../.eccode/state.json', null, 'deny', '.. after a link');
  b('dotdot-into-record', 'echo x > src/../.eccode/state.json', null, 'deny');
  // dangling link: target does not exist; writing through it creates the target
  fs.symlinkSync(path.join(D, '.eccode', 'newrec.json'), path.join(D, 'dangle'));
  W('dangling-into-record', path.join(D, 'dangle'), null, 'deny', 'dangling link whose target is a new record file');
  b('dangling-redirect', 'echo x > dangle', null, 'deny');
  fs.symlinkSync(path.join(D, '.eccode', 'drafts', 'ok.json'), path.join(D, 'dangle-ok'));
  W('dangling-into-draft', path.join(D, 'dangle-ok'), 'technical-reviewer', 'allow', 'dangling link into a draft area');
  // hard link to a record file, then write the hard link (hard link shares the inode; realpath cannot tell)
  const hl = spawnSync('ln', [rec('state.json'), path.join(D, 'src', 'hard.json')], { encoding: 'utf8' });
  results.push({ section, id: 'hardlink-created', role: 'setup', tool: 'setup', input: 'ln .eccode/state.json src/hard.json', decision: hl.status === 0 ? 'created' : `failed:${(hl.stderr || '').trim().slice(0, 60)}`, expect: 'created', ok: hl.status === 0, note: 'hard link to a record file', reason: '' });
  if (hl.status === 0) {
    W('hardlink-write', path.join(D, 'src', 'hard.json'), null, 'allow', 'RESIDUAL if allow: a hard link shares the record inode; realpath cannot detect it');
    b('hardlink-redirect', 'echo x > src/hard.json', null, 'allow', 'same (hard links are a documented filesystem residual)');
  }
  // TOCTOU: create the alias in an earlier word, use it later in the same line (link absent at guard time)
  b('toctou-ln-then-write', 'ln -s "$PWD/.eccode" lk && echo x > lk/state.json', null, 'deny', 'bash: lk/state.json hits .eccode textually via realize? lk absent at guard time');
  b('toctou-ln-then-cp', 'ln -s "$PWD/.eccode" lk; cp /tmp/forged lk/config.json', null, 'deny');
  b('toctou-mkdir-then-write', 'mkdir -p x/.eccode && echo x > x/.eccode/state.json', null, 'deny', 'textual record path regardless');
  // the record directory itself as a target, through a link
  b('dir-link-rm', 'rm -rf a', null, 'deny', 'a -> b -> .eccode: rm of the link to the record');
  b('dir-link-cp', 'cp -r /tmp/forged/. a', null, 'deny');
  b('dir-link-mv', 'mv a /tmp/away', null, 'deny');
  // absolute messy spellings
  b('abs-dotslash', `echo x > ${D}/./.eccode/state.json`, null, 'deny');
  b('abs-double-slash', `echo x > ${D}//.eccode//state.json`, null, 'deny');
}

// ------------------------------------------------------------------ B. over-denials: ordinary orchestrator / role commands
section = 'ORDINARY';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  write(ctx.dir, 'src/server/a.js', 'x\n');
  write(ctx.dir, 'README.md', '# x\n');
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  commitAll(ctx.dir);
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  const D = ctx.dir;
  const impl = 'backend-engineer';
  const rev = 'technical-reviewer';
  const arch = 'product-architect';
  const bm = (id, command, expect, note) => probe(id, { cwd: D, command, role: null, expect, note });
  const bi = (id, command, expect, note) => probe(id, { cwd: D, command, role: impl, expect, note });
  const br = (id, command, expect, note) => probe(id, { cwd: D, command, role: rev, expect, note });
  // main session / orchestrator everyday commands
  bm('git-status', 'git status', 'allow');
  bm('git-add', 'git add -A', 'allow');
  bm('git-commit', 'git commit -m "wip"', 'allow');
  bm('git-add-eccode-path', 'git add .eccode/artifacts/brief.md', 'allow', 'staging is not a write to the record');
  bm('git-diff', 'git diff .eccode/state.json', 'allow');
  bm('git-log', 'git log --oneline -5', 'allow');
  bm('git-checkout-src', 'git checkout -- src/server/a.js', 'allow');
  bm('npm-ci', 'npm ci', 'allow');
  bm('npm-install', 'npm install', 'allow');
  bm('npm-run-build', 'npm run build', 'allow');
  bm('npm-test', 'npm test', 'allow');
  bm('mkdir-p', 'mkdir -p src/server/lib', 'allow');
  bm('mkdir-dist', 'mkdir -p dist && echo built', 'allow');
  bm('touch-src', 'touch src/server/new.js', 'allow');
  bm('rm-build', 'rm -rf dist build node_modules/.cache', 'allow');
  bm('cp-src', 'cp src/server/a.js src/server/b.js', 'allow');
  bm('mv-src', 'mv src/server/a.js src/server/c.js', 'allow');
  bm('sed-src', 'sed -i s/a/b/ src/server/a.js', 'allow');
  bm('tar-backup', 'tar czf /tmp/proj.tgz src', 'allow');
  bm('redirect-src', 'echo x > src/server/a.js', 'allow');
  bm('node-build', 'node -e "require(\'fs\').writeFileSync(\'dist/out.js\',\'x\')"', 'allow', 'main session is not subject to inline-code denial');
  bm('find-src', 'find src -name "*.js" -exec grep -l foo {} +', 'allow', 'find -exec grep (not a writer)');
  bm('find-delete-build', 'find dist -type f -delete', 'allow');
  bm('cat-record', 'cat .eccode/state.json', 'allow');
  bm('ls-record', 'ls -la .eccode', 'allow');
  bm('cp-record-out', 'cp -r .eccode /tmp/backup', 'allow', 'record as source');
  bm('grep-record', 'grep claimed .eccode/events.jsonl', 'allow');
  bm('echo-comment-record', 'echo hi # updates .eccode later', 'allow');
  bm('eccode-status', 'eccode status --brief', 'allow');
  bm('eccode-run', 'eccode gate start design --actor orchestrator', 'allow');
  bm('export-path-then-eccode', 'export PATH="$PWD/node_modules/.bin:$PATH"; eccode status', 'allow', 'computed value, literal name');
  bm('env-literal-eccode', 'env FORCE_COLOR=1 eccode status --brief', 'allow');
  bm('evidence-run-npm', 'eccode evidence run --actor orchestrator --label t -- npm test', 'allow');
  // implementer inside its claim
  bi('impl-redirect-claim', 'echo x > src/server/a.js', 'allow');
  bi('impl-mkdir-claim', 'mkdir -p src/server/sub', 'allow');
  bi('impl-cp-claim', 'cp /tmp/a src/server/new.js', 'allow');
  bi('impl-mv-within-claim', 'mv src/server/a.js src/server/b.js', 'allow');
  bi('impl-sed-claim', 'sed -i s/a/b/ src/server/a.js', 'allow');
  bi('impl-tee-claim', 'echo x | tee src/server/a.js', 'allow');
  bi('impl-touch-claim', 'touch src/server/x.js', 'allow');
  bi('impl-draft', 'echo x > .eccode/drafts/scratch.txt', 'allow');
  bi('impl-evidence-run', 'eccode evidence run --actor backend-engineer --task api --label t -- npm test', 'allow');
  bi('impl-node-build-claim', 'node build.js', 'allow', 'a script file is residual 1, not denied');
  bi('impl-git-status', 'git status', 'allow');
  bi('impl-cd-subshell-test', '(cd src/server && node -e "console.log(1)")', 'allow', 'read-only in a subshell cd');
  // reviewer / author drafts and artifacts
  br('rev-write-draft', 'echo x > .eccode/reviews/drafts/r.json', 'allow');
  br('rev-tee-draft', 'echo x | tee .eccode/reviews/drafts/r.json', 'allow');
  br('rev-cp-into-draft-abs-src', 'cp /tmp/r.json .eccode/reviews/drafts/r.json', 'allow', 'abs source, draft target');
  br('rev-mkdir-draft', 'mkdir -p .eccode/reviews/drafts/sub', 'allow');
  probe('rev-write-draft-tool', { cwd: D, tool: 'Write', file: '.eccode/reviews/drafts/r.json', role: rev, expect: 'allow' });
  probe('rev-write-draft-dir-slash', { cwd: D, tool: 'Write', file: '.eccode/reviews/drafts/', role: rev, expect: 'allow', note: 'the draft dir itself' });
  probe('arch-write-artifact', { cwd: D, tool: 'Write', file: '.eccode/artifacts/brief.md', role: arch, expect: 'allow' });
  probe('arch-write-artifact-bash', { cwd: D, command: 'echo x > .eccode/artifacts/brief.md', role: arch, expect: 'allow' });
  br('rev-cp-draft-to-draft', 'cp .eccode/reviews/drafts/a.json .eccode/reviews/drafts/b.json', 'allow');
  br('rev-git-status', 'git status', 'allow');
  br('rev-cat-record', 'cat .eccode/state.json', 'allow');
  br('rev-eccode-review', 'eccode gate review design --actor technical-reviewer --input .eccode/reviews/drafts/r.json', 'allow');
}

const failures = results.filter((r) => !r.ok);
const lines = [`# Real-path and over-denial probes against ${GUARD}`, `# node ${process.version}; ${results.length} probes; ${failures.length} mismatches`, '', 'section | id | role | tool | decision | expect | ok | note | reason'];
for (const r of results) lines.push([r.section, r.id, r.role, r.tool, r.decision, r.expect, r.ok ? 'ok' : 'MISMATCH', r.note, r.reason.replace(/\s+/g, ' ')].join(' | '));
lines.push('', '## Inputs');
for (const r of results) lines.push(`${r.section}/${r.id}: ${JSON.stringify(r.input)}`);
fs.writeFileSync(path.join(__dirname, 'results4.txt'), lines.join('\n') + '\n');
process.stdout.write(lines.slice(0, 4 + results.length).join('\n') + '\n');
for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
