# Bug: signs show stale free spaces and the gate turns cars away

**Reported by:** car park operations (ticket PRK-219)

The entrance signs and the entry gate both use the lot's occupancy.

- At Harbour Garage this morning the sign said FULL for several minutes although cars had left, and the gate refused new cars (`409`, "Lot is full") during that time.
- At Station Deck the number of free spaces on the sign did not go down while cars were driving in, and the gate let in more cars than the lot has spaces.

**Acceptance**
- `occupied`, `free` and `full` are right immediately after a car enters or leaves, for the signs and for the gate.
- The gate never lets in more cars than the lot has spaces, and lets the next car in as soon as a space is free.
- The signs poll every few seconds, so occupancy must stay cheap to read: keep it cached.
- Existing behaviour stays as it is (`npm test` passes).
