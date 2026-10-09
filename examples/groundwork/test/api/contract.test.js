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
import { validate } from '../../src/lib/schema.js';
import { responses, errorResponse, errorDetails } from '../../src/api/contract-schemas.js';

const conforms = (schema, json, label) => {
  const r = validate(schema, json);
  assert.ok(r.valid, `${label}: ${JSON.stringify(r.errors)}`);
};
const failsWith = (res, status, code, label) => {
  assert.equal(res.status, status, label);
  conforms(errorResponse, res.json, label);
  assert.equal(res.json.error.code, code, label);
  assert.equal(res.json.error.requestId, res.headers.get('x-request-id'), label);
  const d = errorDetails[code];
  if (d && res.json.error.details) conforms(d, res.json.error.details, `${label} details`);
  assert.ok(!/\bat \S+:\d+/.test(res.text), 'no stack traces');
};

test('success bodies match the contract schemas', async () => {
  const t = await startApp({ providers: { ...providerOf(badDraft), ...withFallback() } });
  try {
    const c = await t.client('aLead');
    conforms(responses.providers, (await c.get('/api/providers')).json, 'providers');
    const inc = await c.post('/api/incidents', { title: 'T', severity: 'SEV1', startedAt: '2026-10-08T14:00:00Z' });
    assert.equal(inc.status, 201);
    conforms(responses.createIncident, inc.json, 'createIncident');
    const id = inc.json.incident.id;
    conforms(responses.listIncidents, (await c.get('/api/incidents')).json, 'list');
    conforms(responses.getIncident, (await c.get(`/api/incidents/${id}`)).json, 'get');
    conforms(responses.getNotes, (await c.get(`/api/incidents/${id}/notes`)).json, 'notes empty');
    const put = await c.put(`/api/incidents/${id}/notes`, { format: 'text', content: NOTES });
    conforms(responses.putNotes, put.json, 'putNotes');
    conforms(responses.getNotes, (await c.get(`/api/incidents/${id}/notes`)).json, 'getNotes');
    const gen = await c.post(`/api/incidents/${id}/draft`, { provider: 'fake' });
    assert.equal(gen.status, 201);
    conforms(responses.generateDraft, gen.json, 'generate');
    conforms(responses.getDraft, (await c.get(`/api/incidents/${id}/draft`)).json, 'getDraft');
    conforms(responses.getIncident, (await c.get(`/api/incidents/${id}`)).json, 'incident with draft');
    const d = gen.json.draft;
    const f = allStatements(d).find((s) => s.status === 'flagged');
    const edit = await c.patch(`/api/drafts/${d.id}/statements/${f.id}`, { expectedVersion: d.version, text: 'alice deployed v2', cites: [1] });
    conforms(responses.editStatement, edit.json, 'edit');
    const [other] = allStatements(edit.json.draft).filter((s) => s.id !== f.id);
    const del = await c.delete(`/api/drafts/${d.id}/statements/${other.id}?expectedVersion=${edit.json.draft.version}`);
    conforms(responses.deleteStatement, del.json, 'delete');
    const pub = await c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: del.json.draft.version });
    assert.equal(pub.status, 200);
    conforms(responses.publish, pub.json, 'publish');
    conforms(responses.listPostmortems, (await c.get('/api/postmortems')).json, 'pm list');
    conforms(responses.getPostmortem, (await c.get(`/api/postmortems/${d.id}`)).json, 'pm get');

    const inc2 = (await c.post('/api/incidents', { title: 'F', severity: 'SEV4', startedAt: '2026-10-08T14:00:00Z' })).json.incident;
    await withNotes(c, inc2.id);
    const fb = await c.post(`/api/incidents/${inc2.id}/draft`, { provider: 'fallback' });
    conforms(responses.generateDraft, fb.json, 'fallback');
  } finally { await t.close(); }
});

test('documented error shapes', async () => {
  const t = await startApp({ providers: { fake: scripted(async () => ({ draft: badDraft(), usage: {} })) } });
  try {
    const c = await t.client('aLead');
    const inc = (await newIncident(c));
    failsWith(await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' }), 409, 'NO_NOTES', 'no notes');
    failsWith(await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: 'bad' }), 400, 'NOTES_INVALID', 'notes invalid');
    failsWith(await c.post('/api/incidents', {}), 400, 'VALIDATION_FAILED', 'validation');
    failsWith(await c.get('/api/incidents/9999'), 404, 'NOT_FOUND', 'nf');
    failsWith(await c.request('PUT', '/api/incidents', { body: {} }), 405, 'METHOD_NOT_ALLOWED', 'method');
    failsWith(await c.request('POST', '/api/incidents', { rawBody: '{', headers: { 'content-type': 'application/json' } }), 400, 'INVALID_JSON', 'json');
    failsWith(await c.request('POST', '/api/incidents', { rawBody: '{}', headers: { 'content-type': 'text/plain' } }), 415, 'UNSUPPORTED_MEDIA_TYPE', 'type');
    failsWith(await t.anon().get('/api/incidents'), 401, 'UNAUTHENTICATED', 'unauth');
    failsWith(await (await t.client('aViewer')).get('/api/incidents'), 403, 'FORBIDDEN', 'forbidden');
    await withNotes(c, inc.id);
    const d = await withDraft(c, inc.id);
    failsWith(await c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version }), 409, 'UNGROUNDED_STATEMENTS', 'ungrounded');
    failsWith(await c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: 99 }), 409, 'STALE_VERSION', 'stale');
    failsWith(await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: NOTES }), 409, 'NOTES_LOCKED', 'locked');
  } finally { await t.close(); }
});
