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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, PASSWORD } from '../support/harness.js';

test('data survives in-process reopen', async () => {
  const t = await startApp({ providers: providerOf(goodDraft) });
  let t2;
  try {
    const lead = await t.client('aLead');
    const inc = await newIncident(lead);
    await withNotes(lead, inc.id);
    const d = await withDraft(lead, inc.id);
    assert.equal((await lead.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version })).status, 200);
    await t.close({ keepDb: true });
    t2 = await startApp({ dbPath: t.dbPath, seedUsers: false, providers: providerOf(goodDraft) });
    // sessions persist in the DB, so the old cookies still work against the new instance cookie jar
    const v = new Client(t2.url);
    assert.equal((await v.login('a-viewer')).status, 200);
    const pm = await v.get(`/api/postmortems/${d.id}`);
    assert.equal(pm.status, 200);
    assert.equal(pm.json.postmortem.draft.state, 'published');
    assert.equal(pm.json.postmortem.lines.length, 3);
    assert.equal(pm.json.postmortem.draft.sections.summary[0].text, d.sections.summary[0].text);
  } finally { await t2?.close(); await t.close().catch(() => {}); }
});

function startProc(dbPath) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GW_DB_PATH: dbPath, PORT: '0', HOST: '127.0.0.1', GW_LOG: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not start')); }, 15000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /"event":"startup","url":"([^"]+)"/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, url: m[1] }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${buf}`)); });
  });
}
const stop = (child) => new Promise((resolve) => { child.removeAllListeners('exit'); child.once('exit', resolve); child.kill('SIGKILL'); });

test('data survives a spawned-process restart (real providers wired from config: fallback)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-proc-'));
  const dbPath = path.join(tmp, 'p.db');
  const seed = await startApp({ dbPath, providers: providerOf(goodDraft) });
  await seed.close({ keepDb: true });
  let p;
  try {
    p = await startProc(dbPath);
    const lead = new Client(p.url);
    assert.equal((await lead.login('a-lead', PASSWORD)).status, 200);
    const inc = await newIncident(lead);
    await withNotes(lead, inc.id);
    const list = await lead.get('/api/providers');
    assert.equal(list.json.providers.find((x) => x.id === 'fallback').available, true);
    assert.equal(list.json.providers.some((x) => x.id.startsWith('fake')), false);
    const d = await withDraft(lead, inc.id, 'fallback');
    assert.equal(d.isFallback, true);
    const pub = await lead.post(`/api/drafts/${d.id}/publish`, { expectedVersion: d.version });
    assert.equal(pub.status, 200);
    await stop(p.child);

    p = await startProc(dbPath);
    const viewer = new Client(p.url);
    assert.equal((await viewer.login('a-viewer', PASSWORD)).status, 200);
    const pm = await viewer.get(`/api/postmortems/${d.id}`);
    assert.equal(pm.status, 200);
    assert.equal(pm.json.postmortem.draft.isFallback, true);
    assert.equal(pm.json.postmortem.lines.length, 3);
    // a session cookie from before the restart is still valid (sessions persist in the DB)
    const again = new Client(p.url);
    again.jar = new Map(lead.jar);
    assert.equal((await again.get('/api/incidents')).status, 200);
  } finally {
    if (p) await stop(p.child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
