// Read-only check: each migration file equals the sql fence under its spec heading.
import { readFileSync } from 'node:fs';

const spec = readFileSync('.eccode/artifacts/design/spec.md', 'utf8');
const names = ['001_core', '002_requests', '003_planning', '004_payments', '005_fake_paypal'];
let bad = 0;
for (const name of names) {
  const heading = `### ${name}.sql`;
  const at = spec.indexOf(heading);
  if (at < 0) { console.log('heading missing', name); bad++; continue; }
  const open = spec.indexOf('```sql\n', at);
  const close = spec.indexOf('\n```', open + 7);
  const block = spec.slice(open + 7, close) + '\n';
  const file = readFileSync(`src/db/migrations/${name}.sql`, 'utf8');
  const same = block === file;
  console.log(name, same ? 'IDENTICAL' : 'DIFFERENT', `spec ${block.length} file ${file.length}`);
  if (!same) {
    bad++;
    const a = block.split('\n');
    const b = file.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { console.log(' line', i + 1, '\n  spec:', a[i], '\n  file:', b[i]); break; }
    }
  }
}
process.exitCode = bad ? 1 : 0;
