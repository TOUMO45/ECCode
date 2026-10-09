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

test('journey: sign in, incident, notes, draft, refused, fix, publish, viewer reads', async () => {
  const t = await startApp({ providers: providerOf(badDraft) });
  try {
    const lead = await t.client('aLead');
    const me = await lead.get('/api/me');
    assert.equal(me.json.user.role, 'lead');
    const inc = await newIncident(lead);
    assert.equal(inc.noteCount, 0);
    assert.equal(inc.draft, null);
    const notes = await withNotes(lead, inc.id);
    assert.equal(notes.count, 3);
    const draft = await withDraft(lead, inc.id);
    assert.equal(draft.flaggedCount, 1);
    const flagged = allStatements(draft).find((s) => s.status === 'flagged');
    assert.ok(flagged.reasons.length > 0);

    const refused = await lead.post(`/api/drafts/${draft.id}/publish`, { expectedVersion: draft.version });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, 'UNGROUNDED_STATEMENTS');
    assert.equal(refused.json.error.details.statements[0].id, flagged.id);
    assert.equal(refused.json.error.details.statements[0].section, 'summary');

    const viewer = await t.client('aViewer');
    assert.deepEqual((await viewer.get('/api/postmortems')).json.postmortems, []);

    const fix = await lead.patch(`/api/drafts/${draft.id}/statements/${flagged.id}`, {
      expectedVersion: draft.version, text: 'alice deployed v2', cites: [1],
    });
    assert.equal(fix.status, 200);
    assert.equal(fix.json.draft.flaggedCount, 0);
    assert.equal(fix.json.draft.version, draft.version + 1);

    const pub = await lead.post(`/api/drafts/${draft.id}/publish`, { expectedVersion: fix.json.draft.version });
    assert.equal(pub.status, 200);
    assert.equal(pub.json.draft.state, 'published');
    assert.equal(pub.json.draft.publishedBy, t.users.aLead.id);

    const list = await viewer.get('/api/postmortems');
    assert.equal(list.json.postmortems.length, 1);
    assert.equal(list.json.postmortems[0].draftId, draft.id);
    const one = await viewer.get(`/api/postmortems/${draft.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.postmortem.lines.length, 3);
    assert.equal(one.json.postmortem.draft.state, 'published');

    const other = await t.client('bViewer');
    assert.equal((await other.get(`/api/postmortems/${draft.id}`)).status, 404);
    assert.deepEqual((await other.get('/api/postmortems')).json.postmortems, []);
  } finally { await t.close(); }
});
