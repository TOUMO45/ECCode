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

test('role matrix', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const lead = await t.client('aLead');
    const inc = await newIncident(lead);
    await withNotes(lead, inc.id);
    const d = await withDraft(lead, inc.id);
    const sid = allStatements(d)[0].id;
    const viewer = await t.client('aViewer');
    const resp = await t.client('aResponder');
    const calls = [
      ['GET', '/api/providers'], ['GET', '/api/incidents'], ['POST', '/api/incidents', { title: 'x', severity: 'SEV1', startedAt: '2026-10-08T00:00:00Z' }],
      ['GET', `/api/incidents/${inc.id}`], ['GET', `/api/incidents/${inc.id}/notes`],
      ['PUT', `/api/incidents/${inc.id}/notes`, { format: 'text', content: '14:05 a: b' }],
      ['GET', `/api/incidents/${inc.id}/draft`], ['POST', `/api/incidents/${inc.id}/draft`, { provider: 'fake' }],
      ['PATCH', `/api/drafts/${d.id}/statements/${sid}`, { expectedVersion: 1, text: 'x' }],
      ['DELETE', `/api/drafts/${d.id}/statements/${sid}?expectedVersion=1`],
      ['POST', `/api/drafts/${d.id}/publish`, { expectedVersion: 1 }],
    ];
    const call = (c, [m, p, b]) => (b === undefined ? c.request(m, p) : c.request(m, p, { body: b }));
    for (const x of calls) {
      const r = await call(viewer, x);
      assert.equal(r.status, 403, `viewer ${x[0]} ${x[1]}`);
      assert.equal(r.json.error.code, 'FORBIDDEN');
    }
    const r = await call(resp, calls.at(-1));
    assert.equal(r.status, 403);
    for (const x of calls.slice(0, -1).filter((y) => y[0] === 'GET')) assert.equal((await call(resp, x)).status, 200, x[1]);
    for (const c of [viewer, resp, lead]) {
      assert.equal((await c.get('/api/postmortems')).status, 200);
    }
    const anon = t.anon();
    for (const x of calls) assert.equal((await call(anon, x)).status, 401);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'access.denied'").get().n, 2); // publish denials only
  } finally { await t.close(); }
});
