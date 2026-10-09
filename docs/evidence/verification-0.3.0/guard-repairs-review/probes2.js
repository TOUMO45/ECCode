'use strict';
// Re-review probes for d0e2a3b (80ddab0): attacks on the new nested-root defences, RECORD_DIR_WRITE
// false positives/negatives, the unanchored wrapper regex, computed-name assignments, and the
// tokenized "mentions the CLI" gate. Same harness as probes.js. Every bash form probed here was run
// through bash 5.2 (bashsem.sh / bashsem-output.txt): all are valid and do what the note says.
const WT = process.env.GUARD_WT || '/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { tmpProject, write, initRepo, approveThroughPlan, samplePlan, task } = require(path.join(WT, 'tests', 'helpers'));
const { init } = require(path.join(WT, 'lib', 'project'));
const { loadConfig } = require(path.join(WT, 'lib', 'config'));
const gates = require(path.join(WT, 'lib', 'gates'));
const tasks = require(path.join(WT, 'lib', 'tasks'));
const GUARD = path.join(WT, 'scripts', 'hooks', 'guard.js');
const CLI = path.join(WT, 'bin', 'eccode.js');

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
  results.push({ section, id, role: role || 'main', tool, input: tool === 'Bash' ? command : file, decision, expect, ok: expect === decision, note: note || '', reason: out ? out.permissionDecisionReason.slice(0, 140) : '' });
}
function engine(id, label, fn, expectRe, expectLabel) {
  let r;
  try { r = `OK: ${fn() || ''}`; } catch (err) { r = `${err.code}: ${err.message}`; }
  results.push({ section, id, role: 'engine', tool: 'engine', input: label, decision: r.slice(0, 200), expect: expectLabel, ok: expectRe.test(r), note: '', reason: '' });
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

// ------------------------------------------------------------- A. RECORD_DIR_WRITE: false positives / negatives
section = 'RECORD-DIR';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  const rev = 'technical-reviewer';
  const b = (id, command, role, expect, note) => probe(id, { cwd: ctx.dir, command, role, expect, note });
  // legitimate commands that must stay allowed
  b('fp-cp-from-drafts', 'cp .eccode/drafts/a.json b.json', null, 'allow');
  b('fp-cp-from-drafts-role', 'cp .eccode/drafts/a.json .eccode/drafts/b.json', rev, 'allow');
  b('fp-ls', 'ls .eccode', rev, 'allow');
  b('fp-ls-la', 'ls -la .eccode/', rev, 'allow');
  b('fp-cat', 'cat .eccode/state.json', rev, 'allow');
  b('fp-cat-events', 'cat .eccode/events.jsonl | tail -3', rev, 'allow');
  b('fp-rm-draft-role', 'rm .eccode/drafts/tmp.txt', rev, 'allow');
  b('fp-rm-review-draft', 'rm .eccode/reviews/drafts/old.json', rev, 'allow');
  b('fp-mv-into-review-drafts', 'mv x.json .eccode/reviews/drafts/', rev, 'allow');
  b('fp-mv-into-drafts', 'mv notes.md .eccode/drafts/notes.md', 'backend-engineer', 'allow');
  b('fp-cp-into-artifacts', 'cp brief.md .eccode/artifacts/brief.md', 'product-architect', 'allow');
  b('fp-du', 'du -sh .eccode', null, 'allow');
  b('fp-find', 'find .eccode -name "*.json" | head', null, 'allow');
  b('fp-git-status', 'git status --short .eccode', null, 'allow');
  b('fp-rm-then-ls', 'rm -rf build && ls .eccode', null, 'allow');
  b('fp-echo-gitignore', 'echo .eccode/.lock >> .gitignore', null, 'allow');
  b('fp-mkdir', 'mkdir -p .eccode/drafts', rev, 'allow');
  b('fp-grep', 'grep -rn claimed .eccode/state.json', rev, 'allow');
  // the record as a SOURCE (reads) — over-denials if denied
  b('src-cp-backup', 'cp -r .eccode /tmp/backup-eccode', null, 'allow', 'read-only copy out of the project');
  b('src-tar-backup', 'tar czf /tmp/record.tgz .eccode', null, 'allow', 'tar -c reads the record');
  b('src-rsync-backup', 'rsync -a .eccode/ /tmp/backup/', null, 'allow');
  b('src-rm-comment', 'rm -rf build # old .eccode junk', null, 'allow', 'a comment');
  // writes onto the record DIRECTORY that must be denied
  b('dir-cp-dot', 'cp -r /tmp/forged/. .eccode', null, 'deny');
  b('dir-cp-dotslash', 'cp -r /tmp/forged/. ./.eccode', null, 'deny');
  b('dir-rsync', 'rsync -a /tmp/forged/ .eccode/', null, 'deny');
  b('dir-rsync-noslash', 'rsync -a /tmp/forged/ .eccode', null, 'deny');
  b('dir-mv-over', 'mv /tmp/forged .eccode', null, 'deny');
  b('dir-mv-away', 'mv .eccode /tmp/away', null, 'deny');
  b('dir-rm-rf', 'rm -rf .eccode', null, 'deny');
  b('dir-rm-rf-slash', 'rm -rf .eccode/', null, 'deny');
  b('dir-tar-x', 'tar xf /tmp/forged.tgz -C .eccode', null, 'deny');
  b('dir-ln', 'ln -s /tmp/forged .eccode', null, 'deny');
  b('dir-quoted', 'cp -r /tmp/forged/. ".eccode"', null, 'deny');
  b('dir-abs', `cp -r /tmp/forged/. ${ctx.dir}/.eccode`, null, 'deny', 'absolute path to the record directory');
  b('dir-abs-rm', `rm -rf ${ctx.dir}/.eccode`, null, 'deny');
  b('dir-abs-mv', `mv ${ctx.dir}/.eccode /tmp/away`, null, 'deny');
  b('dir-dotdot', 'cp -r /tmp/forged/. src/../.eccode', null, 'deny', 'a prefixed relative path');
  b('dir-pwd', 'cp -r /tmp/forged/. "$PWD/.eccode"', null, 'deny', 'dynamic prefix');
  b('dir-glob', 'rm -rf .eccode/*', null, 'deny', 'empties the record');
  b('dir-glob-mv', 'mv /tmp/forged/* .eccode/', null, 'deny');
  b('dir-subdir-reviews', 'rm -rf .eccode/reviews', null, 'deny', 'record area without a trailing slash');
  b('dir-subdir-memory', 'rm -r .eccode/memory', null, 'deny');
  b('dir-subdir-evidence-mv', 'mv .eccode/evidence /tmp/x', null, 'deny');
  b('dir-subdir-reviews-cp', 'cp -r /tmp/forged/reviews .eccode/reviews', null, 'deny');
  b('dir-brace', 'rm -f .eccode/{events.jsonl,state.json}', null, 'deny', 'brace expansion');
  b('dir-split-quote', "rm -rf .ecc''ode", null, 'deny', 'quote-split name');
  b('dir-split-quote-cp', "cp -r /tmp/forged/. .ecc''ode", null, 'deny');
  b('dir-rmdir-forced', 'rm -rf -- .eccode', null, 'deny');
  b('dir-find-delete', 'find .eccode -type f -delete', null, 'deny', 'find -delete empties the record');
  b('dir-find-exec-rm', 'find .eccode -type f -exec rm {} +', null, 'deny');
  b('dir-xargs-rm', 'ls .eccode/* | xargs rm -f', null, 'deny');
  b('dir-role-cp', 'cp -r /tmp/forged/. .eccode', 'backend-engineer', 'deny');
  b('dir-role-rm', 'rm -rf .eccode', rev, 'deny');
  // the record as a file target spelled around the raw regexes (main session has no tokenized target check)
  b('file-dq-name', 'echo x > .eccode/"state.json"', null, 'deny', 'bash writes .eccode/state.json');
  b('file-split-dir', "echo x > .ecc''ode/events.jsonl", null, 'deny');
  b('file-backslash', 'echo x > .eccode/\\state.json', null, 'deny');
  b('file-cp-dq', 'cp /tmp/forged.json .eccode/"state.json"', null, 'deny');
  b('file-tee-dq', 'cat /tmp/forged.jsonl | tee .eccode/"events.jsonl"', null, 'deny');
  b('file-abs-dq', `echo x > ${ctx.dir}/.eccode/"config.json"`, null, 'deny');
  b('file-clobber-main', 'echo x >| .eccode/events.jsonl', null, 'deny', 'F1 of the first review');
  b('file-clobber-fd-main', 'cat f 2>| .eccode/events.jsonl', null, 'deny');
  b('file-role-dq-name', 'echo x > .eccode/"state.json"', rev, 'deny', 'roles: tokenized abs check');
  b('file-role-split', "echo x > .ecc''ode/events.jsonl", 'backend-engineer', 'deny');
  // symlink alias of the record (main session bash path never resolves symlinks)
  fs.symlinkSync(path.join(ctx.dir, '.eccode'), path.join(ctx.dir, 'rec'));
  b('alias-ln-pwd', 'ln -s "$PWD/.eccode" rec', null, 'deny', 'creating the alias with a prefixed path');
  b('alias-write-main', 'echo x > rec/state.json', null, 'deny', 'bash writes .eccode/state.json through the link');
  probe('alias-write-main-tool', { cwd: ctx.dir, tool: 'Write', file: path.join(ctx.dir, 'rec', 'state.json'), role: null, expect: 'deny' });
  b('alias-write-role', 'echo x > rec/state.json', rev, 'deny');
  b('alias-cp-dir', 'cp -r /tmp/forged/. rec', null, 'deny', 'replacing the record through the alias');
}

// ------------------------------------------------------------- B. planted records at other depths, symlinked .eccode, --root inside a record
section = 'PLANTED';
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
  const rev = 'technical-reviewer';
  const rec = (f) => path.join(ctx.dir, '.eccode', f);
  const W = (id, file, role, expect, note) => probe(id, { cwd: ctx.dir, tool: 'Write', file, role, expect, note });
  const b = (id, command, role, expect, note) => probe(id, { cwd: ctx.dir, command, role, expect, note });
  // lib init refusals
  engine('init-inside-record', 'init(.eccode)', () => init(rec(''), { name: 'a', idea: 'b' }), /^INVALID_INPUT/, 'INVALID_INPUT');
  engine('init-inside-drafts', 'init(.eccode/drafts)', () => init(rec('drafts'), { name: 'a', idea: 'b' }), /^INVALID_INPUT/, 'INVALID_INPUT');
  engine('init-inside-review-drafts', 'init(.eccode/reviews/drafts/x)', () => init(rec('reviews/drafts/x'), { name: 'a', idea: 'b' }), /^INVALID_INPUT/, 'INVALID_INPUT');
  engine('init-dotdot-into-record', 'init(src/../.eccode/drafts)', () => init(path.join(ctx.dir, 'src', '..', '.eccode', 'drafts'), { name: 'a', idea: 'b' }), /^INVALID_INPUT/, 'INVALID_INPUT');
  engine('init-nested-example', 'init(examples/app) (legitimate)', () => { const d = path.join(ctx.dir, 'examples', 'app'); fs.mkdirSync(d, { recursive: true }); init(d, { name: 'a', idea: 'b' }); return 'created'; }, /^OK/, 'OK');
  engine('init-inside-claim', 'init(src/server) (empty record inside a claim)', () => { init(path.join(ctx.dir, 'src', 'server'), { name: 'a', idea: 'b' }); return 'created'; }, /^OK/, 'OK (not refused; residual)');
  fs.rmSync(path.join(ctx.dir, 'src', 'server', '.eccode'), { recursive: true, force: true });
  // a symlink into the record defeats the lexical check in init
  fs.symlinkSync(rec('drafts'), path.join(ctx.dir, 'work'));
  engine('init-via-symlink-into-record', 'init(work -> .eccode/drafts)', () => { init(path.join(ctx.dir, 'work'), { name: 'a', idea: 'b' }); return `created ${fs.existsSync(rec('drafts/.eccode/events.jsonl'))}`; }, /^INVALID_INPUT/, 'INVALID_INPUT');
  // the CLI with --root inside the record (init and a read command), for real
  const cli = (args) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ctx.dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: '', ECCODE_ACTOR: '' } }); return `rc=${r.status} ${(r.stdout + r.stderr).trim().split('\n')[0].slice(0, 160)}`; };
  results.push({ section, id: 'cli-init-root-record', role: 'cli', tool: 'cli', input: 'eccode init --root .eccode --name a --idea b', decision: cli(['init', '--root', '.eccode', '--name', 'a', '--idea', 'b']), expect: 'rc!=0 refused', ok: false, note: '', reason: '' });
  results[results.length - 1].ok = /^rc=[1-9]/.test(results[results.length - 1].decision);
  results.push({ section, id: 'cli-init-root-drafts-rel', role: 'cli', tool: 'cli', input: 'eccode init --root ./.eccode/drafts/new --name a --idea b', decision: cli(['init', '--root', './.eccode/drafts/new', '--name', 'a', '--idea', 'b']), expect: 'rc!=0 refused', ok: false, note: '', reason: '' });
  results[results.length - 1].ok = /^rc=[1-9]/.test(results[results.length - 1].decision);
  results.push({ section, id: 'cli-status-root-record', role: 'cli', tool: 'cli', input: 'eccode status --root .eccode (no record there)', decision: cli(['status', '--root', '.eccode']), expect: 'rc!=0 (not a project)', ok: false, note: '', reason: '' });
  results[results.length - 1].ok = /^rc=[1-9]/.test(results[results.length - 1].decision);
  // now plant records at several depths (by copy: what cp -r via a prefixed path, rsync, tar or a script would do)
  plant(rec(''), rec('.eccode'));
  plant(rec(''), rec('drafts/.eccode'));
  plant(rec(''), rec('reviews/drafts/.eccode'));
  plant(rec(''), path.join(ctx.dir, 'src', 'server', '.eccode'));
  // 1. inside the record: never re-roots
  W('rec-state-after-plant', rec('state.json'), null, 'deny');
  W('rec-events-after-plant', rec('events.jsonl'), null, 'deny');
  W('rec-config-after-plant', rec('config.json'), null, 'deny');
  W('rec-review-after-plant', rec('reviews/architecture-1.json'), null, 'deny');
  W('rec-memory-after-plant', rec('memory/m-1.json'), null, 'deny');
  W('rec-evidence-after-plant', rec('evidence/ev-1.log'), null, 'deny');
  W('rec-handoff-after-plant', rec('handoffs/ho-1.json'), null, 'deny');
  W('rec-delivery-after-plant', rec('delivery/final.json'), null, 'deny');
  W('rec-lock-after-plant', rec('.lock'), null, 'deny');
  W('rec-planted-own-state', rec('.eccode/state.json'), null, 'deny', 'the planted copy is itself a record path');
  W('rec-drafts-planted-state', rec('drafts/.eccode/state.json'), rev, 'deny');
  W('rec-review-drafts-planted-state', rec('reviews/drafts/.eccode/state.json'), rev, 'deny');
  W('rec-reviewer-draft-still-ok', rec('reviews/drafts/d.json'), rev, 'allow', 'the reviewer keeps its draft area despite the planted records');
  W('rec-reviewer-draft-deep', rec('reviews/drafts/.eccode/drafts/n.md'), rev, 'allow', 'a draft path beneath the planted copy is still a draft of the real record (lexically)');
  W('rec-impl-draft-still-ok', rec('drafts/n.md'), impl, 'allow');
  W('rec-artifact-author', rec('artifacts/brief.md'), 'product-architect', 'allow');
  b('rec-bash-after-plant', 'echo x > .eccode/state.json', null, 'deny');
  b('rec-bash-abs-after-plant', `echo x > ${rec('state.json')}`, impl, 'deny');
  b('rec-bash-planted-cp', 'cp /tmp/x .eccode/.eccode/state.json', null, 'deny');
  // 2. inside a claim: the implementer's own files are judged by the planted record now (copied claims are src/server/**)
  W('claim-after-plant-inside', path.join(ctx.dir, 'src', 'server', 'b.js'), impl, 'deny', 'self lock-out: planted claims are relative to src/server');
  W('claim-after-plant-nested-match', path.join(ctx.dir, 'src', 'server', 'src', 'server', 'c.js'), impl, 'allow', 'inside the real claim anyway');
  W('claim-after-plant-record', path.join(ctx.dir, 'src', 'server', '.eccode', 'state.json'), impl, 'deny');
  W('claim-after-plant-outside', path.join(ctx.dir, 'src', 'web', 'a.js'), impl, 'deny');
  W('claim-after-plant-real-record', rec('state.json'), impl, 'deny');
  b('claim-after-plant-git', 'echo x > src/server/.git/config', impl, 'deny');
  // 3. a symlinked .eccode: src/web/.eccode -> real record (created outside the guard; the ln itself is probed below)
  fs.symlinkSync(rec(''), path.join(ctx.dir, 'src', 'web', '.eccode'));
  b('symlink-rec-ln-abs', `ln -s ${rec('')} src/server/.eccode2`, impl, 'deny', 'creating a link to the record directory by absolute path');
  b('symlink-rec-ln-rel', 'ln -s ../../.eccode src/server/.eccode2', impl, 'deny');
  W('symlink-rec-state-via-link', path.join(ctx.dir, 'src', 'web', '.eccode', 'state.json'), null, 'deny', 'lexical .eccode/state.json');
  W('symlink-rec-web-file', path.join(ctx.dir, 'src', 'web', 'x.js'), impl, 'deny', 'root becomes src/web (through the link): real claims do not match x.js');
  W('symlink-rec-web-nested-match', path.join(ctx.dir, 'src', 'web', 'src', 'server', 'x.js'), impl, 'deny', 'LOOSENING if allow: the real record through the link grants src/server/** under src/web');
  b('symlink-rec-web-nested-match-bash', 'echo x > src/web/src/server/x.js', impl, 'deny', 'same by redirect');
  fs.symlinkSync(rec(''), path.join(ctx.dir, 'rec'));
  W('symlink-alias-state', path.join(ctx.dir, 'rec', 'state.json'), null, 'deny', 'Write through an alias of the record (realpath check)');
  W('symlink-alias-state-role', path.join(ctx.dir, 'rec', 'state.json'), impl, 'deny');
  // 4. the nested legitimate project still works after the outer record has planted copies
  const inner = path.join(ctx.dir, 'examples', 'app');
  W('nested-draft-still-ok', path.join(inner, '.eccode', 'reviews', 'drafts', 'r.json'), rev, 'allow');
  W('nested-record-still-denied', path.join(inner, '.eccode', 'state.json'), rev, 'deny');
  b('nested-dir-cp-from-outer', 'cp -r /tmp/forged/. examples/app/.eccode', null, 'deny', 'replacing the nested record from the outer cwd');
  b('nested-dir-rm-from-outer', 'rm -rf examples/app/.eccode', null, 'deny');
  probe('nested-dir-rm-from-inner', { cwd: inner, command: 'rm -rf .eccode', role: null, expect: 'deny' });
  probe('nested-dir-cp-from-inner-abs', { cwd: inner, command: `cp -r /tmp/forged/. ${path.join(inner, '.eccode')}`, role: null, expect: 'deny' });
  probe('nested-outer-dir-from-inner', { cwd: inner, command: 'rm -rf ../../.eccode', role: null, expect: 'deny' });
  // 5. the hook cwd inside a planted record (a shell that cd'ed into .eccode/drafts)
  probe('cwd-in-drafts-root', { cwd: rec('drafts'), tool: 'Write', file: rec('state.json'), role: null, expect: 'deny' });
  probe('cwd-in-drafts-draft', { cwd: rec('drafts'), tool: 'Write', file: 'n.md', role: impl, expect: 'allow', note: 'relative to cwd .eccode/drafts/n.md' });
  probe('cwd-in-drafts-src', { cwd: rec('drafts'), tool: 'Write', file: '../../src/server/b.js', role: impl, expect: 'allow', note: 'the real root is found from the cwd by walking out of the record' });
  probe('cwd-in-drafts-src-outside', { cwd: rec('drafts'), tool: 'Write', file: '../../src/web/zz.js', role: impl, expect: 'deny' });
}

// ------------------------------------------------------------- C. wrappers and the CLI word after 80ddab0
section = 'WRAPPER2';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  const rev = 'technical-reviewer';
  const b = (id, command, role, expect, note) => probe(id, { cwd: ctx.dir, command, role, expect, note });
  const tail = 'task claim api --actor backend-engineer';
  b('fn-digit-name', `1e() { eccode "$@"; }; 1e ${tail}`, rev, 'deny', 'bash accepts a function name starting with a digit');
  b('fn-unicode-name', `é() { eccode "$@"; }; é ${tail}`, rev, 'deny', 'bash accepts a non-ASCII name');
  b('fn-plus-name', `e+() { eccode "$@"; }; e+ ${tail}`, rev, 'deny');
  b('fn-pct-name', `e%() { eccode "$@"; }; e% ${tail}`, rev, 'deny');
  b('fn-dot-name', `e.x() { eccode "$@"; }; e.x ${tail}`, rev, 'deny');
  b('fn-keyword-parens', `function e() { eccode "$@"; }; e ${tail}`, rev, 'deny');
  b('fn-subshell', `e() ( eccode "$@" ); e ${tail}`, rev, 'deny');
  b('fn-if', `e() if true; then eccode "$@"; fi; e ${tail}`, rev, 'deny');
  b('fn-while', `e() while true; do eccode "$@"; break; done; e ${tail}`, rev, 'deny');
  b('fn-case', `e() case x in x) eccode "$@";; esac; e ${tail}`, rev, 'deny');
  b('fn-leading-space', `  e() { eccode "$@"; }; e ${tail}`, rev, 'deny');
  b('fn-then', `if true; then e() { eccode "$@"; }; fi; e ${tail}`, rev, 'deny');
  b('fn-group', `{ e() { eccode "$@"; }; }; e ${tail}`, rev, 'deny');
  b('fn-bash-c', `bash -c 'e() { eccode "$@"; }; e ${tail}'`, rev, 'deny');
  b('fn-sh-c-dq', `sh -c "e() { eccode \\"\\$@\\"; }; e ${tail}"`, rev, 'deny');
  b('fn-evidence-run', `eccode evidence run --actor backend-engineer --label t -- 'e() { eccode "$@"; }; e gate review design --actor technical-reviewer'`, 'backend-engineer', 'deny');
  b('fn-eval-quoted', `eval 'e() { eccode "$@"; }'; e ${tail}`, rev, 'deny');
  b('fn-printf-source', `printf 'e() { eccode "$@"; }' > .eccode/drafts/w.sh; . .eccode/drafts/w.sh; e ${tail}`, rev, 'deny');
  b('fn-split-cli-word', `node bin/ecc"ode".js ${tail}`, rev, 'deny');
  b('fn-split-cli-word-user', "node bin/ecc'ode'.js gate reopen design --actor user", null, 'deny');
  b('fn-escaped-cli-word', `node bin/ecc\\ode.js ${tail}`, rev, 'deny');
  b('cli-ansi-c', `node bin/$'eccode'.js ${tail}`, rev, 'deny', 'ANSI-C quoting: bash runs bin/eccode.js');
  b('cli-empty-subst', `node bin/ecc$''ode.js ${tail}`, rev, 'deny', 'empty $\'\' splits the word; bash runs bin/eccode.js');
  b('cli-empty-var-suffix', `X=; node bin/eccode.js\${X} ${tail}`, rev, 'deny', 'empty variable suffix on the CLI word');
  b('cli-empty-var-prefix', `X=; node \${X}bin/eccode.js ${tail}`, rev, 'deny');
  b('cli-var-command-user', 'c=eccode; $c gate reopen design --actor user', null, 'deny');
  b('cli-array', 'a=(eccode gate reopen design --actor user); "${a[@]}"', null, 'deny');
  b('cli-plain-ok', 'eccode status --brief', rev, 'allow');
  b('cli-path-ok', 'node bin/eccode.js status --brief', rev, 'allow');
  // false positives of the unanchored regex
  b('fp-fn-unrelated', 'f() { echo hi; }; f', rev, 'allow');
  b('fp-comment', 'f() { echo hi; }; f # see the eccode docs', rev, 'allow');
  b('fp-grep-pattern', "grep -n 'e() {' scripts/x.sh && eccode status --brief", rev, 'allow', 'a quoted grep pattern is walked as a nested command');
  b('fp-grep-pattern-dq', 'grep -n "run()" lib/x.js; eccode status --brief', rev, 'allow', 'run() with no body opener');
  b('fp-node-e-arrow', 'node -e "const f = (x) => x; console.log(f(1))" && eccode status --brief', rev, 'allow', 'JS arrow, no NAME()');
  b('fp-node-e-call', 'node -e "console.log(require(\'./lib/x\').run())" && eccode status --brief', rev, 'allow', 'run() followed by ) not a body');
  b('fp-evidence-run-fn', "eccode evidence run --actor backend-engineer --label t -- 'f() { npm test; }; f'", 'backend-engineer', 'allow', 'now denied by design? a function that never calls the CLI');
  b('fp-subshell-group', '(cd src && npm test) && eccode status --brief', rev, 'allow');
  b('fp-arith', 'n=$((1+2)); eccode status --brief', rev, 'allow');
  b('fp-if-then', 'if eccode status --brief; then echo ok; fi', rev, 'allow');
  b('fp-for', 'for f in a b; do echo $f; done; eccode status --brief', rev, 'allow');
  b('fp-case', 'case $x in a) echo a;; esac; eccode status --brief', rev, 'allow', '`a)` is not NAME()');
  b('fp-awk', "awk 'function f(x) { return x } { print f($1) }' data.txt; eccode status --brief", rev, 'allow', 'an awk function inside quotes');
  b('fp-sed', "sed -n 's/x()/y()/' a.txt; eccode status --brief", rev, 'allow');
}

// ------------------------------------------------------------- D. computed-name assignments (NEW-9) after 80ddab0
section = 'ENV2';
{
  const ctx = tmpProject();
  cleanup.push(ctx.dir);
  const ld = 'learning-debugger';
  const b = (id, command, role, expect, note) => probe(id, { cwd: ctx.dir, command, role, expect, note });
  const tail = 'eccode memory search race --actor learning-debugger';
  b('indirect-export-eq', `V=ECCODE_SHARED_MEMORY; export $V=/tmp/x; ${tail}`, ld, 'deny');
  b('indirect-declare-eq', `V=ECCODE_SHARED_MEMORY; declare -x "$V"=/tmp/x; ${tail}`, ld, 'deny');
  b('indirect-printf-v-export', `N=ECCODE_SHARED_MEMORY; printf -v "$N" /tmp/x; export "$N"; ${tail}`, ld, 'deny', 'bash sets and exports ECCODE_SHARED_MEMORY (bashsem)');
  b('indirect-nameref', `declare -n ref=ECCODE_SHARED_MEMORY; ref=/tmp/x; export ref; ${tail}`, ld, 'deny', 'nameref export (bashsem: exported)');
  b('indirect-read', `read -r N <<< ECCODE_SHARED_MEMORY; export "$N"=/tmp/x; ${tail}`, ld, 'deny');
  b('indirect-eval-concat', `X=ECCODE_SHARED; eval "export \${X}_MEMORY=/tmp/x"; ${tail}`, ld, 'deny');
  b('indirect-env-dynamic', `V=ECCODE_SHARED_MEMORY; env "$V=/tmp/x" ${tail}`, ld, 'deny');
  b('split-name-alone', "export ECC''ODE_SHARED_MEMORY=/tmp/x", ld, 'deny', 'tokenized words now carry ECCODE_');
  b('split-name-with-cli', `export ECC''ODE_SHARED_MEMORY=/tmp/x; ${tail}`, ld, 'deny');
  b('hooks-off-split', "export ECCODE_HO''OKS=off", null, 'deny');
  b('fp-dynamic-unrelated', `OUT=$(date +%s); ${tail}`, ld, 'allow', 'a computed VALUE is fine');
  b('fp-dynamic-unrelated-export', `export OUT="$HOME/x"; ${tail}`, ld, 'allow');
  b('fp-local-in-fn-free-line', 'local x=$y; eccode status --brief', ld, 'allow', 'computed value, literal name');
  b('fp-env-literal', `env FOO="$BAR" ${tail}`, ld, 'allow', 'literal name, computed value through env');
  b('fp-assign-prefix-literal', `FOO=$BAR ${tail}`, ld, 'allow');
}

// ------------------------------------------------------------- report
const failures = results.filter((r) => !r.ok);
const lines = [];
lines.push(`# Re-review probes against ${GUARD}`);
lines.push(`# node ${process.version}; ${results.length} probes; ${failures.length} mismatches with the reviewer's expectation`);
lines.push('');
lines.push('section | id | role | tool | decision | expect | ok | note | reason');
for (const r of results) lines.push([r.section, r.id, r.role, r.tool, r.decision, r.expect, r.ok ? 'ok' : 'MISMATCH', r.note, r.reason.replace(/\s+/g, ' ')].join(' | '));
lines.push('');
lines.push('## Inputs');
for (const r of results) lines.push(`${r.section}/${r.id}: ${JSON.stringify(r.input)}`);
fs.writeFileSync(path.join(__dirname, 'results2.txt'), lines.join('\n') + '\n');
process.stdout.write(lines.slice(0, 4 + results.length).join('\n') + '\n');
for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
