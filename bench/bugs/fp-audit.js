// Precision audit: run the built-in bug rules over whole files of a corpus of
// real code and write every hit, for hand-labelling. Usage:
//   node bench/bugs/fp-audit.js <corpus-dir> <hits.json>
const bugs = require('../../lib/bugs');
const fs = require('fs');
const [dir, out] = process.argv.slice(2);
const t0 = Date.now();
const r = bugs.scan(dir, { all: true, external: false });
const byRule = {};
for (const f of r.findings) (byRule[f.rule] = byRule[f.rule] || []).push(f);
fs.writeFileSync(out, JSON.stringify(r.findings, null, 1));
console.log(`${dir}: ${r.files} files, ${r.lines} lines, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.findings.length} hits`);
for (const [k, v] of Object.entries(byRule).sort()) console.log(`  ${k}: ${v.length}`);
