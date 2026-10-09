import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackDraft, createFallbackProvider } from '../../../src/ai/fallback.js';
import { createFakeProvider } from '../../../src/ai/fake.js';
import { validateDraft, DRAFT_SECTIONS } from '../../../src/ai/schema.js';
import { buildContext, verifyStatement } from '../../../src/verify/index.js';
import { assertProvider } from '../../../src/ai/provider.js';

const L = (n, time, author, text) => ({ n, time, ts: null, author, text });
const corpus = [
  L(1, '14:05', 'alice', 'Pager fired: checkout error rate at 12% since 14:02.'),
  L(2, '14:07', 'bob', 'Customers report 502 errors on /pay; API latency degraded.'),
  L(3, '14:10', 'alice', 'Root cause: bad config push because of a regression in the deploy tool.'),
  L(4, '14:15', 'carol', 'We should add a canary stage. Action item: carol will file ticket OPS-123.'),
  L(5, '14:20', 'bob', 'Rolled back v2.31.0; error rate back to 0.1%.'),
  L(6, '14:22', 'dave', 'Quirky   spacing,\t“smart quotes”, café, Ünïcode and 100% ASCII-free text — ok?'),
  L(7, '14:30', 'alice', 'x'.repeat(10) + ' ' + 'word '.repeat(80)),
];

function allVerified(draft, lines) {
  const ctx = buildContext(lines, []);
  for (const s of DRAFT_SECTIONS) for (const st of draft[s]) {
    const v = verifyStatement(st, ctx);
    assert.equal(v.status, 'verified', `${s}: ${st.text} -> ${JSON.stringify(v.reasons)}`);
  }
}

test('fallback: deterministic byte-identical, schema valid, all verified', () => {
  const a = JSON.stringify(buildFallbackDraft(corpus));
  const b = JSON.stringify(buildFallbackDraft([...corpus].reverse()));
  assert.equal(a, JSON.stringify(buildFallbackDraft(corpus)));
  assert.equal(a, b); // input order does not matter
  const d = JSON.parse(a);
  assert.equal(validateDraft(d).ok, true);
  allVerified(d, corpus);
  assert.ok(d.actionItems.length >= 1 && d.contributingFactors.length >= 1 && d.impact.length >= 1);
  assert.match(d.summary[0].text, /^First note: /);
  assert.match(d.summary[1].text, /^Last note: /);
});

test('fallback: long inputs are capped at 30 timeline statements, still valid and verified', () => {
  const lines = Array.from({ length: 500 }, (_, i) => L(i + 1, '10:00', 'alice', `step ${i + 1} failed because of a regression`));
  const d = buildFallbackDraft(lines);
  assert.equal(d.timeline.length, 30);
  assert.equal(validateDraft(d).ok, true);
  assert.equal(d.timeline[0].cites[0], 1);
  assert.equal(d.timeline.at(-1).cites[0], 500);
  assert.equal(JSON.stringify(d), JSON.stringify(buildFallbackDraft(lines)));
});

test('fallback: empty input is valid; provider is labelled fallback', async () => {
  assert.equal(validateDraft(buildFallbackDraft([])).ok, true);
  const p = assertProvider(createFallbackProvider());
  assert.equal(p.isFallback, true);
  assert.equal(p.id, 'fallback');
  assert.equal(await p.available(), true);
  const r1 = await p.generate({ incident: {}, lines: corpus });
  const r2 = await p.generate({ incident: {}, lines: corpus });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('fake providers: flagged and clean drafts are deterministic and verify as labelled', async () => {
  const flagged = createFakeProvider();
  const clean = createFakeProvider({ clean: true });
  assertProvider(flagged); assertProvider(clean);
  assert.equal(flagged.id, 'fake'); assert.equal(clean.id, 'fake-clean');
  const ctx = buildContext(corpus, []);
  const f = (await flagged.generate({ lines: corpus })).draft;
  const c = (await clean.generate({ lines: corpus })).draft;
  assert.deepEqual(f, (await flagged.generate({ lines: corpus })).draft);
  const flaggedCount = (d) => DRAFT_SECTIONS.flatMap((s) => d[s]).filter((s) => verifyStatement(s, ctx).status === 'flagged').length;
  assert.equal(flaggedCount(f), 2);
  assert.equal(flaggedCount(c), 0);
  assert.equal(validateDraft(f).ok && validateDraft(c).ok, true);
});
