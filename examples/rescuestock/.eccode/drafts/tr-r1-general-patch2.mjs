// technical-reviewer helper: in tr-r1-general.mjs G4, the first counted call deletes that user's expired rows (older
// than the window), so the right expectation is "11 general rows in the window after 11 calls", not "+11".
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/drafts/tr-r1-general.mjs';
const text = readFileSync(file, 'utf8');
const from = "planned(h, id) - p0 === 10 && general(h, id) - g0 === 11,\n      `G4 11 plan calls: ${statuses.join(',')}; plan rows +${planned(h, id) - p0}, general rows +${general(h, id) - g0}`);";
const to = "planned(h, id) - p0 === 10 && general(h, id) === 11,\n      `G4 11 plan calls: ${statuses.join(',')}; plan rows +${planned(h, id) - p0}; general rows in the window ${general(h, id)} (expired rows of earlier calls deleted: ${g0} before)`);";
if (!text.includes(from)) { console.error('pattern not found'); process.exit(1); }
writeFileSync(file, text.replace(from, to));
console.log('patched');
