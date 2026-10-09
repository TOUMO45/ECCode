// Deterministic providers for browser/API tests (enabled only with GW_ENABLE_FAKE=1 by the app wiring).
//  - fake:       contains flagged statements (no cite, missing line) next to verified quotes
//  - fake-clean: only verbatim quotes, all verified
import { buildFallbackDraft } from './fallback.js';
import { validateDraft } from './schema.js';

export const FAKE_MODEL = 'fake-model';
const usage = () => ({ model: FAKE_MODEL, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, attempts: 1 });

export function buildFakeDraft(lines, { clean }) {
  const sorted = [...lines].sort((a, b) => a.n - b.n);
  const base = buildFallbackDraft(sorted.slice(0, 3));
  const draft = { summary: [], impact: [], timeline: base.timeline, contributingFactors: [], actionItems: [] };
  if (base.summary[0]) draft.summary.push(base.summary[0]);
  if (!clean) {
    draft.summary.push({ text: 'The outage was caused by a failed database migration.', cites: [] });
    draft.impact.push({ text: 'Roughly 9999 customers were affected.', cites: [2147483647] });
  }
  const v = validateDraft(draft);
  if (!v.ok) throw new Error('fake produced an invalid draft');
  return v.draft;
}

export function createFakeProvider({ clean = false } = {}) {
  return {
    id: clean ? 'fake-clean' : 'fake',
    isFallback: false,
    async available() {
      return true;
    },
    async generate({ lines }) {
      return { draft: buildFakeDraft(lines, { clean }), usage: usage() };
    },
  };
}
