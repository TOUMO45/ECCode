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
import { ProviderError } from '../../src/ai/provider.js';

function sink() {
  const chunks = [];
  return { chunks, write(s) { chunks.push(String(s)); return true; } };
}

test('provider faults and DB faults give generic envelopes; marker never leaks', async () => {
  const MARK = 'LEAK-MARKER-9f3a';
  const log = sink();
  const providers = {
    fake: scripted(async () => { throw Object.assign(new Error(`${MARK} at /home/x/secret.js`), { stack: `${MARK} stack` }); }),
    cli: scripted(async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', MARK); }, 'cli'),
  };
  const t = await startApp({ providers, logStream: log });
  try {
    const c = await t.client('aLead');
    const inc = await newIncident(c);
    await withNotes(c, inc.id);
    for (const p of ['fake', 'cli']) {
      const r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: p });
      assert.equal(r.status, 502);
      assert.equal(r.json.error.code, 'PROVIDER_UNAVAILABLE');
      assert.ok(!r.text.includes(MARK) && !/stack|\.js/.test(r.text));
      assert.equal(r.json.error.requestId, r.headers.get('x-request-id'));
    }
    assert.ok(!log.chunks.join('').includes(MARK));

    t.db.close(); // force an internal fault
    const r = await c.get('/api/incidents');
    assert.equal(r.status, 500);
    assert.equal(r.json.error.code, 'INTERNAL');
    assert.equal(r.json.error.message, 'Something went wrong');
    assert.deepEqual(Object.keys(r.json.error).sort(), ['code', 'message', 'requestId']);
    assert.ok(!log.chunks.join('').includes(MARK));
  } finally { await t.close(); }
});

test('error shapes carry request ids for 404, 405 and domain errors', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const c = await t.client('aLead');
    for (const [r, status] of [[await c.get('/api/nope'), 404], [await c.request('DELETE', '/api/incidents'), 405], [await c.get('/api/incidents/424242/draft'), 404]]) {
      assert.equal(r.status, status);
      assert.equal(r.json.error.requestId, r.headers.get('x-request-id'));
    }
  } finally { await t.close(); }
});
