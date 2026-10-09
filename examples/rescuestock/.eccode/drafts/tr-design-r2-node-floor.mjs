// technical-reviewer check (design gate, revision 2, NFR1 / F-TR-4): take the "start" script line verbatim from the
// spec's Testing Strategy > Commands block, build a throwaway package with a flag-free ES5 scripts/check-node.cjs
// as the spec describes it, and run the exact line through /bin/sh and through `npm run start` with Node 20.20,
// 21.7 and 22.22 first on PATH; then the same for the Q9 = 22.5 branch (`--experimental-sqlite` after the second
// `node`). Also asserts every flagged script in the block starts with the flag-free gate.
// Usage: node tr-design-r2-node-floor.mjs <spec.md>.  Exit 0 = every run behaved as NFR1 requires.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const spec = readFileSync(process.argv[2], 'utf8');
const block = spec.slice(spec.indexOf('**Commands (`package.json`'), spec.indexOf('Every script that passes a version-specific flag'));
const scripts = JSON.parse(block.slice(block.indexOf('{'), block.lastIndexOf('}') + 1));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`); };
for (const [k, v] of Object.entries(scripts)) {
  if (/node --|node scripts\/(?!check-node)/.test(v) && /--/.test(v)) check(`script "${k}" starts with the flag-free gate`, v.startsWith('node scripts/check-node.cjs && '), v.slice(0, 70));
}
const startLine = scripts.start;
const branch225 = startLine.replace('&& node --disable-warning', '&& node --experimental-sqlite --disable-warning');

const dir = mkdtempSync(join(tmpdir(), 'tr-r2-floor-'));
mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'src'));
writeFileSync(join(dir, 'scripts', 'check-node.cjs'), [
  "'use strict';",
  "var floor = (process.env.TR_FLOOR || '22.13').split('.');",
  "var v = process.versions.node.split('.');",
  "var M = parseInt(v[0], 10), m = parseInt(v[1], 10), FM = parseInt(floor[0], 10), Fm = parseInt(floor[1], 10);",
  "if (M < FM || (M === FM && m < Fm)) { process.stderr.write('RescueStock needs Node >= ' + floor.join('.') + ' (found ' + process.versions.node + '). See README.\\n'); process.exit(1); }",
  ''].join('\n'));
writeFileSync(join(dir, 'src', 'index.js'), "console.log('started on ' + process.version);\n");
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tr-floor', private: true, type: 'module', scripts: { start: startLine, start225: branch225 } }, null, 1));

for (const bin of ['/opt/node20/bin/node', '/opt/node21/bin/node', process.execPath]) {
  if (!existsSync(bin)) continue;
  const env = { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH}`, NODE_OPTIONS: '' };
  const ver = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const old = !/^v22\.(1[3-9]|[2-9]\d)/.test(ver);
  for (const [label, line, floorEnv] of [['>=22.13 start', startLine, '22.13'], ['22.5-branch start', branch225, '22.5']]) {
    const r = spawnSync('/bin/sh', ['-c', line], { cwd: dir, encoding: 'utf8', env: { ...env, TR_FLOOR: floorEnv } });
    const out = (r.stderr + r.stdout).trim().split('\n')[0];
    const oldFor = floorEnv === '22.13' ? old : !/^v22\./.test(ver);
    const ok = oldFor ? (r.status !== 0 && /needs Node >= /.test(out)) : (r.status === 0 && /started on/.test(out));
    check(`${ver} sh -c ${label}`, ok, `exit=${r.status} ${out}`);
  }
  const npm = join(dirname(bin), 'npm');
  if (existsSync(npm)) {
    const r = spawnSync(npm, ['run', '--silent', 'start'], { cwd: dir, encoding: 'utf8', env: { ...env, TR_FLOOR: '22.13' } });
    const out = (r.stderr + r.stdout).trim().split('\n').filter((l) => !/^npm (warn|notice)/i.test(l))[0] || '';
    const ok = old ? (r.status !== 0 && /needs Node >= 22\.13/.test(out)) : (r.status === 0 && /started on/.test(out));
    check(`${ver} npm run start`, ok, `exit=${r.status} ${out}`);
  }
}
console.log(`start line taken from the spec: ${startLine}`);
console.log(`failures: ${fails}`);
process.exit(fails ? 1 : 0);
