// technical-reviewer check (design gate, NFR1): what does the spec's start command do on an older Node?
// Spec: "npm start" = node --disable-warning=ExperimentalWarning src/index.js (>= 22.13 branch) and, for the
// Q9 = 22.5 branch, node --experimental-sqlite --disable-warning=ExperimentalWarning src/index.js.
// NFR1 requires: on an older Node, npm start exits non-zero WITH A MESSAGE NAMING THE REQUIRED VERSION.
// This script runs both command shapes on the older Node binaries present on this host, with a stand-in
// index.js that prints the spec's version-gate message, and checks the Node 20 changelog for the release
// that introduced --disable-warning. Exit 0 = every observation was obtained (the result lines say what held).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tr-node-floor-'));
const idx = join(dir, 'index.js');
writeFileSync(idx, "const [M,m]=process.versions.node.split('.').map(Number);\n" +
  "if (M<22||(M===22&&m<13)){console.error('RescueStock needs Node >= 22.13 (found '+process.versions.node+'). See README.');process.exit(1);}\n");

let obtained = 0;
for (const bin of ['/opt/node20/bin/node', '/opt/node21/bin/node', process.execPath]) {
  if (!existsSync(bin)) continue;
  const ver = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  for (const [label, args] of [['>=22.13 branch', ['--disable-warning=ExperimentalWarning', idx]],
                               ['22.5 branch', ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', idx]]]) {
    const r = spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    const msg = (r.stderr + r.stdout).trim().split('\n')[0];
    const namesVersion = /needs Node >= 22\.13/.test(msg);
    console.log(`${ver} ${label}: exit=${r.status} namesRequiredVersion=${namesVersion} | ${msg}`);
    obtained++;
  }
}
const cl = '/opt/node20/CHANGELOG.md';
if (existsSync(cl)) {
  const lines = readFileSync(cl, 'utf8').split('\n');
  const hit = lines.findIndex((l) => /add `--disable-warning` option/.test(l));
  let rel = null;
  for (let i = hit; i >= 0; i--) { const m = lines[i].match(/^## .*Version (20\.\d+\.\d+)/); if (m) { rel = m[1]; break; } }
  console.log(`Node 20 changelog: --disable-warning introduced in ${rel} (line ${hit + 1}); a Node 20 release before it, or Node 18, rejects the flag as a bad option before src/index.js runs`);
  obtained++;
}
process.exit(obtained >= 3 ? 0 : 1);
