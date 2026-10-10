// technical-reviewer helper: second edit of .eccode/drafts/tr-phc-walk.mjs (reserve right after a successful approval
// in 70 % of cases, to reach the reserve/supplier/expiry paths more often; refresh sessions before the view sweep).
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/drafts/tr-phc-walk.mjs';
let text = readFileSync(file, 'utf8');
const swaps = [
  [
    "    if (tamper && res.status !== 409) fail(step, `tampered approve answered ${res.status}`);\n    return res;",
    "    if (tamper && res.status !== 409) fail(step, `tampered approve answered ${res.status}`);\n" +
      "    if (!tamper && res.status === 200 && rnd() < 0.7) {\n" +
      "      const key = newKey();\n" +
      "      const rr = await c.post(`/api/plans/${p.id}/reserve`, {}, { headers: { 'Idempotency-Key': key } });\n" +
      "      note('reserve-after-approve', `${rr.status}${rr.json?.error ? ` ${rr.json.error.code}` : ''}`);\n" +
      "      keysUsed.push({ client: c, planId: p.id, key, reservationId: rr.status === 201 ? rr.json.reservation.id : null });\n" +
      "      return rr;\n" +
      "    }\n    return res;",
  ],
  [
    "  if (step % 5 === 0 || step === STEPS) await checkViews(step);",
    "  if (step % 5 === 0 || step === STEPS) { if (h.clock.now() - lastLogin > 45 * 60_000) await refreshSessions(); await checkViews(step); }",
  ],
];
for (const [from, to] of swaps) {
  if (!text.includes(from)) { console.error('pattern not found: ' + from.slice(0, 60)); process.exit(1); }
  text = text.replace(from, to);
}
writeFileSync(file, text);
console.log('patched ' + swaps.length + ' places');
