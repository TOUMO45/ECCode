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

test('incident input validation and data round-trip', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const c = await t.client('aResponder');
    const ok = { title: 'T', severity: 'SEV3', startedAt: '2026-10-08T14:00:00Z' };
    const bads = [
      {}, { ...ok, title: '' }, { ...ok, title: '   ' }, { ...ok, title: 'x'.repeat(141) }, { ...ok, severity: 'SEV9' },
      { ...ok, startedAt: 'yesterday' }, { ...ok, startedAt: '2026-99-99T99:99:99Z' }, { ...ok, description: 'x'.repeat(4001) },
      { ...ok, team_id: 2 }, { ...ok, status: 'published' }, { ...ok, title: 5 }, [], 'str', null,
    ];
    for (const b of bads) {
      const r = await c.post('/api/incidents', b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.json.error.code, 'VALIDATION_FAILED');
    }
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM incidents').get().n, 0);

    const nasty = `Robert'); DROP TABLE incidents;-- "q" <script>alert(1)</script> é中🚀`;
    const r = await c.post('/api/incidents', { ...ok, title: nasty, description: nasty });
    assert.equal(r.status, 201);
    assert.equal(r.json.incident.title, nasty);
    assert.equal((await c.get(`/api/incidents/${r.json.incident.id}`)).json.incident.description, nasty);
    const n = await c.put(`/api/incidents/${r.json.incident.id}/notes`, { format: 'json', content: [{ time: '14:05', author: "o'brien", text: nasty }] });
    assert.equal(n.json.lines[0].text, nasty);
    assert.equal(n.json.lines[0].author, "o'brien");
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM incidents').get().n, 1);
  } finally { await t.close(); }
});

test('malformed requests: JSON, media type, size, ids, unknown fields', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const c = await t.client('aLead');
    const inc = await newIncident(c);
    const raw = (p, rawBody, headers = {}) => c.request('PUT', p, { rawBody, headers: { 'content-type': 'application/json', ...headers } });
    let r = await raw(`/api/incidents/${inc.id}/notes`, '{not json');
    assert.equal(r.json.error.code, 'INVALID_JSON');
    r = await raw(`/api/incidents/${inc.id}/notes`, '{}', { 'content-type': 'text/plain' });
    assert.equal(r.status, 415);
    r = await raw(`/api/incidents/${inc.id}/notes`, JSON.stringify({ format: 'text', content: 'x'.repeat(1048576 + 10) }));
    assert.equal(r.status, 413);
    assert.equal(r.json.error.code, 'PAYLOAD_TOO_LARGE');
    r = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: '14:05 a: b', extra: 1 });
    assert.equal(r.json.error.code, 'VALIDATION_FAILED');
    r = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'json', content: [] });
    assert.equal(r.status, 400);
    r = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'json', content: Array.from({ length: 2001 }, () => ({ time: '14:05', author: 'a', text: 'b' })) });
    assert.equal(r.status, 400);
    r = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: `14:05 a: ${'x'.repeat(2001)}` });
    assert.equal(r.json.error.code, 'NOTES_INVALID');
    for (const id of ['0', 'abc', '-1', '99999999999', '1.5']) {
      assert.equal((await c.get(`/api/incidents/${id}`)).status, 404, id);
    }
    assert.equal((await c.get('/api/incidents/999999')).status, 404);
    assert.equal((await c.request('PATCH', `/api/incidents/${inc.id}`, { body: {} })).status, 405);
    r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake', x: 1 });
    assert.equal(r.status, 400);
    r = await c.get('/api/audit?limit=abc');
    assert.equal(r.status, 400);
    r = await c.get(`/api/incidents/${inc.id}?foo=1`);
    assert.equal(r.status, 400);
  } finally { await t.close(); }
});
