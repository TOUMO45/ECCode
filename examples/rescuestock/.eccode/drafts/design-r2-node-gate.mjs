// Design probe (technical-designer, design rev 2, F-TR-4): does a flag-free gate placed BEFORE the flagged
// node invocation make the start command name the required version on older Node, for both Q9 branches?
// Builds a throwaway app dir (package.json "type":"module", scripts/check-node.cjs, src/index.js) and runs the
// exact start command strings through /bin/sh with PATH pointing at each Node binary present on this host.
// Exit 0 when: on every older Node (< floor) the command exits non-zero AND names the required version, and on
// the current Node (22.22) the >=22.13 command starts index.js (prints STARTED).
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rs-gate-'));
mkdirSync(join(dir, 'scripts'));
mkdirSync(join(dir, 'src'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', type: 'module', private: true }));
const gate = (maj, min) => [
  "'use strict';",
  '// Flag-free, ES5-only: must run on any Node that can start at all.',
  'var need = [' + maj + ', ' + min + '];',
  "var v = process.versions.node.split('.').map(Number);",
  'if (v[0] < need[0] || (v[0] === need[0] && v[1] < need[1])) {',
  "  console.error('RescueStock needs Node >= ' + need.join('.') + ' (found ' + process.versions.node + '). See README.');",
  '  process.exit(1);',
  '}',
].join('\n');
writeFileSync(join(dir, 'scripts', 'check-node-22.13.cjs'), gate(22, 13));
writeFileSync(join(dir, 'scripts', 'check-node-22.5.cjs'), gate(22, 5));
writeFileSync(join(dir, 'src', 'index.js'), "console.log('STARTED ' + process.versions.node);\n");

const commands = {
  '>=22.13 branch': 'node scripts/check-node-22.13.cjs && node --disable-warning=ExperimentalWarning src/index.js',
  '22.5 branch': 'node scripts/check-node-22.5.cjs && node --experimental-sqlite --disable-warning=ExperimentalWarning src/index.js',
};
let ok = true;
for (const bin of ['/opt/node20/bin/node', '/opt/node21/bin/node', process.execPath]) {
  if (!existsSync(bin)) continue;
  const ver = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const major = Number(ver.slice(1).split('.')[0]);
  for (const [label, cmd] of Object.entries(commands)) {
    const r = spawnSync('/bin/sh', ['-c', cmd], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: dirname(bin) + ':' + process.env.PATH, NODE_OPTIONS: '' },
    });
    const out = (r.stderr + r.stdout).trim().split('\n')[0];
    const named = /needs Node >= 22\.(13|5) \(found/.test(out);
    const started = /^STARTED/.test(out);
    let verdict;
    if (major < 22) verdict = r.status !== 0 && named;
    else verdict = label === '>=22.13 branch' ? (r.status === 0 && started) : true; // 22.5 branch on 22.22: flag accepted
    if (!verdict) ok = false;
    console.log(`${ver} ${label}: exit=${r.status} namesRequiredVersion=${named} started=${started} ${verdict ? 'OK' : 'FAIL'} | ${out}`);
  }
}
console.log(ok ? 'gate-before-flags confirmed' : 'gate-before-flags NOT confirmed');
process.exit(ok ? 0 : 1);
