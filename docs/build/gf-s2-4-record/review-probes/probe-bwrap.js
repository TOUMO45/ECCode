'use strict';
// Directly exercise the bwrap mechanism argv (sandbox.argv) since gf_run picks landlock on this machine unless a
// carve-out forces bwrap. Build a scratch "worktree" with own/ writable, a sibling real tree web/, run the in-model rows.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const ROOT = '/tmp/claude-0/-home-user-ECCode/7061a3fb-d3e3-516a-8100-3a4a8e46689a/scratchpad/review-s24';
const sandbox = require(path.join(ROOT, 'lib/greenfield/sandbox'));
const pr = sandbox.probe();

function trial(mech, name, script) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bwprobe-'));
  const wt = path.join(base, 'wt');            // the "worktree" (cwd)
  const own = path.join(wt, 'app');            // writable
  const web = path.join(wt, 'web');            // sibling, read-only (another group)
  const realweb = path.join(base, 'realtree-web'); // stands in for the REAL tree outside the worktree
  fs.mkdirSync(own, { recursive: true }); fs.mkdirSync(web, { recursive: true }); fs.mkdirSync(realweb, { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), 'KEEP');
  fs.writeFileSync(path.join(realweb, 'app.py'), 'KEEP');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwprobe-tmp-'));
  const argv = sandbox.argv(mech, { cwd: wt, rw: [own], tmp, net: false, probe: pr }, ['sh', '-c', script.replace('$REALWEB', realweb)]);
  const env = sandbox.scrubEnv(process.env, { tmp, project: base });
  const r = spawnSync(argv[0], argv.slice(1), { cwd: wt, encoding: 'utf8', timeout: 30000, env });
  const webUnchanged = fs.readFileSync(path.join(web, 'index.html'), 'utf8') === 'KEEP';
  const realUnchanged = fs.readFileSync(path.join(realweb, 'app.py'), 'utf8') === 'KEEP';
  console.log(`[${mech}][${name}] exit=${r.status} out=${(r.stdout||'').trim().replace(/\n/g,' | ')} err=${(r.stderr||'').trim().split('\n').pop()}`);
  console.log(`        web(sibling) unchanged=${webUnchanged}  realtree unchanged=${realUnchanged}`);
  fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
}

const rows = {
  'A-2 symlink->sibling web': 'r=0; ln -s ../web app/esc 2>/dev/null; (echo x > app/esc/handler.py) 2>&1 && r=1; echo "wrote=$r"',
  'A-5 hardlink->realtree': 'ln $REALWEB/app.py app/hl 2>&1; echo "---"; (printf BACKDOOR >> app/hl) 2>&1; echo done',
  'A-9 proc cwd escape': '(printf x > /proc/self/cwd/../web/pwn) 2>&1; echo done',
  'A-10 proc root escape': '(printf x > /proc/self/root'+'$REALWEB/pwn) 2>&1; echo done',
  'A-17 /dev block device': 'ls /dev/sd* /dev/vd* 2>/dev/null | head; (mknod app/blk b 8 0) 2>&1; echo done',
  'A-23 git commit in worktree': 'cd app 2>/dev/null; (echo x > ../web/x) 2>&1; echo done',
};
for (const [name, script] of Object.entries(rows)) {
  if (pr.bwrap) trial('bwrap', name, script);
}
