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

const rows = (t, action) => t.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

test('each sensitive action writes exactly one audit row, without text', async () => {
  const t = await startApp({ providers: providerOf(badDraft) });
  try {
    const lead = await t.client('aLead');
    const inc = await newIncident(lead, { title: 'SECRET-TITLE-XYZ' });
    await withNotes(lead, inc.id, `${NOTES}\n14:30 bob: SECRET-NOTE-TEXT-123`);
    const d = await withDraft(lead, inc.id);
    const f = allStatements(d).find((s) => s.status === 'flagged');
    const ok = allStatements(d).find((s) => s.status === 'verified');
    await lead.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version }); // refused
    const e = await lead.patch(`/api/drafts/${d.id}/statements/${f.id}`, { expectedVersion: d.version, text: 'SECRET-EDIT-TEXT alice', cites: [1] });
    const v2 = e.json.draft.version;
    const del = await lead.delete(`/api/drafts/${d.id}/statements/${ok.id}?expectedVersion=${v2}`);
    await lead.post(`/api/drafts/${d.id}/publish`, { expectedVersion: del.json.draft.version }); // refused (edit flagged)

    for (const [action, n] of [['incident.create', 1], ['notes.import', 1], ['draft.generate', 1], ['statement.edit', 1], ['statement.delete', 1], ['draft.publish.refused', 2]]) {
      assert.equal(rows(t, action).length, n, action);
    }
    const gen = rows(t, 'draft.generate')[0];
    assert.equal(gen.team_id, t.users.aLead.teamId);
    assert.equal(gen.actor_user_id, t.users.aLead.id);
    assert.equal(gen.outcome, 'ok');
    assert.equal(gen.target_type, 'incident');
    assert.equal(gen.target_id, inc.id);
    assert.ok(gen.request_id);
    assert.equal(rows(t, 'draft.publish.refused')[0].outcome, 'fail');
    const all = JSON.stringify(t.db.prepare('SELECT * FROM audit_log').all());
    for (const secret of ['SECRET-TITLE-XYZ', 'SECRET-NOTE-TEXT', 'SECRET-EDIT-TEXT', 'correct-horse']) assert.ok(!all.includes(secret), secret);

    // failed generation + invalid notes are audited as failures
    const inc2 = await newIncident(lead);
    await lead.put(`/api/incidents/${inc2.id}/notes`, { format: 'text', content: 'garbage' });
    const bad = rows(t, 'notes.import').at(-1);
    assert.equal(bad.outcome, 'fail');
    assert.deepEqual(JSON.parse(bad.detail), { reason: 'invalid', errors: 1 });
  } finally { await t.close(); }
});

test('publish writes one ok row; audit endpoint is lead-only, team-scoped; rows are immutable', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const lead = await t.client('aLead');
    const inc = await newIncident(lead);
    await withNotes(lead, inc.id);
    const d = await withDraft(lead, inc.id);
    await lead.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version });
    assert.equal(rows(t, 'draft.publish').length, 1);
    const feed = await lead.get('/api/audit');
    assert.equal(feed.status, 200);
    assert.ok(feed.json.entries.some((x) => x.action === 'draft.publish' && x.outcome === 'ok'));
    assert.equal((await (await t.client('aResponder')).get('/api/audit')).status, 403);
    const other = await (await t.client('bLead')).get('/api/audit');
    assert.ok(!other.json.entries.some((x) => x.action === 'draft.publish'));
    assert.throws(() => t.db.prepare('UPDATE audit_log SET action = ?').run('x'));
    assert.throws(() => t.db.prepare('DELETE FROM audit_log').run());
  } finally { await t.close(); }
});
