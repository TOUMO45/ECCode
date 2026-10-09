// Child process: creates the database file given as argv[2] in the default (rollback) journal mode,
// takes an EXCLUSIVE lock, prints "locked", holds it for argv[3] milliseconds, then commits.
// Not a test file (the name does not end in .test.js).
import { DatabaseSync } from 'node:sqlite';

const [file, holdMs] = [process.argv[2], Number(process.argv[3])];
const db = new DatabaseSync(file);
db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER)');
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('locked\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
db.exec('COMMIT');
db.close();
