// Security probe, phase B supply chain (security-reviewer): runtime dependencies, devDependency pinning, install-time
// scripts in package.json, the lockfile, and the published dependency tree of @playwright/test 1.56.1 (npm view, read-only).
// Usage: node .eccode/drafts/sec-phb-supply-chain.mjs
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const failures = [];
const expect = (cond, label, info = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${info ? ` | ${info}` : ''}`);
  if (!cond) failures.push(label);
};

expect(!pkg.dependencies && !pkg.optionalDependencies && !pkg.peerDependencies && !pkg.bundleDependencies, 'no runtime, optional, peer or bundled dependencies');
const dev = Object.entries(pkg.devDependencies || {});
expect(dev.length === 1 && dev[0][0] === '@playwright/test' && /^\d+\.\d+\.\d+$/.test(dev[0][1]), 'one devDependency, pinned to an exact version', JSON.stringify(pkg.devDependencies));
const installHooks = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare', 'dependencies'].filter((s) => pkg.scripts && pkg.scripts[s]);
expect(installHooks.length === 0, 'no install-time lifecycle scripts in package.json', installHooks.join(','));
expect(pkg.private === true, 'private: true (no accidental publish)');
const lock = ['package-lock.json', 'npm-shrinkwrap.json'].filter((f) => existsSync(join(ROOT, f)));
console.log(`info lockfile present: ${lock.length ? lock.join(',') : 'none (npm install resolves from the registry without integrity pins)'}`);

let tree = 'not checked';
try {
  const view = (spec) => JSON.parse(execFileSync('npm', ['view', spec, 'dependencies', 'optionalDependencies', 'scripts', '--json'], { encoding: 'utf8', timeout: 60000 }) || '{}');
  const a = view('@playwright/test@1.56.1');
  const b = view('playwright@1.56.1');
  const c = view('playwright-core@1.56.1');
  const scripts = [a, b, c].map((x) => Object.keys(x.scripts || {}).filter((s) => /install|prepare/.test(s)));
  tree = `@playwright/test -> ${JSON.stringify(a.dependencies)}; playwright -> ${JSON.stringify(b.dependencies)} optional ${JSON.stringify(b.optionalDependencies)}; playwright-core -> ${JSON.stringify(c.dependencies || {})}`;
  expect(scripts.every((s) => s.length === 0), 'no install scripts in the published @playwright/test, playwright, playwright-core 1.56.1', JSON.stringify(scripts));
  const exact = Object.values({ ...(a.dependencies || {}), ...(b.dependencies || {}), ...(b.optionalDependencies || {}), ...(c.dependencies || {}) }).every((v) => /^\d+\.\d+\.\d+$/.test(v));
  expect(exact, 'every transitive dependency is pinned exactly by its parent');
} catch (e) {
  console.log(`info npm view unavailable (${e.code || e.message}); registry tree not checked`);
}
console.log(`info ${tree}`);
console.log(failures.length === 0 ? '\nSUPPLY-CHAIN EXPECTATIONS HELD' : `\n${failures.length} FAILED`);
process.exitCode = failures.length === 0 ? 0 : 1;
