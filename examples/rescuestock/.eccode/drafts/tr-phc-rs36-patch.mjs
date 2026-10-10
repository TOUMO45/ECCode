// technical-reviewer helper: case (iv) of tr-phc-rs36.mjs goes through the real supplier refusal route (the void rule
// releases the reservation and voids the created operations), instead of SQL that left the stock reserved.
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/drafts/tr-phc-rs36.mjs';
let text = readFileSync(file, 'utf8');
const from = "    refused(x, 'voided');\n    await expect('(iv) before the new version (closed, nothing newer)', x, 'cancelled');";
const to =
  "    const sb = createClient(x.h.request);\n" +
  "    await sb.signIn('supplier-b', DEMO_PASSWORD);\n" +
  "    const ref = await sb.post(`/api/supplier/orders/${x.ord.B}/refuse`, { reason: 'No lids today' });\n" +
  "    if (ref.status !== 200) { failed++; results.push(`FAIL (iv) refuse answered ${ref.status} ${ref.text.slice(0, 200)}`); }\n" +
  "    const opsNow = x.h.db.prepare('SELECT status FROM payment_operations').all().map((o) => o.status);\n" +
  "    const resNow = x.h.db.prepare('SELECT status FROM reservations').all().map((o) => o.status);\n" +
  "    const stockNow = x.h.db.prepare('SELECT SUM(reserved) AS n FROM inventory').get().n;\n" +
  "    results.push(`     (iv) after the refusal route: operations ${opsNow.join(',')}; reservation ${resNow.join(',')}; total reserved ${stockNow}`);\n" +
  "    if (opsNow.some((s) => s !== 'voided') || resNow[0] !== 'released' || stockNow !== 0) { failed++; results.push('FAIL (iv) the void rule left work behind'); }\n" +
  "    await expect('(iv) after the refusal, re-plan queued', x, 'replanning');";
if (!text.includes(from)) { console.error('pattern not found'); process.exit(1); }
text = text.replace(from, to);
writeFileSync(file, text);
console.log('patched');
