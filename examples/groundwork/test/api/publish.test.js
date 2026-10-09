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
import { buildContext, verifyStatement } from '../../src/verify/index.js';

async function ungrounded(t, who = 'aLead') {
  const c = await t.client(who);
  const inc = await newIncident(c);
  await withNotes(c, inc.id);
  const d = await withDraft(c, inc.id);
  return { c, inc, d };
}
const state = (t, id) => ({ ...t.db.prepare("SELECT state, version FROM drafts WHERE id = ?").get(id) });

function assertPublishedGrounded(t, incId, draftId) {
  const lines = t.db.prepare('SELECT n, time, ts, author, text FROM note_lines WHERE incident_id = ?').all(incId);
  const ctx = buildContext(lines, ['a-lead', 'A lead', 'a-responder', 'A responder', 'a-viewer', 'A viewer']);
  for (const s of t.db.prepare('SELECT text, cites FROM statements WHERE draft_id = ?').all(draftId)) {
    assert.equal(verifyStatement({ text: s.text, cites: JSON.parse(s.cites) }, ctx).status, 'verified', s.text);
  }
}

test('publish refused while flagged; tampered stored status does not help', async () => {
  const t = await startApp({ providers: providerOf(badDraft) });
  try {
    const { c, d } = await ungrounded(t);
    const r = await c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'UNGROUNDED_STATEMENTS');
    t.db.prepare("UPDATE statements SET status = 'verified', reasons = '[]' WHERE draft_id = ?").run(d.id);
    const r2 = await c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version });
    assert.equal(r2.status, 409);
    assert.equal(r2.json.error.code, 'UNGROUNDED_STATEMENTS');
    assert.equal(r2.json.error.details.statements.length, 1);
    assert.ok(r2.json.error.details.statements[0].reasons.length > 0);
    assert.deepEqual(state(t, d.id), { state: 'draft', version: d.version });
    // refused statuses were not refreshed by the rolled-back transaction
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM statements WHERE draft_id = ? AND status = 'flagged'").get(d.id).n, 0);
    const refused = t.db.prepare("SELECT outcome FROM audit_log WHERE action = 'draft.publish.refused'").all();
    assert.equal(refused.length, 2);
    assert.equal(refused[0].outcome, 'fail');
  } finally { await t.close(); }
});

test('publish: stale version, success, then everything is DRAFT_PUBLISHED', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const { c, inc, d } = await ungrounded(t);
    const stale = await c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version + 5 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'STALE_VERSION');
    assert.equal(stale.json.error.details.currentVersion, d.version);
    const ok = await c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.draft.version, d.version + 1);
    assert.ok(ok.json.draft.publishedAt);
    assert.equal(ok.json.draft.flaggedCount, 0);
    const sid = allStatements(d)[0].id;
    const v = ok.json.draft.version;
    const results = await Promise.all([
      c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: v }),
      c.patch(`/api/drafts/${d.id}/statements/${sid}`, { expectedVersion: v, text: 'x' }),
      c.delete(`/api/drafts/${d.id}/statements/${sid}?expectedVersion=${v}`),
      c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' }),
    ]);
    for (const r of results) {
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'DRAFT_PUBLISHED');
    }
    assert.deepEqual(state(t, d.id), { state: 'published', version: v });
    assert.equal((await c.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: NOTES })).json.error.code, 'NOTES_LOCKED');
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'draft.publish' AND outcome = 'ok'").get().n, 1);
  } finally { await t.close(); }
});

test('responder and viewer cannot publish (403 before lookup); empty draft is 400', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const { c, d } = await ungrounded(t, 'aLead');
    const resp = await t.client('aResponder');
    const viewer = await t.client('aViewer');
    for (const who of [resp, viewer]) {
      assert.equal((await who.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version })).status, 403);
      assert.equal((await who.post('/api/drafts/999999/publish', { expectedVersion: 1 })).status, 403);
    }
    assert.equal(state(t, d.id).state, 'draft');
    let v = d.version;
    for (const s of allStatements(d)) {
      const r = await c.delete(`/api/drafts/${d.id}/statements/${s.id}?expectedVersion=${v}`);
      v = r.json.draft.version;
    }
    const e = await c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: v });
    assert.equal(e.status, 400);
    assert.equal(e.json.error.code, 'VALIDATION_FAILED');
    assert.equal(e.json.error.details.fields[0].path, 'draft');
    assert.equal(state(t, d.id).state, 'draft');
  } finally { await t.close(); }
});

test('interleaved edit/publish never publishes a flagged statement', async () => {
  const t = await startApp({ providers: providerOf(badDraft) });
  try {
    const c = await t.client('aLead');
    const r1 = await t.client('aResponder');
    let published = 0;
    for (let i = 0; i < 50; i += 1) {
      const inc = await newIncident(c);
      await withNotes(c, inc.id);
      const d = await withDraft(c, inc.id);
      const f = allStatements(d).find((s) => s.status === 'flagged');
      const v = d.version;
      const ops = [
        () => r1.patch(`/api/drafts/${d.id}/statements/${f.id}`, { expectedVersion: v, text: 'Carol approved the release at 09:30', cites: [1] }),
        () => r1.patch(`/api/drafts/${d.id}/statements/${f.id}`, { expectedVersion: v, text: 'alice deployed v2', cites: [1] }),
        () => c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: v }),
        () => c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: v + 1 }),
        () => c.post(`/api/drafts/${d.id}/publish`, { expectedVersion: v + 2 }),
        () => r1.patch(`/api/drafts/${d.id}/statements/${f.id}`, { expectedVersion: v + 1, cites: [1, 2] }),
      ];
      const order = ops.map((o, k) => [o, (k * 7 + i * 3) % 11]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
      if (i % 2) order.reverse();
      const res = await Promise.all(order.map((o) => o()));
      for (const r of res) assert.ok([200, 409].includes(r.status), `status ${r.status} ${r.text}`);
      // storage invariant, independent of the response codes
      const row = state(t, d.id);
      if (row.state === 'published') {
        published += 1;
        assertPublishedGrounded(t, inc.id, d.id);
      }
    }
    assert.ok(published > 0, 'the interleavings should publish at least once');
  } finally { await t.close(); }
});
