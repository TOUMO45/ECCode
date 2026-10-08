#!/usr/bin/env node
'use strict';
// Export clean copies of both toolkits for trials, so a trial session can
// never read the evaluation suite, the graders or the development history.
//   eccode/  plugin files of this repository at HEAD (git archive, so only committed content)
//   ecc/     affaan-m/ECC at the pinned commit (git archive of a clone)
// Writes <out>/toolkits.json with both commit ids.
//   node eval/harness/export-toolkits.js --out <dir> --ecc-clone <path>
//   node eval/harness/export-toolkits.js --out <dir> --reuse-ecc <earlier export dir>   (same baseline bytes, new ECCode export)

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

/**
 * Comparable models: both toolkits pin some agents/skills to other models in
 * their frontmatter (ECCode: opus reviewers; ECC: opus and haiku agents), which
 * CLAUDE_CODE_SUBAGENT_MODEL does not override. For the evaluation every pin is
 * rewritten to `inherit`, so all agents run on the evaluation model. Nothing
 * else in either toolkit is changed. Returns the list of rewritten files.
 */
function normalizeModels(dir) {
  const changed = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') walk(p);
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      const text = fs.readFileSync(p, 'utf8');
      const m = /^---\n([\s\S]*?)\n---/.exec(text);
      if (!m || !/^model:\s*\S/m.test(m[1])) continue;
      const fm = m[1].replace(/^model:\s*.*$/m, 'model: inherit');
      if (fm === m[1]) continue;
      fs.writeFileSync(p, `---\n${fm}\n---${text.slice(m[0].length)}`);
      changed.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return changed;
}

const out = path.resolve(arg('out') || 'eval-run/toolkits');
const reuseEcc = arg('reuse-ecc') ? path.resolve(arg('reuse-ecc')) : null;
const eccClone = reuseEcc ? null : path.resolve(arg('ecc-clone'));
const repoRoot = path.join(__dirname, '..', '..');
const eccodeCommit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', ...ECCODE_PATHS], { encoding: 'utf8' }).trim();
archive(repoRoot, eccodeCommit, path.join(out, 'eccode'), ECCODE_PATHS);
let eccHead;
let eccNormalized;
if (reuseEcc) {
  // The baseline is byte-for-byte the earlier, already normalized export.
  const earlier = JSON.parse(fs.readFileSync(path.join(reuseEcc, 'toolkits.json'), 'utf8'));
  eccHead = earlier.ecc.commit;
  fs.rmSync(path.join(out, 'ecc'), { recursive: true, force: true });
  fs.cpSync(path.join(reuseEcc, 'ecc'), path.join(out, 'ecc'), { recursive: true });
  eccNormalized = JSON.parse(fs.readFileSync(path.join(reuseEcc, 'normalized-files.json'), 'utf8')).ecc;
} else {
  eccHead = execFileSync('git', ['-C', eccClone, 'rev-parse', ECC_COMMIT], { encoding: 'utf8' }).trim();
  archive(eccClone, eccHead, path.join(out, 'ecc'));
  eccNormalized = normalizeModels(path.join(out, 'ecc'));
}
const normalized = { eccode: normalizeModels(path.join(out, 'eccode')), ecc: eccNormalized };
const meta = { eccode: { commit: eccodeCommit, uncommittedToolkitChanges: Boolean(dirty), modelPinsNormalized: normalized.eccode.length }, ecc: { repo: 'https://github.com/affaan-m/ECC', commit: eccHead, modelPinsNormalized: normalized.ecc.length }, normalization: 'frontmatter model: pins rewritten to inherit in both toolkits', exportedAt: new Date().toISOString() };
fs.writeFileSync(path.join(out, 'normalized-files.json'), JSON.stringify(normalized, null, 2));
fs.writeFileSync(path.join(out, 'toolkits.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta));
if (dirty) console.error('WARNING: toolkit files have uncommitted changes; the export uses HEAD only.');
