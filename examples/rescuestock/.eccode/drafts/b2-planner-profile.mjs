// backend-engineer: profile one stress input. Usage: node b2-planner-profile.mjs <file with one JSON input per line> (offers as [code,cups,lids,price,prep,avail,lidDia])
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const { plan } = await import(join(ROOT, 'src/domain/planner.js'));
const { localTimeOnDate } = await import(join(ROOT, 'src/domain/time.js'));
for (const line of readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
  const raw = JSON.parse(line);
  const input = { ...raw, offers: raw.offers.map((o, i) => ({ offerId: i + 1, offerVersion: 1, supplierCode: o[0], productId: i + 1, productName: 'b', units: { cups: o[1], lids: o[2] }, capacityMl: 250, cupDiameterMm: 90, lidDiameterMm: o[6], confirmedCompatible: false, priceCents: o[3], prepFeeCents: o[4], readyAt: localTimeOnDate('2026-10-20', '10:00'), availability: o[5], withdrawn: false, demo: true })) };
  for (let r = 0; r < 3; r += 1) {
    const t = process.hrtime.bigint();
    let out;
    try { const res = plan(input); out = `${res.feasible ? 'feasible' : 'infeasible'} nodes ${res.trace.enumerated}`; } catch (e) { out = e.code || e.message; }
    console.log(`run ${r}: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)} ms ${out}`);
  }
}
