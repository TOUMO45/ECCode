// technical-reviewer helper: corrects the lessons note in .eccode/reviews/drafts/phase-c-1.json (no guard refusal
// occurred during the phase-C review; the earlier ones were in phase B).
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/reviews/drafts/phase-c-1.json';
let text = readFileSync(file, 'utf8');
const from = ' The guard refusals I met this phase were raw-text over-denials of my own shell edits (see the report), not a wrong root.';
const to = ' The guard refused none of my writes during this review; every draft and probe went to the nested record\'s draft areas as expected.';
if (!text.includes(from)) { console.error('not found'); process.exit(1); }
text = text.split(from).join(to);
JSON.parse(text);
writeFileSync(file, text);
console.log('note corrected; JSON valid');
