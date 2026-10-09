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

test('notes: formats, errors, idempotent replace, lock, notes_rev', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const c = await t.client('aResponder');
    const inc = await newIncident(c);
    const rev = () => t.db.prepare('SELECT notes_rev FROM incidents WHERE id = ?').get(inc.id).notes_rev;
    assert.equal((await c.get(`/api/incidents/${inc.id}/notes`)).json.lines.length, 0);

    const bad = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: `${NOTES}\n\n25:00 x: y\nnonsense` });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'NOTES_INVALID');
    assert.deepEqual(bad.json.error.details.lines.map((l) => l.line), [5, 6]); // physical lines incl. blank
    assert.equal(bad.json.error.details.total, 2);
    assert.equal(rev(), 0);
    assert.equal((await c.get(`/api/incidents/${inc.id}/notes`)).json.lines.length, 0);

    const blank = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: '\n  \n' });
    assert.equal(blank.status, 400);
    assert.equal(blank.json.error.code, 'NOTES_INVALID');

    const a = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: NOTES });
    const b = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: NOTES });
    assert.deepEqual(a.json, b.json);
    assert.equal(rev(), 2);
    assert.deepEqual(a.json.lines[0], { n: 1, time: '14:05', ts: null, author: 'alice', text: 'deployed v2 of the checkout service' });

    const j = await c.put(`/api/incidents/${inc.id}/notes`, {
      format: 'json', content: [{ time: '2026-10-08T14:05:30Z', author: 'zed', text: 'hello' }, { time: '9:07', author: 'amy', text: 'x' }],
    });
    assert.equal(j.status, 200);
    assert.equal(j.json.lines[0].ts, '2026-10-08T14:05:30Z');
    assert.equal(j.json.lines[0].time, '14:05');
    assert.equal(j.json.lines[1].time, '09:07');
    const badJson = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'json', content: [{ time: '14:05', author: 'a', text: 'x' }, { time: 'nope', author: 'a', text: 'x' }] });
    assert.equal(badJson.json.error.details.lines[0].line, 2);

    const u = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'xml', content: 'x' });
    assert.equal(u.status, 400);
    assert.equal(u.json.error.code, 'VALIDATION_FAILED');

    await withNotes(c, inc.id);
    await withDraft(c, inc.id);
    const locked = await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: NOTES });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error.code, 'NOTES_LOCKED');
    assert.equal((await c.get(`/api/incidents/${inc.id}/notes`)).json.lines.length, 3);
    assert.equal((await c.get(`/api/incidents/${inc.id}`)).json.incident.noteCount, 3);
  } finally { await t.close(); }
});
