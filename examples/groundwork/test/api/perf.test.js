import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../support/harness.js';
import { createFallbackProvider } from '../../src/ai/fallback.js';

export const NOTES = [
  '14:05 alice: deployed v2 of the checkout service',
  '14:09 bob: error rate rose to 40% on checkout',
  '14:20 alice: rolled back the deploy and error rate recovered',
].join('\n');

/** Scripted provider registered under an allowed id. */
export function scripted(fn, id = 'fake') {
  return { id, isFallback: false, async available() { return true; }, generate: fn };
}
const U = { model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1, attempts: 1 };
export const goodDraft = () => ({
  summary: [{ text: 'alice deployed v2 of the checkout service', cites: [1] }],
  impact: [{ text: 'error rate rose to 40% on checkout', cites: [2] }],
  timeline: [{ text: '14:20 alice rolled back the deploy', cites: [3] }],
  contributingFactors: [], actionItems: [],
});
export const badDraft = () => {
  const d = goodDraft();
  d.summary.push({ text: 'Carol approved the release at 09:30', cites: [1] });
  return d;
};
export const providerOf = (draftFn) => ({ fake: scripted(async () => ({ draft: draftFn(), usage: U })) });
export const withFallback = (extra = {}) => ({ ...extra, fallback: createFallbackProvider() });

export async function setup(opts = {}) {
  const t = await startApp(opts);
  return t;
}
export async function newIncident(c, over = {}) {
  const r = await c.post('/api/incidents', { title: 'Checkout outage', severity: 'SEV2', startedAt: '2026-10-08T14:00:00Z', description: 'd', ...over });
  if (r.status !== 201) throw new Error(`incident create ${r.status}`);
  return r.json.incident;
}
export async function withNotes(c, id, content = NOTES) {
  const r = await c.put(`/api/incidents/${id}/notes`, { format: 'text', content });
  if (r.status !== 200) throw new Error(`notes ${r.status} ${r.text}`);
  return r.json;
}
export async function withDraft(c, id, provider = 'fake') {
  const r = await c.post(`/api/incidents/${id}/draft`, { provider });
  if (r.status !== 201) throw new Error(`draft ${r.status} ${r.text}`);
  return r.json.draft;
}
export const allStatements = (d) => Object.values(d.sections).flat();

test('non-AI API p95 below 200 ms over 200 sequential requests on a seeded DB', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const c = await t.client('aLead');
    let first;
    for (let i = 0; i < 30; i += 1) {
      const inc = await newIncident(c, { title: `Inc ${i}` });
      first ??= inc;
      await withNotes(c, inc.id, Array.from({ length: 50 }, (_, k) => `14:${String(k % 60).padStart(2, '0')} alice: line ${k} of the checkout service`).join('\n'));
    }
    const d = await withDraft(c, first.id);
    const paths = ['/api/incidents', `/api/incidents/${first.id}`, `/api/incidents/${first.id}/notes`, `/api/incidents/${first.id}/draft`, '/api/postmortems', '/api/providers'];
    const times = [];
    for (let i = 0; i < 200; i += 1) {
      const s = process.hrtime.bigint();
      const r = await c.get(paths[i % paths.length]);
      times.push(Number(process.hrtime.bigint() - s) / 1e6);
      assert.equal(r.status, 200);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    assert.ok(p95 < 200, `p95 ${p95.toFixed(1)} ms`);
    assert.ok(d.id > 0);
  } finally { await t.close(); }
});
