// Child process for the concurrent-start test: opens the database file given as
// argv[2] and runs the migrations, then prints {"applied":[...],"skipped":[...]}.
// Not a test file (the name does not end in .test.js).
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';

const file = process.argv[2];
const db = openDb(file, { busyTimeoutMs: 5000 });
try {
  const result = migrate(db);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  db.close();
}
