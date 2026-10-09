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

const failing = (code) => ({ fake: scripted(async () => { throw new ProviderError(code, 'x'); }) });

async function ready(t, who = 'aResponder') {
  const c = await t.client(who);
  const inc = await newIncident(c);
  await withNotes(c, inc.id);
  return { c, inc };
}
const counts = (t) => ({
  d: t.db.prepare('SELECT COUNT(*) n FROM drafts').get().n,
  s: t.db.prepare('SELECT COUNT(*) n FROM statements').get().n,
});

test('generate stores verifier output and regenerates with version bump', async () => {
  let call = 0;
  const t = await startApp({ providers: { fake: scripted(async () => ({ draft: call++ === 0 ? badDraft() : goodDraft(), usage: { model: 'm', inputTokens: 5, outputTokens: 6, costUsd: 0.01, durationMs: 7, attempts: 1 } })) } });
  try {
    const { c, inc } = await ready(t);
    const r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.usage, { provider: 'fake', model: 'm', inputTokens: 5, outputTokens: 6, costUsd: 0.01, durationMs: 7, attempts: 1 });
    assert.equal(r.json.draft.version, 1);
    assert.equal(r.json.draft.flaggedCount, 1);
    assert.equal(r.json.draft.isFallback, false);
    const g = await c.get(`/api/incidents/${inc.id}/draft`);
    assert.deepEqual(g.json.draft, r.json.draft);
    const r2 = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
    assert.equal(r2.json.draft.version, 2);
    assert.equal(r2.json.draft.id, r.json.draft.id);
    assert.equal(r2.json.draft.flaggedCount, 0);
    assert.equal(counts(t).s, allStatements(r2.json.draft).length);
    const inc2 = (await c.get(`/api/incidents/${inc.id}`)).json.incident;
    assert.equal(inc2.draft.version, 2);
  } finally { await t.close(); }
});

test('no draft yet: 404; no notes: NO_NOTES', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  try {
    const c = await t.client('aLead');
    const inc = await newIncident(c);
    assert.equal((await c.get(`/api/incidents/${inc.id}/draft`)).status, 404);
    const r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'NO_NOTES');
  } finally { await t.close(); }
});

for (const [code, status, details] of [
  ['PROVIDER_TIMEOUT', 504, { provider: 'fake', fallbackAvailable: true }],
  ['PROVIDER_BAD_OUTPUT', 502, { fallbackAvailable: true }],
  ['PROVIDER_UNAVAILABLE', 502, { provider: 'fake', fallbackAvailable: true }],
  ['PROVIDER_BUSY', 503, { fallbackAvailable: true }],
]) {
  test(`provider failure ${code} stores nothing and keeps the previous draft`, async () => {
    let fail = false;
    const t = await startApp({ providers: { fake: scripted(async () => { if (fail) throw new ProviderError(code, 'secret-marker'); return { draft: goodDraft(), usage: {} }; }) } });
    try {
      const { c, inc } = await ready(t);
      const before = await withDraft(c, inc.id);
      const snap = counts(t);
      fail = true;
      const r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
      assert.equal(r.status, status);
      assert.equal(r.json.error.code, code);
      assert.deepEqual(r.json.error.details, details);
      assert.ok(!r.text.includes('secret-marker'));
      if (code === 'PROVIDER_BUSY') assert.equal(r.headers.get('retry-after'), '5');
      assert.deepEqual(counts(t), snap);
      assert.deepEqual((await c.get(`/api/incidents/${inc.id}/draft`)).json.draft, before);
      // and with no previous draft
      const inc2 = await newIncident(c);
      await withNotes(c, inc2.id);
      assert.equal((await c.post(`/api/incidents/${inc2.id}/draft`, { provider: 'fake' })).status, status);
      assert.equal((await c.get(`/api/incidents/${inc2.id}/draft`)).status, 404);
    } finally { await t.close(); }
  });
}

test('provider that hangs hits the deadline (504) and is aborted', async () => {
  let aborted = false;
  const slow = scripted(({ signal }) => new Promise((_, rej) => { signal.addEventListener('abort', () => { aborted = true; rej(new Error('x')); }); }));
  const t = await startApp({ providers: { fake: slow }, config: { generateTimeoutMs: 200 } });
  try {
    const { c, inc } = await ready(t);
    const r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
    assert.equal(r.status, 504);
    assert.equal(r.json.error.code, 'PROVIDER_TIMEOUT');
    assert.equal(aborted, true);
    assert.deepEqual(counts(t), { d: 0, s: 0 });
    // lock released
    const r2 = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
    assert.equal(r2.status, 504);
  } finally { await t.close(); }
});

test('malformed provider output (unknown fields, wrong types, too many) is rejected', async () => {
  const outputs = [
    { ...goodDraft(), extra: [] },
    { ...goodDraft(), summary: 'x' },
    { ...goodDraft(), summary: [{ text: 'a', cites: [1], status: 'verified' }] },
    { ...goodDraft(), summary: [{ text: 'a', cites: ['1'] }] },
    { ...goodDraft(), summary: Array.from({ length: 31 }, () => ({ text: 'a', cites: [1] })) },
    null,
  ];
  let i = 0;
  const t = await startApp({ providers: { fake: scripted(async () => ({ draft: outputs[i++ % outputs.length], usage: {} })) } });
  try {
    const { c, inc } = await ready(t);
    for (let k = 0; k < outputs.length; k += 1) {
      const r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
      assert.equal(r.status, 502, `output ${k}`);
      assert.equal(r.json.error.code, 'PROVIDER_BAD_OUTPUT');
    }
    assert.deepEqual(counts(t), { d: 0, s: 0 });
  } finally { await t.close(); }
});

test('non-ProviderError exception yields a generic provider error without leaking', async () => {
  const t = await startApp({ providers: { fake: scripted(async () => { throw new Error('boom /etc/passwd sk-secret'); }) } });
  try {
    const { c, inc } = await ready(t);
    const r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
    assert.equal(r.status, 502);
    assert.ok(!/passwd|sk-secret|boom/.test(r.text));
  } finally { await t.close(); }
});

test('unknown / unavailable provider and auto with none configured', async () => {
  const t = await startApp({ providers: withFallback() });
  try {
    const { c, inc } = await ready(t);
    for (const p of ['auto', 'cli', 'anthropic', 'fake']) {
      const r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: p });
      assert.equal(r.status, 502, p);
      assert.equal(r.json.error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(r.json.error.details.fallbackAvailable, true);
    }
    const bad = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'gpt' });
    assert.equal(bad.status, 400);
  } finally { await t.close(); }
});

test('fallback draft is labelled isFallback and verifies', async () => {
  const t = await startApp({ providers: withFallback() });
  try {
    const { c, inc } = await ready(t);
    const r = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fallback' });
    assert.equal(r.status, 201);
    assert.equal(r.json.draft.isFallback, true);
    assert.equal(r.json.draft.provider, 'fallback');
    assert.equal(r.json.draft.flaggedCount, 0);
    assert.equal((await c.get(`/api/incidents/${inc.id}`)).json.incident.draft.isFallback, true);
    const prov = await c.get('/api/providers');
    assert.equal(prov.json.default, null);
    assert.equal(prov.json.providers.find((p) => p.id === 'fallback').isFallback, true);
  } finally { await t.close(); }
});

test('concurrent generation: second call gets GENERATION_IN_PROGRESS', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = await startApp({ providers: { fake: scripted(async () => { await gate; return { draft: goodDraft(), usage: {} }; }) } });
  try {
    const { c, inc } = await ready(t);
    const first = c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
    await new Promise((r) => setTimeout(r, 100));
    const second = await c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, 'GENERATION_IN_PROGRESS');
    release();
    assert.equal((await first).status, 201);
  } finally { release?.(); await t.close(); }
});

test('NOTES_CHANGED when notes are replaced during generation', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = await startApp({ providers: { fake: scripted(async () => { await gate; return { draft: goodDraft(), usage: {} }; }) } });
  try {
    const { c, inc } = await ready(t);
    const first = c.post(`/api/incidents/${inc.id}/draft`, { provider: 'fake' });
    await new Promise((r) => setTimeout(r, 100));
    await withNotes(c, inc.id, '14:05 alice: something else');
    release();
    const r = await first;
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'NOTES_CHANGED');
    assert.deepEqual(counts(t), { d: 0, s: 0 });
  } finally { release?.(); await t.close(); }
});

test('statement edit and delete: re-verification, stale version, validation', async () => {
  const t = await startApp({ providers: providerOf(badDraft) });
  try {
    const { c, inc } = await ready(t);
    const d = await withDraft(c, inc.id);
    const st = allStatements(d);
    const good = st.find((s) => s.status === 'verified');
    const url = (s) => `/api/drafts/${d.id}/statements/${s.id}`;

    const miss = await c.patch(url(good), { expectedVersion: d.version, cites: [1, 99] });
    assert.equal(miss.status, 200);
    const e = allStatements(miss.json.draft).find((s) => s.id === good.id);
    assert.equal(e.status, 'flagged');
    assert.ok(e.reasons.some((r) => r.code === 'MISSING_LINE' && r.detail === '99'));
    assert.equal(e.edited, true);
    assert.equal(miss.json.draft.version, d.version + 1);

    const stale = await c.patch(url(good), { expectedVersion: d.version, text: 'x' });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'STALE_VERSION');
    assert.equal(stale.json.error.details.currentVersion, d.version + 1);

    const v = d.version + 1;
    for (const body of [{ expectedVersion: v }, { expectedVersion: v, text: '   ' }, { expectedVersion: v, text: 'a\u0007b' }, { expectedVersion: v, status: 'verified', text: 'a' }, { text: 'a' }, { expectedVersion: v, cites: [0] }]) {
      const r = await c.patch(url(good), body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, 'VALIDATION_FAILED');
    }
    assert.equal((await c.patch(`/api/drafts/${d.id}/statements/999999`, { expectedVersion: v, text: 'a' })).status, 404);

    assert.equal((await c.delete(url(good))).status, 400);
    assert.equal((await c.delete(`${url(good)}?expectedVersion=abc`)).status, 400);
    assert.equal((await c.delete(`${url(good)}?expectedVersion=${d.version}`)).json.error.code, 'STALE_VERSION');
    const del = await c.delete(`${url(good)}?expectedVersion=${v}`);
    assert.equal(del.status, 200);
    assert.equal(allStatements(del.json.draft).length, st.length - 1);
    assert.equal(del.json.draft.version, v + 1);
  } finally { await t.close(); }
});
