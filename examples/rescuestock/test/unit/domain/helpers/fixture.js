// Loads the canonical fixture RS-FIX-1 and turns it into planner input (Ts values through src/domain/time.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localTimeOnDate, localToUtc } from '../../../../src/domain/time.js';

export const FIXTURE_PATH = fileURLToPath(new URL('../../../fixtures/rs-fix-1.json', import.meta.url));

export function loadFixtureRaw() {
  return readFileSync(FIXTURE_PATH);
}

export function loadFixture() {
  return JSON.parse(loadFixtureRaw().toString('utf8'));
}

// Planner input for RS-FIX-1. `mutate(input)` may edit the freshly built input before it is returned.
export function fixtureInput(mutate) {
  const fx = loadFixture();
  const input = {
    requirement: { ...fx.requirement },
    budgetCents: fx.budgetCents,
    deadlineAt: localTimeOnDate(fx.date, fx.deadline),
    maxPickups: fx.maxPickups,
    taxBp: fx.taxBp,
    offers: fx.offers.map((o) => ({
      offerId: o.offerId,
      offerVersion: o.offerVersion,
      supplierCode: o.supplierCode,
      productId: o.productId,
      productName: o.productName,
      units: { ...o.units },
      capacityMl: o.capacityMl,
      cupDiameterMm: o.cupDiameterMm,
      lidDiameterMm: o.lidDiameterMm,
      confirmedCompatible: o.confirmedCompatible,
      priceCents: o.priceCents,
      prepFeeCents: o.prepFeeCents,
      readyAt: localTimeOnDate(fx.date, o.ready),
      availability: o.onHand - o.reserved,
      withdrawn: o.withdrawn,
      demo: o.demo,
    })),
    excludeSupplierCodes: [],
  };
  if (mutate) mutate(input);
  return input;
}

export function offerOf(input, code) {
  return input.offers.find((o) => o.supplierCode === code);
}

export function localStartOfDay(fx) {
  return localToUtc(`${fx.date}T${fx.clock}`);
}
