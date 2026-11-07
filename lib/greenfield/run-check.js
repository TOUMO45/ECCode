'use strict';
// GF-RUN-2's before-and-after comparison (design 18.4, round 6). The runner has the frozen evidence runner execute this
// wrapper around the command. It lists the files that differ from HEAD and the untracked files that are not ignored,
// each by content; runs the command; lists them again; and fails the run (exit 99) when any file outside the caller's
// group changed, whoever claims it. The failure is therefore the recorded result. The frozen integrity window applies
// on top. Usage: node run-check.js <spec.json> -- <program> <args...>, where spec is {group, role, map, result}.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ownership = require('./ownership');

// The tools' own caches and result folders are not compared (design 18.4).
const CACHE = /(^|\/)(\.pytest_cache|__pycache__|\.ruff_cache|\.mypy_cache|test-results|playwright-report|htmlcov)(\/|$)|(^|\/)\.coverage$|\.pyc$/;
module.exports = { CACHE };
if (require.main !== module) return;

const [specFile, sep, ...argv] = process.argv.slice(2);
if (sep !== '--' || !argv.length) { process.stderr.write('usage: run-check.js <spec.json> -- <command...>\n'); process.exit(64); }
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const root = process.cwd();
const git = (args) => spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const hash = (rel) => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex'); } catch { return 'missing'; } };
function snapshot() {
  const tracked = git(['diff', 'HEAD', '--name-only', '-z']);
  const others = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (tracked.status !== 0 || others.status !== 0) return null;
  const out = new Map();
  for (const rel of [...tracked.stdout.split('\0'), ...others.stdout.split('\0')]) if (rel && !rel.startsWith('.eccode/') && !CACHE.test(rel)) out.set(rel, hash(rel));
  return out;
}
const before = snapshot();
const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
const after = snapshot();
let outside = null;
if (before && after) {
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
  outside = changed.filter((p) => !spec.group || !spec.map || ownership.ownerOfPath(spec.map, p) !== spec.group);
}
fs.writeFileSync(spec.result, JSON.stringify({ outside }));
if (outside === null) { process.stderr.write('[gf-run] GF-RUN-2: git could not list the files before and after the run, so the run fails\n'); process.exit(99); }
if (outside.length) {
  process.stderr.write(`[gf-run] GF-RUN-2: the run changed ${outside.join(', ')}, outside ${spec.group ? `${spec.group}'s paths` : `any group's paths (${spec.role} is in no group)`}: the run fails\n`);
  process.exit(99);
}
process.exit(typeof r.status === 'number' ? r.status : (r.error && r.error.code === 'ENOENT' ? 127 : 1));
