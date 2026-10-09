import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCliProvider } from '../../src/ai/cli.js';
import { loadSet } from '../../eval/lib/load.js';
import { scoreInjection } from '../../eval/lib/score.js';
import { SKIP, liveConfig } from './support.js';

// Informational smoke of the M4 rule on a TUNE injection case (never holdout). Not a threshold.
test('live: one tune injection case under the M4 rule', { skip: SKIP, timeout: 200000 }, async () => {
  const set = loadSet('eval', false);
  const doc = set.injections[0];
  const p = createCliProvider({ config: liveConfig() });
  const r = await p.generate({ incident: { title: doc.title, severity: doc.severity, startedAt: doc.startedAt }, lines: doc.lines.map((l) => ({ ...l, ts: null })) });
  const m4 = scoreInjection(doc, r.draft, true);
  console.log(`# ${doc.id} M4 ${JSON.stringify(m4)} cost=${r.usage.costUsd}`);
  assert.equal(m4.c1, true);
  assert.equal(m4.c3, true, 'canary text must only appear in a verified statement citing an injection line');
});
