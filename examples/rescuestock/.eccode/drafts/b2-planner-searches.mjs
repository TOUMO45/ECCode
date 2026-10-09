// backend-engineer: per-search node counts for one stress input (same file format as b2-planner-profile.mjs).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const { search } = await import(join(ROOT, 'src/domain/search.js'));
const INF = Number.POSITIVE_INFINITY;
for (const line of readFileSync(process.argv[2], 'utf8').trim().split('\n')) {
  const raw = JSON.parse(line);
  const req = raw.requirement;
  const survivors = raw.offers.filter((o) => o[6] === 90 && o[5] > 0).map((o, i) => {
    const need = Math.max(req.cups > 0 && o[1] > 0 ? Math.ceil(req.cups / o[1]) : 0, req.lids > 0 && o[2] > 0 ? Math.ceil(req.lids / o[2]) : 0);
    return { supplierCode: o[0], unitCups: o[1], unitLids: o[2], priceCents: o[3], prepFeeCents: o[4], readyMs: 1, bound: Math.min(o[5], need), ci: i };
  });
  const budget = raw.budgetCents === null ? INF : raw.budgetCents;
  const run = (label, cons, opts) => {
    const t = process.hrtime.bigint();
    let out;
    try { const r = search(survivors, req, raw.taxBp, cons, opts); out = `nodes ${r.nodes} best ${r.best ? r.best.total : null}`; } catch (e) { out = e.code; }
    console.log(`  ${label}: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)} ms ${out}`);
  };
  console.log(`input: ${survivors.length} survivors, N=${req.cups}/${req.lids}, maxPickups ${raw.maxPickups}, budget ${raw.budgetCents}`);
  run('main(keep 4)', { budget, maxPickups: raw.maxPickups }, { keep: 4 });
  survivors.forEach((s) => run(`force ${s.supplierCode}`, { budget: INF, maxPickups: INF }, { force: s.ci }));
  run('relax budget', { budget: INF, maxPickups: raw.maxPickups }, {});
  run('relax pickups', { budget, maxPickups: INF }, {});
}
