import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCliProvider } from '../../src/ai/cli.js';
import { validateDraft } from '../../src/ai/schema.js';
import { buildContext, verifyDraft } from '../../src/verify/index.js';
import { SKIP, liveConfig, incident, fixtureNotes } from './support.js';

test('live: one real generation through cli.js is schema valid, reports usage and runs the verifier', { skip: SKIP, timeout: 200000 }, async () => {
  const lines = fixtureNotes();
  const p = createCliProvider({ config: liveConfig() });
  assert.equal(await p.available(), true);
  console.log(`# claude version ${await p.version()}`);
  const r = await p.generate({ incident, lines });
  assert.equal(validateDraft(r.draft).ok, true);
  for (const k of ['inputTokens', 'outputTokens', 'costUsd', 'durationMs']) assert.equal(typeof r.usage[k], 'number', k);
  assert.ok(r.usage.outputTokens > 0);
  assert.ok(r.usage.costUsd > 0 && r.usage.costUsd < 0.1, `cost ${r.usage.costUsd}`);
  const v = verifyDraft({ sections: r.draft }, buildContext(lines, []));
  assert.equal(Object.keys(v.sections).length, 5);
  console.log(`# model=${r.usage.model} cost=${r.usage.costUsd} in=${r.usage.inputTokens} out=${r.usage.outputTokens} attempts=${r.usage.attempts}`);
});
