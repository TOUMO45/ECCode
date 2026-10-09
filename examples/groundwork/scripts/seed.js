// Idempotent demo seed (D9): teams Platform and Payments, each with a lead,
// responder and viewer, plus one sample incident with notes in Platform.
// Passwords are documented demo values: GW_SEED_PASSWORD or the default below.
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/auth/password.js';

export const DEMO_PASSWORD = 'groundwork-demo-1';

export const TEAMS = [
  { name: 'Platform', slug: 'platform' },
  { name: 'Payments', slug: 'payments' },
];
const ROLES = ['lead', 'responder', 'viewer'];

const SAMPLE_INCIDENT = {
  title: 'Checkout API elevated 5xx errors',
  severity: 'SEV2',
  startedAt: '2026-10-07T14:02:00.000Z',
  description: 'Sample incident created by the seed script.',
  lines: [
    ['14:02', 'alice', 'Alert fired: checkout-api 5xx rate at 12% for 3 minutes'],
    ['14:05', 'alice', 'Acknowledged page, starting investigation of checkout-api'],
    ['14:09', 'bob', 'Deploy v2.31 went out at 13:58, error rate climbed right after'],
    ['14:14', 'bob', 'Rolled back checkout-api to v2.30'],
    ['14:21', 'alice', 'Error rate back to baseline, customers no longer seeing failures'],
    ['14:30', 'carol', 'Action item: add a canary stage to the checkout-api deploy pipeline, owner bob'],
  ],
};

/** @param opts { password?, passwordHash?, now? } returns counts of rows created. */
export async function seed(db, { password = DEMO_PASSWORD, passwordHash, now = () => new Date() } = {}) {
  const hash = passwordHash ?? await hashPassword(password);
  const at = now().toISOString();
  const created = { teams: 0, users: 0, incidents: 0 };
  db.tx(() => {
    for (const t of TEAMS) {
      let team = db.prepare('SELECT id FROM teams WHERE name = ?').get(t.name);
      if (!team) {
        const info = db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(t.name, at);
        team = { id: Number(info.lastInsertRowid) };
        created.teams++;
      }
      for (const role of ROLES) {
        const username = `${t.slug}-${role}`;
        if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) continue;
        db.prepare(`INSERT INTO users (team_id, username, display_name, role, password_hash, created_at)
          VALUES (?,?,?,?,?,?)`).run(team.id, username, `${t.name} ${role[0].toUpperCase()}${role.slice(1)}`, role, hash, at);
        created.users++;
      }
    }
    const platform = db.prepare("SELECT id FROM teams WHERE name = 'Platform'").get();
    const exists = db.prepare('SELECT 1 FROM incidents WHERE team_id = ? AND title = ?').get(platform.id, SAMPLE_INCIDENT.title);
    if (!exists) {
      const lead = db.prepare("SELECT id FROM users WHERE username = 'platform-lead'").get();
      const info = db.prepare(`INSERT INTO incidents (team_id, title, severity, started_at, description, notes_rev, created_by, created_at)
        VALUES (?,?,?,?,?,1,?,?)`).run(platform.id, SAMPLE_INCIDENT.title, SAMPLE_INCIDENT.severity, SAMPLE_INCIDENT.startedAt,
        SAMPLE_INCIDENT.description, lead.id, at);
      const iid = Number(info.lastInsertRowid);
      SAMPLE_INCIDENT.lines.forEach(([time, author, text], i) => {
        db.prepare('INSERT INTO note_lines (incident_id, n, time, ts, author, text) VALUES (?,?,?,NULL,?,?)').run(iid, i + 1, time, author, text);
      });
      created.incidents++;
    }
  });
  return created;
}

async function main() {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  migrate(db);
  const password = config.seedPassword || DEMO_PASSWORD;
  if (password.length < 10 || password.length > 128) throw new Error('GW_SEED_PASSWORD must be 10..128 characters');
  const created = await seed(db, { password });
  db.close();
  const demo = config.seedPassword ? '(from GW_SEED_PASSWORD)' : `demo password: ${DEMO_PASSWORD}`;
  console.log(`seed ok: ${created.teams} teams, ${created.users} users, ${created.incidents} incidents created; ${demo}`);
  console.log('users: platform-lead|responder|viewer, payments-lead|responder|viewer');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`seed failed: ${e.message}`); process.exit(1); });
}
