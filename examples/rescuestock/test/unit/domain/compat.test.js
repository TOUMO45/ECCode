// Compatibility: equal diameters, or a confirmed compatibility row. Nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areCompatible, matchesRequirement } from '../../../src/domain/compat.js';

test('RS-07: cups 90 mm with lids 95 mm and no confirmed row are incompatible; equal diameters or a confirmed row are compatible', () => {
  assert.equal(areCompatible({ cupDiameterMm: 90, lidDiameterMm: 90 }), true);
  assert.equal(areCompatible({ cupDiameterMm: 90, lidDiameterMm: 95 }), false);
  assert.equal(areCompatible({ cupDiameterMm: 90, lidDiameterMm: 95, confirmedCompatible: false }), false);
  assert.equal(areCompatible({ cupDiameterMm: 90, lidDiameterMm: 95, confirmedCompatible: true }), true);
  // only the boolean true counts as a confirmed row
  for (const truthy of [1, 'true', {}, 'yes']) assert.equal(areCompatible({ cupDiameterMm: 90, lidDiameterMm: 95, confirmedCompatible: truthy }), false, String(truthy));
});

test('compat: diameters must be positive integers', () => {
  for (const bad of [0, -90, 90.5, '90', null, undefined, NaN]) {
    assert.throws(() => areCompatible({ cupDiameterMm: bad, lidDiameterMm: 90 }), RangeError, `cup ${bad}`);
    assert.throws(() => areCompatible({ cupDiameterMm: 90, lidDiameterMm: bad }), RangeError, `lid ${bad}`);
  }
});

test('compat: an offer matches the requirement on capacity and cup diameter', () => {
  const requirement = { capacityMl: 250, diameterMm: 90 };
  assert.equal(matchesRequirement({ capacityMl: 250, cupDiameterMm: 90 }, requirement), true);
  assert.equal(matchesRequirement({ capacityMl: 350, cupDiameterMm: 90 }, requirement), false);
  assert.equal(matchesRequirement({ capacityMl: 250, cupDiameterMm: 80 }, requirement), false);
});
