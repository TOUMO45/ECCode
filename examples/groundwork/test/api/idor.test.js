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

function dump(t) {
  const q = (s) => t.db.prepare(s).all();
  return JSON.stringify([q('SELECT * FROM incidents'), q('SELECT * FROM note_lines'), q('SELECT * FROM drafts'), q('SELECT * FROM statements')]);
}

test('cross-team access is 404 and leaves data unchanged', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const a = await t.client('aLead');
    const inc = await newIncident(a);
    await withNotes(a, inc.id);
    const d = await withDraft(a, inc.id);
    const pub = await newIncident(a, { title: 'Second' });
    await withNotes(a, pub.id);
    const d2 = await withDraft(a, pub.id);
    assert.equal((await a.post(`/api/drafts/${d2.id}/publish`, { expectedVersion: d2.version })).status, 200);
    const sid = allStatements(d)[0].id;
    const before = dump(t);
    for (const who of ['bLead', 'bResponder']) {
      const b = await t.client(who);
      const calls = [
        ['GET', `/api/incidents/${inc.id}`], ['GET', `/api/incidents/${inc.id}/notes`],
        ['PUT', `/api/incidents/${inc.id}/notes`, { format: 'text', content: '14:05 a: b' }],
        ['GET', `/api/incidents/${inc.id}/draft`], ['POST', `/api/incidents/${inc.id}/draft`, { provider: 'fake' }],
        ['PATCH', `/api/drafts/${d.id}/statements/${sid}`, { expectedVersion: d.version, text: 'x' }],
        ['DELETE', `/api/drafts/${d.id}/statements/${sid}?expectedVersion=${d.version}`],
        ['GET', `/api/postmortems/${d2.id}`], ['GET', `/api/postmortems/${d.id}`],
      ];
      if (who === 'bLead') calls.push(['POST', `/api/drafts/${d.id}/publish`, { expectedVersion: d.version }]);
      for (const [m, p, body] of calls) {
        const r = body === undefined ? await b.request(m, p) : await b.request(m, p, { body });
        assert.equal(r.status, 404, `${who} ${m} ${p}`);
        assert.equal(r.json.error.code, 'NOT_FOUND');
      }
      assert.deepEqual((await b.get('/api/incidents')).json.incidents, []);
    }
    const bv = await t.client('bViewer');
    assert.equal((await bv.get(`/api/postmortems/${d2.id}`)).status, 404);
    assert.deepEqual((await bv.get('/api/postmortems')).json.postmortems, []);
    assert.equal(dump(t), before);
    // same-team viewer sees only published
    const av = await t.client('aViewer');
    assert.equal((await av.get(`/api/postmortems/${d.id}`)).status, 404);
    assert.equal((await av.get(`/api/postmortems/${d2.id}`)).status, 200);
    assert.equal((await av.get('/api/postmortems')).json.postmortems.length, 1);
    // statement of another draft addressed through my own draft id
    const own = await newIncident(a, { title: 'Third' });
    await withNotes(a, own.id);
    const d3 = await withDraft(a, own.id);
    const x = await a.patch(`/api/drafts/${d3.id}/statements/${sid}`, { expectedVersion: d3.version, text: 'x' });
    assert.equal(x.status, 404);
  } finally { await t.close(); }
});
