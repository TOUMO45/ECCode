#!/usr/bin/env node
'use strict';
// Export clean copies of both toolkits for trials, so a trial session can
// never read the evaluation suite, the graders or the development history.
//   eccode/  plugin files of this repository at HEAD (git archive, so only committed content)
//   ecc/     affaan-m/ECC at the pinned commit (git archive of a clone)
// Writes <out>/toolkits.json with both commit ids.
//   node eval/harness/export-toolkits.js --out <dir> --ecc-clone <path>

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ECC_COMMIT = 'ef648e01899ba3e8dc6371642deaaf64b4477775';
const ECCODE_PATHS = ['.claude-plugin', 'agents', 'skills', 'commands', 'hooks', 'scripts', 'bin', 'lib', 'schemas', 'templates', 'package.json', 'LICENSE', 'NOTICE', 'README.md'];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

function archive(repo, ref, dest, paths = []) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tar = execFileSync('git', ['-C', repo, 'archive', '--format=tar', ref, ...paths], { maxBuffer: 1024 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dest], { input: tar });
}

const out = path.resolve(arg('out') || 'eval-run/toolkits');
const eccClone = path.resolve(arg('ecc-clone'));
const repoRoot = path.join(__dirname, '..', '..');
const eccodeCommit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', ...ECCODE_PATHS], { encoding: 'utf8' }).trim();
archive(repoRoot, eccodeCommit, path.join(out, 'eccode'), ECCODE_PATHS);
const eccHead = execFileSync('git', ['-C', eccClone, 'rev-parse', ECC_COMMIT], { encoding: 'utf8' }).trim();
archive(eccClone, eccHead, path.join(out, 'ecc'));
const meta = { eccode: { commit: eccodeCommit, uncommittedToolkitChanges: Boolean(dirty) }, ecc: { repo: 'https://github.com/affaan-m/ECC', commit: eccHead }, exportedAt: new Date().toISOString() };
fs.writeFileSync(path.join(out, 'toolkits.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta));
if (dirty) console.error('WARNING: toolkit files have uncommitted changes; the export uses HEAD only.');
