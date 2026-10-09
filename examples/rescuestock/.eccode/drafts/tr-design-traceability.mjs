// technical-reviewer check (design gate): every brief acceptance criterion id appears exactly once in the
// spec's Criterion Traceability table and names a design section and at least one test file (hard: exit 1
// otherwise). Suite tags ([D], [B], [LM], [LP], [I]) that the brief requires but the row omits are REPORTED
// as warnings (they do not fail the check).
// Usage: node tr-design-traceability.mjs <brief.md> <spec.md>
import { readFileSync } from 'node:fs';

const [briefPath, specPath] = process.argv.slice(2);
const brief = readFileSync(briefPath, 'utf8').split('\n');
const spec = readFileSync(specPath, 'utf8').split('\n');

const TAG = /(?:^|[\s;,\[(])(D|B|LM|LP|I)(?=[\s:;,\])]|$)/g;
const tagsOf = (s) => new Set([...s.matchAll(TAG)].map((m) => m[1]));

const start = brief.findIndex((l) => l.startsWith('## Acceptance Criteria'));
const end = brief.findIndex((l, i) => i > start && l.startsWith('## '));
const briefIds = new Map();
for (const l of brief.slice(start, end)) {
  const m = l.match(/^- ((?:RS-\d{2})|(?:NFR\d))(?: \([^)]*\))?: (.*)$/);
  if (!m) continue;
  const brackets = [...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]).filter((b) => /\b(D|B|LM|LP|I)\b/.test(b));
  const tags = new Set();
  for (const b of brackets) for (const t of tagsOf('[' + b + ']')) tags.add(t);
  briefIds.set(m[1], tags);
}

const tStart = spec.findIndex((l) => l.startsWith('### Criterion Traceability'));
const rows = new Map();
for (const l of spec.slice(tStart + 1)) {
  if (l.startsWith('## ') || l.startsWith('Design-specific')) break;
  const m = l.match(/^\| ((?:RS-\d{2})|(?:NFR\d)) \| (.*?) \| (.*) \|$/);
  if (!m) continue;
  if (!rows.has(m[1])) rows.set(m[1], []);
  rows.get(m[1]).push({ section: m[2], test: m[3] });
}

let hard = 0, warn = 0;
const out = [];
for (const [id, need] of briefIds) {
  const r = rows.get(id);
  if (!r) { out.push(`${id}: MISSING from traceability`); hard++; continue; }
  if (r.length > 1) { out.push(`${id}: DUPLICATED (${r.length})`); hard++; }
  const { section, test } = r[0];
  const files = test.match(/`[^`]*(?:test|scripts)\/[^`]+`|planner-fixture|planner-oracle|isolation test|live variant|live \(LP\)/g) || [];
  const have = new Set();
  for (const m of test.matchAll(/\(([^)]*)\)/g)) for (const t of tagsOf('(' + m[1] + ')')) have.add(t);
  const missing = [...need].filter((t) => !have.has(t));
  if (!files.length || !section.trim()) hard++;
  if (missing.length) warn++;
  out.push(`${id}: section="${section.slice(0, 60)}" tests=${files.length} briefTags=[${[...need].join(',')}] specTags=[${[...have].join(',')}]` +
    (missing.length ? ` WARN_MISSING_TAGS=[${missing.join(',')}]` : '') + (files.length ? '' : ' NO_TEST_FILE') + (section.trim() ? '' : ' NO_SECTION'));
}
for (const id of rows.keys()) if (!briefIds.has(id)) { out.push(`${id}: in spec but not in brief`); hard++; }

console.log(out.join('\n'));
console.log(`brief ids: ${briefIds.size}; spec rows: ${rows.size}; hard problems: ${hard}; tag warnings: ${warn}`);
process.exit(briefIds.size === 45 && rows.size === 45 && hard === 0 ? 0 : 1);
