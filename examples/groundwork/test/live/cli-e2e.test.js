import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../support/harness.js';
import { SKIP, fixtureNotes, notesText } from './support.js';

test('live: API journey with the real CLI provider, flagged statements fixed or deleted, then published', { skip: SKIP, timeout: 240000 }, async () => {
  const t = await startApp({ env: { GW_CLI_MODEL: 'haiku', GW_CLI_MAX_BUDGET_USD: '0.10' } });
  try {
    const lead = await t.client('aLead');
    const provs = await lead.get('/api/providers');
    assert.equal(provs.status, 200);
    assert.equal(provs.json.providers.find((p) => p.id === 'cli')?.available, true);
    const inc = (await lead.post('/api/incidents', { title: 'Checkout outage', severity: 'SEV2', startedAt: '2026-10-08T14:00:00Z', description: 'live e2e' })).json.incident;
    const n = await lead.put(`/api/incidents/${inc.id}/notes`, { format: 'text', content: notesText(fixtureNotes()) });
    assert.equal(n.status, 200, n.text);
    const gen = await lead.post(`/api/incidents/${inc.id}/draft`, { provider: 'cli' });
    assert.equal(gen.status, 201, gen.text);
    let draft = gen.json.draft;
    console.log(`# generated: provider=${draft.provider ?? 'cli'} flagged=${draft.flaggedCount}`);
    for (const [section, list] of Object.entries(draft.sections)) {
      for (const s of list) {
        if (s.status !== 'flagged') continue;
        const r = await lead.delete(`/api/drafts/${draft.id}/statements/${s.id}?expectedVersion=${draft.version}`);
        assert.equal(r.status, 200, `${section} ${r.text}`);
        draft = r.json.draft;
      }
    }
    assert.equal(draft.flaggedCount, 0);
    const pub = await lead.post(`/api/drafts/${draft.id}/publish`, { expectedVersion: draft.version });
    assert.equal(pub.status, 200, pub.text);
    assert.equal(pub.json.draft.state, 'published');
  } finally { await t.close(); }
});
