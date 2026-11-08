'use strict';
// Probe the in-model kernel-blocked rows: A-5 hardlink into real tree, A-6 hardlink into .git, A-17 /dev raw device,
// A-9/A-10 /proc magic symlinks, A-35 rename into another group. Each run forces BOTH mechanisms in turn by config.
const H = require('./harness');
const fs = require('fs');
const path = require('path');

function trial(name, code, checkReal) {
  const ctx = H.project('python3 app/seed.py');
  H.put(ctx, 'app/seed.py', code);
  H.commitAll(ctx, 'seed');
  H.F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'python3 app/seed.py', reason: 're-pin', from: ['app/main.py'] });
  let r;
  try { r = H.run(ctx, 'python3 app/seed.py'); } catch (e) { console.log(`[${name}] threw: ${e.message}`); return; }
  const real = checkReal(ctx);
  console.log(`[${name}] status=${r.status} copiedBack=${JSON.stringify(r.copiedBack)} tail=${(r.outputTail||'').replace(/\n/g,' | ').slice(0,300)}`);
  console.log(`         REAL-TREE EFFECT: ${real}`);
}

// A-5: hardlink own path to a file in the REAL tree, write through.
trial('A-5 hardlink->realtree', [
  'import os, pathlib',
  'real = os.path.realpath(os.path.join(os.getcwd(), "..", "..", "web", "index.html"))',
  'res=[]',
  'try:',
  '    os.link(real, "app/hl"); res.append("LINKED")',
  '    open("app/hl","a").write("BACKDOOR"); res.append("WROTE")',
  'except OSError as e: res.append("link-refused:"+e.strerror)',
  'pathlib.Path("app/ok.txt").write_text("own")',
  'print(" ".join(res))',
].join('\n'), (ctx) => `web/index.html = ${JSON.stringify(H.read(ctx,'web/index.html'))}`);

// A-6: hardlink own path to the common .git/HEAD, write through.
trial('A-6 hardlink->.git/HEAD', [
  'import subprocess, pathlib, os',
  'gd = subprocess.run(["git","rev-parse","--git-common-dir"],capture_output=True,text=True).stdout.strip()',
  'res=[]',
  'try:',
  '    src = os.path.join(gd,"HEAD") if gd else ".git/HEAD"',
  '    os.link(src, "app/hl"); res.append("LINKED")',
  '    open("app/hl","w").write("ref: refs/heads/evil\\n"); res.append("WROTE")',
  'except OSError as e: res.append("refused:"+e.strerror)',
  'pathlib.Path("app/ok.txt").write_text("own")',
  'print(" ".join(res))',
].join('\n'), (ctx) => `real .git HEAD = ${(()=>{try{return H.git(ctx.dir,'rev-parse','--symbolic-full-name','HEAD');}catch(e){return 'err';}})()}`);

// A-17: raw block-device write via /dev. Is /dev/sda present/writable? mknod a device?
trial('A-17 /dev block device', [
  'import os, pathlib, glob',
  'res=[]',
  'devs = glob.glob("/dev/sd*") + glob.glob("/dev/vd*") + glob.glob("/dev/nvme*n1")',
  'res.append("devs="+str(devs))',
  'for d in devs[:1]:',
  '    try:',
  '        fd=os.open(d, os.O_WRONLY); os.write(fd, b"\\x00"*512); os.close(fd); res.append("WROTE:"+d)',
  '    except OSError as e: res.append("dev-refused:"+e.strerror)',
  'try:',
  '    os.mknod("app/blk", 0o600 | 0o60000, os.makedev(8,0)); res.append("MKNOD-ok")',
  'except OSError as e: res.append("mknod-refused:"+e.strerror)',
  'pathlib.Path("app/ok.txt").write_text("own")',
  'print(" ".join(res))',
].join('\n'), () => 'n/a (device-level)');

// A-9 / A-10: /proc/self/cwd and /proc/self/root path escapes.
trial('A-9/A-10 proc escapes', [
  'import pathlib, os',
  'res=[]',
  'for label,p in [("cwd","/proc/self/cwd/../../web/pwn9"),("root","/proc/self/root"+os.path.realpath(os.path.join(os.getcwd(),"..","..","web"))+"/pwn10")]:',
  '    try: pathlib.Path(p).write_text("x"); res.append(label+":WROTE")',
  '    except OSError as e: res.append(label+":"+e.strerror)',
  'pathlib.Path("app/ok.txt").write_text("own")',
  'print(" ".join(res))',
].join('\n'), (ctx) => `web/pwn9=${H.exists(ctx,'web/pwn9')} web/pwn10=${H.exists(ctx,'web/pwn10')}`);

// A-35: rename an own file into another group's area (TOCTOU-free single attempt).
trial('A-35 rename into web/', [
  'import os, pathlib',
  'res=[]',
  'pathlib.Path("app/mod.py").write_text("payload")',
  'try: os.rename("app/mod.py", "web/mod.py"); res.append("RENAMED")',
  'except OSError as e: res.append("rename-refused:"+e.strerror)',
  'pathlib.Path("app/ok.txt").write_text("own")',
  'print(" ".join(res))',
].join('\n'), (ctx) => `web/mod.py = ${H.exists(ctx,'web/mod.py')}`);
