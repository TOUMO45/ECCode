// A reviewed test tool (TR-R7-1, rev-mv4c60ve-01105860): a preload that simulates "the real date is N days later" for a Node process
// and every Node child it spawns, to show that the suite does not depend on today's date. NOT part of the product and not imported by
// any test; it is loaded only by the command line below.
//
//   CLOCK_SHIFT_DAYS=30 NODE_OPTIONS="--import ./test/helpers/shift-clock.mjs" npm test
//   (run it under the suite lock: flock /tmp/rescuestock-suite.lock ...; see docs/evidence-table.md, "Date robustness")
//
// What it shifts
//   - Date.now() and new Date() with NO argument: real time + CLOCK_SHIFT_DAYS. Every other use of Date (parsing, UTC(), formatting,
//     arguments, instanceof) is the real Date.
//   - File times, like a system clock that moved: the Stats of stat/lstat/fstat (sync, callback and fs.promises) report
//     atime/mtime/ctime/birthtime (and their *Ms fields) + the shift, and utimes/lutimes/futimes subtract it, so a time that a test
//     sets explicitly reads back unchanged.
//   - Children: NODE_OPTIONS is inherited, and test/helpers/node-proc.js MERGES into it (never replaces it); CLOCK_SHIFT_DAYS has no
//     RS_ prefix, so the server environment builder does not blank it. Every server a test starts therefore runs shifted too.
//
// What it does NOT shift (the blind spots, each checked against src/, test/, scripts/ and public/ by the reviewer; none is used there):
//   1. FileHandle.stat (fs.promises.open(...).stat()): reports real file times.
//   2. A STRING time passed to utimes/lutimes/futimes: passed through unchanged, so it does not round-trip with the shifted stat.
//   3. Intl.DateTimeFormat().format() with no date argument: reads the unpatched system clock.
//   4. Calling Date() WITHOUT new: the shifted class is not callable, so it throws a TypeError (loud, never silently wrong).
//   5. Children spawned with a MINIMAL environment (no NODE_OPTIONS): the live-refusal checks, the seed runner test and
//      start-old-node. They are time-irrelevant (exit codes) or pin RS_DEMO_DATE, so an unshifted child hides nothing about the
//      passage of time.
//   Also outside its reach: monotonic timers (performance.now, setTimeout), SQLite (the application uses no SQL clock: no
//   CURRENT_TIMESTAMP, no datetime('now')), and Chromium (a separate process; the client uses only relative time and cookies use
//   Max-Age).
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const DAYS = Number(process.env.CLOCK_SHIFT_DAYS ?? '0');
if (!Number.isFinite(DAYS)) throw new Error('CLOCK_SHIFT_DAYS must be a number');
const OFFSET = DAYS * 86_400_000;
const RealDate = Date;

class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + OFFSET);
    else super(...args);
  }

  static now() {
    return RealDate.now() + OFFSET;
  }
}
globalThis.Date = ShiftedDate;

const TIME_KEYS = ['atime', 'mtime', 'ctime', 'birthtime'];
function shiftStats(stats) {
  if (!stats || typeof stats !== 'object') return stats;
  for (const key of TIME_KEYS) {
    const ms = stats[`${key}Ms`];
    const date = stats[key]; // read first: the lazy Date is derived from the ms value, which is about to change
    if (typeof ms === 'number') stats[`${key}Ms`] = ms + OFFSET;
    else if (typeof ms === 'bigint') stats[`${key}Ms`] = ms + BigInt(OFFSET);
    if (date instanceof RealDate) stats[key] = new RealDate(date.getTime() + OFFSET);
  }
  return stats;
}
// A Date or a number of seconds is moved back by the shift; a string (blind spot 2) is left as it is.
const unshiftTime = (t) => (typeof t === 'number' ? t - OFFSET / 1000 : t instanceof RealDate ? new RealDate(t.getTime() - OFFSET) : t);

for (const name of ['stat', 'lstat', 'fstat']) {
  const sync = fs[`${name}Sync`];
  fs[`${name}Sync`] = function patched(...args) {
    const out = sync.apply(this, args);
    return out === undefined ? out : shiftStats(out);
  };
  const cb = fs[name];
  fs[name] = function patched(...args) {
    const last = args.length - 1;
    if (typeof args[last] === 'function') {
      const done = args[last];
      args[last] = (err, stats) => done(err, err ? stats : shiftStats(stats));
    }
    return cb.apply(this, args);
  };
  const prom = fs.promises[name];
  fs.promises[name] = async function patched(...args) {
    return shiftStats(await prom.apply(this, args));
  };
}
for (const name of ['utimes', 'lutimes']) {
  const sync = fs[`${name}Sync`];
  fs[`${name}Sync`] = (path, atime, mtime) => sync(path, unshiftTime(atime), unshiftTime(mtime));
  const cb = fs[name];
  fs[name] = (path, atime, mtime, done) => cb(path, unshiftTime(atime), unshiftTime(mtime), done);
  const prom = fs.promises[name];
  fs.promises[name] = (path, atime, mtime) => prom(path, unshiftTime(atime), unshiftTime(mtime));
}
{
  const sync = fs.futimesSync;
  fs.futimesSync = (fd, atime, mtime) => sync(fd, unshiftTime(atime), unshiftTime(mtime));
  const cb = fs.futimes;
  fs.futimes = (fd, atime, mtime, done) => cb(fd, unshiftTime(atime), unshiftTime(mtime), done);
}
syncBuiltinESMExports();
