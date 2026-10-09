// technical-reviewer helper: print the heading slugs of a Markdown file (same rule as lib/evidence.js slug()).
import { readFileSync } from 'node:fs';
const slug = (t) => String(t).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
for (const l of readFileSync(process.argv[2], 'utf8').split('\n')) if (/^#{1,6}\s/.test(l)) console.log(slug(l.replace(/^#+\s*/, '')));
