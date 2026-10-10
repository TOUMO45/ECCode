// technical-reviewer helper: why POST /api/requests failed in tr-r1-general.mjs G4 (prints the answer).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const imp = (p) => import(pathToFileURL(join(process.cwd(), p)));
const { DEMO_PASSWORD, startHarness } = await imp('test/helpers/app-harness.js');
const { createClient } = await imp('test/helpers/fixtures.js');
const h = await startHarness({ seed: true, record: false });
try {
  const c = createClient(h.request);
  await c.signIn('cafe1', DEMO_PASSWORD);
  for (let i = 0; i < 301; i++) await c.get('/api/requests');
  await c.post('/api/requests', { text: 'x' }, { headers: { 'X-CSRF-Token': 'bad-token' } });
  await c.post('/api/requests', { text: 'x' }, { headers: { Origin: 'https://evil.example' } });
  h.clock.advance(122_000);
  const r = await c.post('/api/requests', { text: 'separation' });
  console.log(r.status, r.text.slice(0, 300));
} finally {
  await h.close();
}
