// technical-reviewer helper: corrects the client-ip.js anchor in .eccode/reviews/drafts/phase-c-1.json, then checks
// that every artifact:<file>#L<a>[-L<b>] anchor in the draft lies inside its file.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = '.eccode/reviews/drafts/phase-c-1.json';
let text = readFileSync(file, 'utf8');
text = text.split('artifact:src/auth/client-ip.js#L120-L127').join('artifact:src/auth/client-ip.js#L29-L36');
JSON.parse(text);
writeFileSync(file, text);
let bad = 0;
for (const m of text.matchAll(/artifact:([^#"]+)#L(\d+)(?:-L(\d+))?/g)) {
  const [, path, a, b] = m;
  if (!existsSync(path)) { console.log('missing file ' + path); bad++; continue; }
  const lines = readFileSync(path, 'utf8').split('\n').length;
  if (Number(b ?? a) > lines || Number(a) < 1) { console.log(`out of range ${path}#L${a}${b ? '-L' + b : ''} (file has ${lines} lines)`); bad++; }
}
console.log(bad ? `${bad} bad anchors` : 'all line anchors inside their files');
process.exit(bad ? 1 : 0);
