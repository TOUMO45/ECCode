'use strict';
// S3 separation proof (1): a failing read of the engine-held hidden-suite directory from INSIDE a group sandbox.
// Uses the engine's own sandbox.argv(...) (the runner's construction), Landlock (the strongest usable mode here).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sandbox = require('/home/user/ECCode/lib/greenfield/sandbox.js');

const HIDDEN = '/root/.cache/eccode-gf-hidden';
const CANARY = path.join(HIDDEN, 'canary.txt');
const SHIM = '/root/.cache/eccode-gf-shim/gf-python';
const SP = '/tmp/claude-0/-home-user-ECCode/66578369-ac2a-5898-b348-1bfebbc536c0/scratchpad';
const tree = fs.mkdtempSync(path.join(SP, 'proof-tree-'));
fs.mkdirSync(path.join(tree, 'own'));
const tmp = fs.mkdtempSync(path.join(SP, 'proof-tmp-'));

function inside(label, pyEnv, script) {
  if (pyEnv) process.env.ECCODE_GF_PYTHON = pyEnv; else delete process.env.ECCODE_GF_PYTHON;
  sandbox._reset && sandbox._reset();
  const pr = sandbox.probe({ fresh: true });
  const mechanism = pr.mechanisms[0];
  const a = sandbox.argv(mechanism, { cwd: tree, rw: [path.join(tree, 'own')], tmp, net: false, probe: pr }, ['sh', '-c', script]);
  const env = sandbox.scrubEnv(process.env, { tmp, project: tree });
  const r = spawnSync(a[0], a.slice(1), { cwd: tree, encoding: 'utf8', timeout: 30000, env });
  return { label, mechanism, interpreter: pyEnv || 'python3 (stock)', exit: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim().split('\n').slice(0, 3).join(' | ') };
}

const out = { takenAt: new Date().toISOString(), host: { kernel: os.release(), uid: process.getuid() }, hiddenDir: HIDDEN, rows: [] };
const hostRead = fs.readFileSync(CANARY, 'utf8').trim();
out.rows.push({ label: 'H0 engine (host namespace) reads the canary', ok: hostRead.startsWith('HIDDEN-CANARY-'), value: hostRead });

out.rows.push(inside('S1 BASELINE stock engine: cat hidden canary inside the group sandbox', null, `cat ${CANARY}; echo "cat-exit=$?"`));
out.rows.push(inside('S2 WITH SHIM: cat hidden canary inside the group sandbox', SHIM, `cat ${CANARY}; echo "cat-exit=$?"`));
out.rows.push(inside('S3 WITH SHIM: list hidden dir inside the group sandbox', SHIM, `ls -A ${HIDDEN} | wc -l; echo "ls-exit=$?"`));
out.rows.push(inside('S4 WITH SHIM control: read an ordinary file + write own/ still work', SHIM, `head -c 20 /etc/hostname >/dev/null && echo read-ok; echo x > own/f && echo write-own-ok; (echo x > ${HIDDEN}/new 2>&1 && echo WROTE-HIDDEN) || echo hidden-write-denied`));
out.rows.push(inside('S5 WITH SHIM attack: umount / re-bind the mask, then read', SHIM, `umount ${HIDDEN} 2>&1; echo "umount-exit=$?"; mount --bind /proc ${HIDDEN} 2>&1; echo "bind-exit=$?"; cat ${CANARY} 2>&1; echo "cat-exit=$?"`));
out.rows.push(inside('S6 WITH SHIM attack: read via /proc/1/root and the parent mount ns', SHIM, `cat /proc/1/root${CANARY} 2>&1; echo "cat-exit=$?"; ls /proc/1/ns 2>&1 | head -2`));
const hostAfter = fs.readFileSync(CANARY, 'utf8').trim();
out.rows.push({ label: 'H1 engine (host namespace) STILL reads the canary after all sandbox runs', ok: hostAfter === hostRead });
const mounts = spawnSync('sh', ['-c', `grep -c gf-hidden-mask /proc/self/mountinfo || true`], { encoding: 'utf8' }).stdout.trim();
out.rows.push({ label: 'H2 no gf-hidden-mask mount leaked into the host namespace', ok: mounts === '0', maskMountsInHostMountinfo: mounts });
delete process.env.ECCODE_GF_PYTHON;
const file = process.argv[2];
if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
for (const r of out.rows) console.log(JSON.stringify(r));
fs.rmSync(tree, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
