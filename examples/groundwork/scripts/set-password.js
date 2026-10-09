// Usage: GW_NEW_PASSWORD=... node scripts/set-password.js <username>
// (or pipe the password on stdin). The password is never taken from argv.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/auth/password.js';

export async function setPassword(db, username, password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new Error('password must be 10..128 characters');
  }
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) throw new Error('no such user');
  const hash = await hashPassword(password);
  db.tx(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // force re-login everywhere
  });
}

async function main() {
  const username = process.argv[2];
  if (!username) throw new Error('usage: set-password.js <username> (password in GW_NEW_PASSWORD or stdin)');
  const password = process.env.GW_NEW_PASSWORD ?? fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  const db = openDb(loadConfig().dbPath);
  migrate(db);
  await setPassword(db, username, password);
  db.close();
  console.log(`password updated for ${username}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`set-password failed: ${e.message}`); process.exit(1); });
}
