'use strict';
const H = require('./harness');

// A-24: nested git pointed at the common git dir / another worktree; A-25: alternate object dir into the shared store.
// All target paths are outside the group's worktree write set, so the kernel must refuse every write.
(function A24_A25() {
  const ctx = H.project('python3 app/seed.py');
  H.put(ctx, 'app/seed.py', [
    'import subprocess, os, pathlib',
    'env=dict(os.environ)',
    'gc=subprocess.run(["git","rev-parse","--git-common-dir"],capture_output=True,text=True).stdout.strip()',
    'res=[]',
    '# A-25: try to write an object into the shared store via GIT_OBJECT_DIRECTORY aimed at the common objects dir',
    'env2=dict(env); env2["GIT_OBJECT_DIRECTORY"]=os.path.join(gc,"objects") if gc else ".git/objects"',
    'p=subprocess.run(["git","hash-object","-w","--stdin"],input=b"evil",capture_output=True,env=env2)',
    'res.append("hash-object rc="+str(p.returncode)+" err="+p.stderr.decode().strip().split(chr(10))[-1][:80])',
    '# A-24: write a .git gitfile redirecting GIT_DIR, then try to commit into it',
    'os.makedirs("app/x",exist_ok=True); pathlib.Path("app/x/.git").write_text("gitdir: "+(gc or ".git")+"\\n")',
    'q=subprocess.run(["git","-C","app/x","commit","--allow-empty","-m","x"],capture_output=True,text=True)',
    'res.append("nested-commit rc="+str(q.returncode)+" err="+q.stderr.strip().split(chr(10))[-1][:80])',
    'pathlib.Path("app/ok.txt").write_text("own")',
    'print(" || ".join(res))',
  ].join('\n'));
  H.commitAll(ctx, 'seed');
  H.F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/seed.py', reason: 're-pin', from: ['app/main.py'] });
  const before = H.git(ctx.dir, 'rev-parse', 'HEAD');
  const r = H.run(ctx, 'python3 app/seed.py', 'backend-engineer');
  console.log('[A-24/A-25] mech=' + r.isolation.mechanism + ' status=' + r.status);
  console.log('   ' + (r.outputTail || '').replace(/\n/g, ' ').slice(0, 400));
  console.log('   HEAD moved? ' + (H.git(ctx.dir, 'rev-parse', 'HEAD') !== before) + ' (expect false)');
  // did any new loose object appear in the real common store? (hard to see; the write itself must be refused)
})();
