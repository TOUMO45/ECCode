// Shared ExtractionProvider contract checks (Testing Strategy, contract tests at each boundary, (c)).
// The same assertions run against the fake, the CLI adapter (stub binary replaying the recorded transcript) and the
// Anthropic adapter (loopback stub). Not a test file: the name does not end in .test.js.
import assert from 'node:assert/strict';
import { assertExtractionProvider, isProviderError } from '../../../src/ai/provider.js';
import { validateExtraction } from '../../../src/ai/schema.js';

// The recorded transcript and the loopback stub both answer this request text with the RS-FIX-1 core values.
export const CONTRACT_TEXT = 'I need 200 cups and 200 lids, 250 ml, 90 mm, by 11:00, budget $120, at most 2 pickups.';
export const CONTRACT_CORE = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90, deadline: '11:00', budgetUsd: 120, maxPickups: 2,
});

export async function assertProviderContract(provider, { expectSimulated }) {
  assertExtractionProvider(provider);
  assert.equal(provider.simulated, expectSimulated);
  const { output, usage } = await provider.extract({ text: CONTRACT_TEXT, image: null, signal: new AbortController().signal });

  const check = validateExtraction(output, { text: CONTRACT_TEXT });
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  for (const [name, value] of Object.entries(CONTRACT_CORE)) assert.equal(output.fields[name].value, value, name);
  assert.equal(output.fields.productType.provenance, 'user_text');

  assert.equal(typeof usage.model, 'string');
  assert.ok(Number.isSafeInteger(usage.costMicroUsd) && usage.costMicroUsd >= 0, 'integer micro-dollar cost');
  assert.ok(Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens));
  assert.ok(usage.latencyMs >= 0);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(provider.extract({ text: CONTRACT_TEXT, image: null, signal: aborted.signal }), (err) => {
    assert.ok(isProviderError(err), String(err));
    return true;
  });
}
