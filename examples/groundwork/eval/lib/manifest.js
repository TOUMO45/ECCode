// Holdout manifest check (spec 8.5). sha256sum format: "<hex>  <relative path>".
// Only hashes file bytes; the runner never parses holdout files outside a holdout run.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/** @returns {{ok:boolean, problems:string[], manifestHash:string|null}} */
export function checkManifest(holdoutDir) {
  const problems = [];
  const mpath = path.join(holdoutDir, 'MANIFEST.sha256');
  if (!fs.existsSync(holdoutDir) || !fs.existsSync(mpath)) {
    return { ok: false, problems: ['holdout directory or MANIFEST.sha256 missing'], manifestHash: null };
  }
  const raw = fs.readFileSync(mpath);
  const listed = new Map();
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) { problems.push(`malformed manifest line: ${line.slice(0, 60)}`); continue; }
    listed.set(m[2], m[1]);
  }
  const actual = new Set(walk(holdoutDir).filter((f) => f !== 'MANIFEST.sha256'));
  for (const [f, h] of listed) {
    if (!actual.has(f)) problems.push(`missing file: ${f}`);
    else if (sha(fs.readFileSync(path.join(holdoutDir, f))) !== h) problems.push(`changed file: ${f}`);
  }
  for (const f of actual) if (!listed.has(f)) problems.push(`extra file: ${f}`);
  return { ok: problems.length === 0, problems, manifestHash: sha(raw) };
}
