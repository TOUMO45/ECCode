// Child process: opens the database file given as argv[2], takes the write lock with BEGIN IMMEDIATE and
// prints "locked". It holds the lock until stdin sends anything or closes, then rolls back and exits.
// Not a test file (the name does not end in .test.js). Started through lock-proc.js.
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: lock-holder.js <database file>\n');
  process.exit(2);
}

const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 0');
db.exec('BEGIN IMMEDIATE');
process.stdout.write('locked\n');

let released = false;
function release() {
  if (released) return;
  released = true;
  try {
    db.exec('ROLLBACK');
  } finally {
    db.close();
    process.exit(0);
  }
}
process.stdin.on('data', release);
process.stdin.on('end', release);
process.stdin.on('close', release);
process.once('SIGTERM', release);
