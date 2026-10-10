// technical-reviewer probe (rework-1, SEC-C-3 across processes): two server processes on one SQLite file
// (busy_timeout 5000), RS_GENERAL_RATE_LIMIT=50 per 60 s. One signed-in customer's session is used on both processes;
// 60 concurrent GET /api/requests are sent to each process at once (120 in total). Expected: exactly 50 answers 200,
// 70 answers 429 RATE_LIMITED general, no 5xx, and exactly 50 u:<id> rows in rate_events. Three rounds.
// Usage: node tr-r1-twoproc-limit.mjs   Exit 0 = no overshoot and no 5xx in any round.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const imp = (p) => import(pathToFileURL(join(process.cwd(), p)));
const { startServer, upcomingDemoDate } = await imp('test/helpers/server-proc.js');
const { createClient } = await imp('test/helpers/fixtures.js');

let failed = 0;
for (let round = 1; round <= 3; round++) {
  const env = { RS_DB_BUSY_TIMEOUT_MS: '5000', RS_DEMO_DATE: upcomingDemoDate(), RS_GENERAL_RATE_LIMIT: '50', RS_GENERAL_RATE_WINDOW_SEC: '60', RS_REGISTER_PER_IP_PER_HOUR: '1000' };
  const first = await startServer({ env, seed: true });
  const second = await startServer({ env, dir: first.dir, dbPath: first.dbPath });
  try {
    const a = createClient(first.request);
    await a.register({ username: `limit-${round}-${process.pid}`, password: 'limit-password-01', displayName: 'L' });
    const cookie = Object.entries(a.cookies()).map(([k, v]) => `${k}=${v}`).join('; ');
    const db0 = new DatabaseSync(first.dbPath, { readOnly: true });
    const userId = db0.prepare('SELECT id FROM users WHERE username = ?').get(`limit-${round}-${process.pid}`).id;
    db0.close();
    const send = (server) => server.request({ method: 'GET', path: '/api/requests', headers: { Cookie: cookie } });
    const jobs = [];
    for (let i = 0; i < 60; i++) { jobs.push(send(first)); jobs.push(send(second)); }
    const answers = await Promise.all(jobs);
    const tally = {};
    for (const r of answers) { const k = `${r.status}${r.json?.error ? ' ' + (r.json.error.details?.limit ?? r.json.error.code) : ''}`; tally[k] = (tally[k] || 0) + 1; }
    const db = new DatabaseSync(first.dbPath, { readOnly: true });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?").get(`u:${userId}`).n;
    db.close();
    const ok = tally['200'] === 50 && tally['429 general'] === 70 && rows === 50 && !answers.some((r) => r.status >= 500);
    if (!ok) failed++;
    const locked = [first, second].some((s) => /database is locked|SQLITE_BUSY/i.test(`${s.stdout()}\n${s.stderr()}`));
    if (locked) failed++;
    console.log(`${ok && !locked ? 'PASS' : 'FAIL'} round ${round}: ${JSON.stringify(tally)}; u:${userId} rows ${rows}; lock errors in logs: ${locked}`);
  } finally {
    await second.cleanup();
    await first.cleanup();
  }
}
console.log(failed ? `${failed} FAILED` : 'two processes never overshoot the general limit');
process.exit(failed ? 1 : 0);
