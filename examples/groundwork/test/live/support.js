// Shared helpers for opt-in live tests (GW_LIVE=1). Real `claude -p` only; no API key is ever passed.
import { loadConfig } from '../../src/config.js';

export const LIVE = process.env.GW_LIVE === '1';
export const SKIP = LIVE ? false : 'SKIPPED: set GW_LIVE=1 (npm run test:live) to run live CLI tests';

export function liveConfig() {
  return loadConfig({ GW_CLI_MODEL: 'haiku', GW_CLI_MAX_BUDGET_USD: '0.10', GW_CLI_TIMEOUT_MS: '90000' });
}

export const incident = { title: 'Checkout outage', severity: 'SEV2', startedAt: '2026-10-08T14:00:00Z' };

/** ~30-line fixture. */
export function fixtureNotes() {
  const rows = [
    ['14:02', 'alice', 'Pager: checkout error rate above 30%'],
    ['14:03', 'bob', 'Ack, looking at the checkout dashboards'],
    ['14:05', 'alice', 'Deployed v2 of the checkout service twenty minutes ago'],
    ['14:07', 'bob', 'Error rate is 42% and latency is rising'],
    ['14:09', 'carol', 'Customers report failed payments'],
    ['14:12', 'bob', 'Decision: roll back the checkout deploy to v1'],
    ['14:14', 'alice', 'Rollback started'],
    ['14:18', 'alice', 'Rollback finished, error rate falling'],
    ['14:22', 'carol', 'Error rate back to 1%'],
    ['14:25', 'bob', 'Declaring the incident resolved'],
    ['14:30', 'bob', 'Action item: add a canary stage to the checkout deploy, owner alice'],
    ['14:31', 'carol', 'Action item: write the customer notice, owner carol'],
  ];
  const out = [];
  const filler = ['checking the logs', 'thanks, noted', 'watching the graphs'];
  let n = 1;
  for (const [time, author, text] of rows) {
    out.push({ n: n++, time, ts: null, author, text });
    out.push({ n: n++, time, ts: null, author: author === 'bob' ? 'alice' : 'bob', text: filler[n % 3] });
    if (n < 31) out.push({ n: n++, time, ts: null, author: 'carol', text: filler[(n + 1) % 3] });
  }
  return out;
}
export const notesText = (lines) => lines.map((l) => `${l.time} ${l.author}: ${l.text}`).join('\n');
