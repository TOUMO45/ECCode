// technical-reviewer checks (phase B), against the approved design spec and the brief, independent of the tests:
// (1) migrations: each src/db/migrations/00N_*.sql equals the spec's ```sql block N after whitespace normalisation
// (2) approvalPageCsp(appOrigin) equals the spec's listener CSP with <appOrigin> substituted; app CSP equals the spec's
// (3) package.json scripts equal the spec's Testing Strategy > Commands block (+ start/seed)
// (4) planner vs my own brute force (written from the brief's Planner rules, not from planner.js) on RS-FIX-1
//     scenarios and on 3000 random catalogs (<= 6 offers, on_hand 0-3, bundles {50,100,200} of cups+lids, some
//     cups-only/lids-only, mixed diameters and confirmed rows, withdrawn offers, 2 offers per supplier possible,
//     tax 0 or 1600 bp): feasibility, (total, pickups, readyAt, supplier codes) of the best plan, rejection codes,
//     per-candidate codes and the relaxations (constraint, neededValue, plan suppliers and total)
// Usage: node tr-phb-checks.mjs <spec.md>.  Exit 0 = every comparison agrees.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const spec = readFileSync(process.argv[2], 'utf8');
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`); };
const norm = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

// (1)
const dd = spec.slice(spec.indexOf('## Data Design'), spec.indexOf('## Background Processing'));
const blocks = [...dd.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
const files = readdirSync(join(root, 'src/db/migrations')).filter((f) => f.endsWith('.sql')).sort();
check('five migration files', files.length === 5, files.join(','));
files.forEach((f, i) => {
  const a = norm(readFileSync(join(root, 'src/db/migrations', f), 'utf8'));
  const b = norm(blocks[i] || '');
  let at = 0; while (at < a.length && a[at] === b[at]) at++;
  check(`migration ${f} equals spec block ${i + 1} (comments and whitespace ignored)`, a === b, a === b ? '' : `first difference at ${at}: file "${a.slice(at, at + 60)}" spec "${b.slice(at, at + 60)}"`);
});

// (2)
const headers = await import(pathToFileURL(join(root, 'src/http/headers.js')));
const lm = spec.match(/`(default-src 'none'; style-src 'self'; form-action 'self' <appOrigin>;[^`]*)`/);
const am = spec.match(/`Content-Security-Policy: (default-src 'self';[^`]*form-action 'self')`/);
const origin = 'http://localhost:3000';
check('approvalPageCsp(appOrigin) equals the spec string', typeof headers.approvalPageCsp === 'function' && headers.approvalPageCsp(origin) === lm[1].replace('<appOrigin>', origin), typeof headers.approvalPageCsp === 'function' ? headers.approvalPageCsp(origin) : 'missing');
const appCspText = readFileSync(join(root, 'src/http/headers.js'), 'utf8');
check('app CSP string present verbatim in headers.js', appCspText.includes(am[1]));

// (3)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const cmdBlock = spec.slice(spec.indexOf('**Commands (`package.json`'), spec.indexOf('Every script that passes a version-specific flag'));
const specScripts = JSON.parse(cmdBlock.slice(cmdBlock.indexOf('{'), cmdBlock.lastIndexOf('}') + 1));
for (const [k, v] of Object.entries(specScripts)) check(`package.json script ${k} equals the spec`, pkg.scripts[k] === v, pkg.scripts[k] === v ? '' : `got ${pkg.scripts[k]}`);
check('no dependencies; devDependencies only @playwright/test 1.56.1; engines >=22.13', !pkg.dependencies && JSON.stringify(pkg.devDependencies) === '{"@playwright/test":"1.56.1"}' && pkg.engines?.node === '>=22.13');

// (4)
const { plan } = await import(pathToFileURL(join(root, 'src/domain/planner.js')));
const fx = JSON.parse(readFileSync(join(root, 'test/fixtures/rs-fix-1.json'), 'utf8'));
const T = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return new Date(Date.UTC(2026, 9, 20, h - 3, m)).toISOString(); };
const fxInput = (mut) => {
  const input = { requirement: { ...fx.requirement }, budgetCents: fx.budgetCents, deadlineAt: T(fx.deadline), maxPickups: fx.maxPickups, taxBp: 0,
    offers: fx.offers.map((o) => ({ supplierCode: o.supplierCode, offerId: o.offerId, offerVersion: 1, units: o.units, capacityMl: o.capacityMl,
      cupDiameterMm: o.cupDiameterMm, lidDiameterMm: o.lidDiameterMm, confirmedCompatible: o.confirmedCompatible, priceCents: o.priceCents,
      prepFeeCents: o.prepFeeCents, readyAt: T(o.ready), availability: o.onHand - o.reserved, withdrawn: o.withdrawn, demo: true })) };
  if (mut) mut(input); return input;
};
const off = (i, c) => i.offers.find((o) => o.supplierCode === c);

// --- my brute force, from the brief's rules
function solve(input, ignore = {}) {
  const req = input.requirement; const dl = input.deadlineAt ? Date.parse(input.deadlineAt) : null;
  const rej = []; const cand = [];
  for (const o of [...input.offers].sort((a, b) => (a.supplierCode < b.supplierCode ? -1 : a.supplierCode > b.supplierCode ? 1 : a.offerId - b.offerId))) {
    if (o.capacityMl !== req.capacityMl || o.cupDiameterMm !== req.diameterMm) continue;
    const codes = [];
    if (o.withdrawn) codes.push('OFFER_WITHDRAWN');
    else {
      if (!(o.cupDiameterMm === o.lidDiameterMm || o.confirmedCompatible)) codes.push('INCOMPATIBLE_LID_DIAMETER');
      if (!ignore.deadline && dl !== null && Date.parse(o.readyAt) > dl) codes.push('READY_AFTER_DEADLINE');
      if (o.availability === 0) codes.push('OUT_OF_STOCK');
    }
    if (codes.length) { rej.push({ supplierCode: o.supplierCode, offerId: o.offerId, codes }); continue; }
    const need = Math.max(req.cups > 0 && o.units.cups > 0 ? Math.ceil(req.cups / o.units.cups) : 0, req.lids > 0 && o.units.lids > 0 ? Math.ceil(req.lids / o.units.lids) : 0);
    cand.push({ ...o, bound: Math.min(o.availability, need) });
  }
  const all = []; const m = cand.map(() => 0);
  const rec = (i) => {
    if (i === cand.length) {
      const sup = new Map(); let cups = 0, lids = 0, rd = 0;
      cand.forEach((o, j) => { if (!m[j]) return; cups += m[j] * o.units.cups; lids += m[j] * o.units.lids; rd = Math.max(rd, Date.parse(o.readyAt));
        const s = sup.get(o.supplierCode) || { sub: 0, prep: 0 }; s.sub += m[j] * o.priceCents; s.prep = Math.max(s.prep, o.prepFeeCents); sup.set(o.supplierCode, s); });
      if (!sup.size) return;
      let total = 0; for (const s of sup.values()) { const base = s.sub + s.prep; total += base + Math.floor((base * (input.taxBp || 0) + 5000) / 10000); }
      all.push({ cups, lids, total, pk: sup.size, rd, codes: [...sup.keys()].sort().join(','), uses: new Set(cand.filter((_, j) => m[j]).map((o) => o.offerId)) });
      return;
    }
    for (let k = 0; k <= cand[i].bound; k++) { m[i] = k; rec(i + 1); } m[i] = 0;
  };
  rec(0);
  const covers = (p) => p.cups >= req.cups && p.lids >= req.lids;
  const viol = (p) => { const v = []; if (!covers(p)) v.push('INSUFFICIENT_QTY'); if (!ignore.maxPickups && p.pk > input.maxPickups) v.push('TOO_MANY_PICKUPS'); if (!ignore.budget && input.budgetCents != null && p.total > input.budgetCents) v.push('OVER_BUDGET'); return v; };
  const cmp = (a, b) => a.total - b.total || a.pk - b.pk || a.rd - b.rd || (a.codes < b.codes ? -1 : a.codes > b.codes ? 1 : 0);
  const feas = all.filter((p) => !viol(p).length).sort(cmp);
  const out = { best: feas[0] || null, rej, cand };
  if (!feas.length && !ignore.inner) {
    out.candidateCodes = cand.map((o) => {
      const cs = [];
      if (o.bound * o.units.cups < req.cups || o.bound * o.units.lids < req.lids) cs.push('INSUFFICIENT_QTY');
      const cov = all.filter((p) => covers(p) && p.uses.has(o.offerId)).sort(cmp)[0];
      if (cov) { if (cov.pk > input.maxPickups) cs.push('TOO_MANY_PICKUPS'); if (input.budgetCents != null && cov.total > input.budgetCents) cs.push('OVER_BUDGET'); }
      return { supplierCode: o.supplierCode, offerId: o.offerId, codes: cs };
    });
    out.relaxations = [];
    for (const [c, code, key] of [['budget', 'OVER_BUDGET', 'total'], ['deadline', 'READY_AFTER_DEADLINE', 'rd'], ['maxPickups', 'TOO_MANY_PICKUPS', 'pk']]) {
      if (c === 'budget' && input.budgetCents == null) continue;
      if (c === 'deadline' && !input.deadlineAt) continue;
      const r = solve(input, { [c]: true, inner: true }).best;
      if (r) out.relaxations.push({ constraint: c, code, needed: key === 'rd' ? new Date(r.rd).toISOString() : r[key], codes: r.codes, total: r.total });
    }
  }
  return out;
}
const compare = (input, label) => {
  const p = plan(input); const s = solve(input);
  const pr = (x) => JSON.stringify(x);
  const prRej = pr(p.rejections.map((r) => [r.supplierCode, r.offerId, r.codes]));
  const sRej = pr(s.rej.map((r) => [r.supplierCode, r.offerId, r.codes]));
  if (prRej !== sRej) return `${label}: rejections ${prRej} vs ${sRej}`;
  if (p.feasible !== !!s.best) return `${label}: feasible ${p.feasible} vs ${!!s.best}`;
  if (p.feasible) {
    const a = [p.best.totalCents, p.best.pickupCount, Date.parse(p.best.readyAt), p.best.supplierCodes.join(',')];
    const b = [s.best.total, s.best.pk, s.best.rd, s.best.codes];
    return pr(a) === pr(b) ? null : `${label}: best ${pr(a)} vs ${pr(b)}`;
  }
  const pc = pr(p.candidateCodes.map((c) => [c.supplierCode, c.offerId, [...c.codes].sort()]));
  const sc = pr(s.candidateCodes.map((c) => [c.supplierCode, c.offerId, [...c.codes].sort()]));
  if (pc !== sc) return `${label}: candidateCodes ${pc} vs ${sc}`;
  const prl = pr(p.relaxations.map((r) => [r.constraint, r.code, typeof r.neededValue === 'string' ? new Date(r.neededValue).toISOString() : r.neededValue, r.plan.supplierCodes.join(','), r.plan.totalCents]));
  const srl = pr(s.relaxations.map((r) => [r.constraint, r.code, r.needed, r.codes, r.total]));
  if (prl !== srl) return `${label}: relaxations ${prl} vs ${srl}`;
  const pb = pr(p.blocking); const sb = pr(s.relaxations.length ? s.relaxations.map((r) => r.code) : ['INSUFFICIENT_QTY']);
  return pb === sb ? null : `${label}: blocking ${pb} vs ${sb}`;
};
// RS-FIX-1 scenarios with the brief's exact expectations
const r6 = plan(fxInput());
check('RS-06 A+B 8400, 2 pickups, 10:30', r6.feasible && r6.best.supplierCodes.join('+') === 'A+B' && r6.best.totalCents === 8400 && r6.best.pickupCount === 2 && r6.best.readyAt === T('10:30'));
const r6g = plan(fxInput((i) => { off(i, 'A').availability = 2; }));
check('RS-06 guard: A on_hand 2 -> Ax2 7000, 1 pickup', r6g.best.supplierCodes.join() === 'A' && r6g.best.totalCents === 7000 && r6g.best.pickupCount === 1);
check('RS-07 C INCOMPATIBLE_LID_DIAMETER', JSON.stringify(r6.rejections.find((r) => r.supplierCode === 'C').codes) === '["INCOMPATIBLE_LID_DIAMETER"]');
check('RS-08 D READY_AFTER_DEADLINE', JSON.stringify(r6.rejections.find((r) => r.supplierCode === 'D').codes) === '["READY_AFTER_DEADLINE"]');
for (const [lab, mut] of [['B on_hand 0', (i) => { off(i, 'B').availability = 0; }], ['B withdrawn', (i) => { off(i, 'B').withdrawn = true; }]]) {
  const r = plan(fxInput(mut));
  check(`RS-09 (${lab}) A+E 9500, 2 pickups, 10:40`, r.best.supplierCodes.join('+') === 'A+E' && r.best.totalCents === 9500 && r.best.pickupCount === 2 && r.best.readyAt === T('10:40'));
}
const r10 = plan(fxInput((i) => { off(i, 'B').availability = 0; i.budgetCents = 9000; }));
const cc = (r, c) => JSON.stringify([...r.candidateCodes.find((x) => x.supplierCode === c).codes].sort());
check('RS-10 infeasible, OVER_BUDGET blocking, A and E [INSUFFICIENT_QTY, OVER_BUDGET], exactly two relaxations (9500 A+E; 11:20 D 8000 1 pickup)',
  !r10.feasible && r10.blocking.includes('OVER_BUDGET') && cc(r10, 'A') === '["INSUFFICIENT_QTY","OVER_BUDGET"]' && cc(r10, 'E') === '["INSUFFICIENT_QTY","OVER_BUDGET"]'
  && r10.relaxations.length === 2 && JSON.stringify(r10.relaxations.map((r) => [r.constraint, r.plan.supplierCodes.join('+'), r.plan.totalCents, r.plan.pickupCount])) === '[["budget","A+E",9500,2],["deadline","D",8000,1]]'
  && r10.relaxations[0].neededValue === 9500 && r10.relaxations[1].neededValue === T('11:20'), JSON.stringify(r10.relaxations.map((r) => [r.constraint, r.neededValue])));
const r11 = plan(fxInput((i) => { i.maxPickups = 1; }));
check('RS-11 infeasible; A, B, E exactly [INSUFFICIENT_QTY, TOO_MANY_PICKUPS]; C, D keep their codes',
  !r11.feasible && ['A', 'B', 'E'].every((c) => cc(r11, c) === '["INSUFFICIENT_QTY","TOO_MANY_PICKUPS"]') && r11.rejections.find((r) => r.supplierCode === 'C').codes[0] === 'INCOMPATIBLE_LID_DIAMETER' && r11.rejections.find((r) => r.supplierCode === 'D').codes[0] === 'READY_AFTER_DEADLINE',
  JSON.stringify(r11.relaxations.map((r) => [r.constraint, r.plan.supplierCodes.join('+'), r.plan.totalCents])));
for (const [lab, mut] of [['base', null], ['A2', (i) => { off(i, 'A').availability = 2; }], ['RS-10', (i) => { off(i, 'B').availability = 0; i.budgetCents = 9000; }], ['RS-11', (i) => { i.maxPickups = 1; }]]) {
  const d = compare(fxInput(mut), lab); check(`brute force agrees on RS-FIX-1 ${lab}`, d === null, d || '');
}
// random catalogs
let seed = 12345; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
let diffs = 0, feasibleN = 0; const firstDiffs = [];
for (let n = 0; n < 3000; n++) {
  const k = 1 + Math.floor(rnd() * 6);
  const offers = [];
  for (let j = 0; j < k; j++) {
    const size = pick([50, 100, 200]); const kind = rnd() < 0.8 ? 'both' : pick(['cups', 'lids']);
    offers.push({ supplierCode: pick(['A', 'B', 'C', 'D', 'E']), offerId: j + 1, offerVersion: 1,
      units: { cups: kind === 'lids' ? 0 : size, lids: kind === 'cups' ? 0 : size }, capacityMl: rnd() < 0.93 ? 250 : 350,
      cupDiameterMm: 90, lidDiameterMm: rnd() < 0.15 ? 95 : 90, confirmedCompatible: rnd() < 0.3,
      priceCents: 1000 + Math.floor(rnd() * 9001), prepFeeCents: Math.floor(rnd() * 1501), readyAt: T(pick(['09:30', '10:00', '10:30', '11:00', '11:20', '12:00'])),
      availability: Math.floor(rnd() * 4), withdrawn: rnd() < 0.08, demo: true });
  }
  const input = { requirement: { cups: pick([100, 200, 300, 400]), lids: pick([0, 100, 200, 300, 400]), capacityMl: 250, diameterMm: 90, material: null },
    budgetCents: rnd() < 0.15 ? null : 3000 + Math.floor(rnd() * 25000), deadlineAt: rnd() < 0.1 ? null : T(pick(['10:00', '10:30', '11:00', '11:30'])),
    maxPickups: 1 + Math.floor(rnd() * 3), taxBp: pick([0, 0, 1600]), offers };
  if (input.requirement.cups + input.requirement.lids === 0) continue;
  let d;
  try { d = compare(input, `catalog ${n}`); } catch (e) { d = `catalog ${n}: threw ${e.message}`; }
  if (plan(input).feasible) feasibleN++;
  if (d) { diffs++; if (firstDiffs.length < 5) firstDiffs.push(d); }
}
check(`brute force agrees on 3000 random catalogs (${feasibleN} feasible)`, diffs === 0, firstDiffs.join(' || '));
console.log(`failures: ${fails}`);
process.exit(fails ? 1 : 0);
