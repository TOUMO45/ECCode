// Shared helpers for the extraction tests (phase D): the committed EXT-1 corpus photo, the image upload call, and the
// fake provider's fault switch. The fault switch is the one the application reads: a row `fake_model:<fault>` in
// fault_flags with a remaining count (NULL = until cleared), see src/services/extraction.js takeModelFault.
import { readFileSync } from 'node:fs';
import { FIXTURE_DIR } from './fixtures.js';

export const EXTRACTION_FIXTURE_DIR = `${FIXTURE_DIR}/extraction`;

// A committed corpus photo the default fake image map knows (sha256 of these bytes): capacity 250 ml, diameter 90 mm.
export const CLEAR_PHOTO_FILE = `${EXTRACTION_FIXTURE_DIR}/images/i01-clear-250-90.png`;
export const loadClearPhoto = () => readFileSync(CLEAR_PHOTO_FILE);

export const NINE_FIELDS = Object.freeze(['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups']);

export function uploadImage(client, requestId, bytes, type = 'image/png') {
  return client.send({ method: 'POST', path: `/api/requests/${requestId}/image`, headers: { 'Content-Type': type }, body: bytes });
}

// Arms the fake provider's fault for the next `remaining` extract calls (null: until cleared).
export function setModelFault(db, clock, fault, remaining = 1) {
  db.prepare("INSERT OR REPLACE INTO fault_flags (name, value, remaining, created_at) VALUES (?, '', ?, ?)").run(`fake_model:${fault}`, remaining, new Date(clock.now()).toISOString());
}
