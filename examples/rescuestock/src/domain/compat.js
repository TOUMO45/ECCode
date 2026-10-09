// Cup/lid compatibility: a cup and a lid fit when their diameters are equal, or when a confirmed compatibility row
// exists for the pair (the caller passes that as `confirmedCompatible`). Nothing else makes them compatible.

function assertDiameter(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer number of millimetres`);
}

export function areCompatible({ cupDiameterMm, lidDiameterMm, confirmedCompatible = false }) {
  assertDiameter(cupDiameterMm, 'cupDiameterMm');
  assertDiameter(lidDiameterMm, 'lidDiameterMm');
  return cupDiameterMm === lidDiameterMm || confirmedCompatible === true;
}

// Does the offer's cup match what the buyer asked for (capacity and cup diameter)?
export function matchesRequirement(offer, requirement) {
  return offer.capacityMl === requirement.capacityMl && offer.cupDiameterMm === requirement.diameterMm;
}
