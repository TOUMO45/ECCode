// Seeded catalog generators shared by the oracle property test and the NFR5 timing test.
import { localTimeOnDate } from '../../../../src/domain/time.js';

export const DAY = '2026-10-20';

// mulberry32: 32-bit seeded PRNG, deterministic across platforms.
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), // inclusive
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

function hhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function readyAt(rng, fromMin, toMin) {
  const slots = Math.floor((toMin - fromMin) / 10);
  return localTimeOnDate(DAY, hhmm(fromMin + 10 * rng.int(0, slots)));
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Small random catalogs for the oracle property test: <= 6 offers, on_hand (availability) 0-3. Includes withdrawn
 * offers, incompatible lids (some with a confirmed compatibility row), late offers, offers of the same supplier,
 * cups/lids of different counts, spec mismatches, optional budget/deadline and non-zero tax.
 */
export function smallCatalog(seed) {
  const rng = makeRng(seed);
  const offerCount = rng.int(1, 6);
  const offers = [];
  for (let i = 0; i < offerCount; i += 1) {
    const sameSupplier = i > 0 && rng.chance(0.2);
    const supplierCode = sameSupplier ? offers[rng.int(0, i - 1)].supplierCode : LETTERS[i];
    const cups = rng.pick([50, 100, 200]);
    const lids = rng.chance(0.2) ? rng.pick([50, 100, 200]) : cups;
    const incompatible = rng.chance(0.2);
    offers.push({
      offerId: i + 1,
      offerVersion: 1,
      supplierCode,
      productId: i + 1,
      productName: `bundle ${i + 1}`,
      units: { cups, lids },
      capacityMl: rng.chance(0.08) ? 350 : 250,
      cupDiameterMm: 90,
      lidDiameterMm: incompatible ? 95 : 90,
      confirmedCompatible: incompatible && rng.chance(0.25),
      priceCents: rng.int(5, 90) * 100,
      prepFeeCents: rng.pick([0, 300, 500, 800, 1000, 1500]),
      readyAt: readyAt(rng, 9 * 60 + 30, 12 * 60),
      availability: rng.int(0, 3),
      withdrawn: rng.chance(0.08),
      demo: true,
    });
  }
  const cupsNeeded = rng.int(1, 4) * 100;
  return {
    requirement: { cups: cupsNeeded, lids: rng.chance(0.2) ? rng.int(1, 4) * 100 : cupsNeeded, capacityMl: 250, diameterMm: 90, material: null },
    budgetCents: rng.chance(0.15) ? null : rng.int(30, 300) * 100,
    deadlineAt: rng.chance(0.1) ? null : localTimeOnDate(DAY, hhmm(rng.int(10 * 60 + 30, 12 * 60))),
    maxPickups: rng.int(1, 4),
    taxBp: rng.pick([0, 0, 500, 1600, 825]),
    offers,
    excludeSupplierCodes: rng.chance(0.1) ? [LETTERS[rng.int(0, 5)]] : [],
  };
}

/**
 * NFR5 generator (brief): 12 offers; bundle sizes {50,100,200}; required quantity 100-400 in steps of 100;
 * on_hand 0-2; price 1000-10000 cents; prep fee 0-1500 cents; ready 09:30-12:00; 15 % incompatible; max pickups
 * 1-3. The brief does not give a deadline or a budget: this generator fixes the deadline at 11:30 and draws the
 * budget from 6000-30000 cents so that feasible and infeasible catalogs both occur.
 */
export function nfr5Catalog(seed) {
  const rng = makeRng(seed);
  const offers = [];
  for (let i = 0; i < 12; i += 1) {
    const size = rng.pick([50, 100, 200]);
    offers.push({
      offerId: i + 1,
      offerVersion: 1,
      supplierCode: LETTERS[i],
      productId: i + 1,
      productName: `${size} cups + ${size} lids`,
      units: { cups: size, lids: size },
      capacityMl: 250,
      cupDiameterMm: 90,
      lidDiameterMm: rng.chance(0.15) ? 95 : 90,
      confirmedCompatible: false,
      priceCents: rng.int(1000, 10000),
      prepFeeCents: rng.int(0, 1500),
      readyAt: readyAt(rng, 9 * 60 + 30, 12 * 60),
      availability: rng.int(0, 2),
      withdrawn: false,
      demo: true,
    });
  }
  const need = rng.int(1, 4) * 100;
  return {
    requirement: { cups: need, lids: need, capacityMl: 250, diameterMm: 90, material: null },
    budgetCents: rng.int(6000, 30000),
    deadlineAt: localTimeOnDate(DAY, '11:30'),
    maxPickups: rng.int(1, 3),
    taxBp: 0,
    offers,
    excludeSupplierCodes: [],
  };
}
