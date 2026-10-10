// technical-reviewer helper: corrects three line anchors in .eccode/reviews/drafts/phase-c-1.json and validates the JSON.
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/reviews/drafts/phase-c-1.json';
let text = readFileSync(file, 'utf8');
const swaps = [
  ['artifact:src/app.js#L233-L240', 'artifact:src/app.js#L62-L69'],
  ['artifact:public/js/reserve-key.js#L24-L40', 'artifact:public/js/reserve-key.js#L23-L38'],
  ['artifact:src/services/orders.js#L427-L497', 'artifact:src/services/orders.js#L427-L494'],
];
for (const [from, to] of swaps) {
  if (!text.includes(from)) { console.error('not found: ' + from); process.exit(1); }
  text = text.split(from).join(to);
}
JSON.parse(text);
writeFileSync(file, text);
console.log('fixed ' + swaps.length + ' anchors; JSON valid');
