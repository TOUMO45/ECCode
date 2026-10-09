// Time: Asia/Amman local time <-> UTC through Intl. No constant offset is ever used; the zone's rules (including
// any historical or future change in ICU data) decide the offset at each instant. Nothing here reads the system
// clock: callers pass instants in.

export const TIME_ZONE = 'Asia/Amman';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^(\d{2}):(\d{2})$/;

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function wallParts(ms) {
  const parts = {};
  for (const p of formatter.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

// Offset of the zone from UTC, in minutes, at the instant `ms` (positive east of Greenwich).
export function offsetMinutesAt(ms) {
  if (!Number.isFinite(ms)) throw new RangeError('instant must be a finite number of milliseconds');
  const w = wallParts(ms);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const whole = Math.floor(ms / 1000) * 1000;
  return Math.round((wallAsUtc - whole) / 60000);
}

// Strict timestamp parse. Accepts ISO-8601 with an explicit zone ("Z" or +hh:mm) and returns epoch milliseconds.
export function parseTs(ts) {
  if (typeof ts !== 'string') throw new TypeError('timestamp must be a string');
  const m = TS_RE.exec(ts);
  if (!m) throw new RangeError('timestamp must be ISO-8601 with an explicit zone');
  const [, y, mo, d, h, mi, s = '0', frac = '0', zone] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(frac.padEnd(3, '0')));
  const back = new Date(ms);
  if (back.getUTCFullYear() !== Number(y) || back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d) ||
      back.getUTCHours() !== Number(h) || back.getUTCMinutes() !== Number(mi)) {
    throw new RangeError('timestamp is not a real calendar instant');
  }
  if (zone === 'Z') return ms;
  const sign = zone[0] === '-' ? -1 : 1;
  return ms - sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60000;
}

// Canonical Ts string: ISO-8601 UTC with milliseconds, "2026-10-20T07:00:00.000Z".
export function toTs(ms) {
  if (!Number.isFinite(ms)) throw new RangeError('instant must be a finite number of milliseconds');
  return new Date(ms).toISOString();
}

export function normalizeTs(ts) {
  return toTs(parseTs(ts));
}

// LocalDateTime ("YYYY-MM-DDTHH:MM", Asia/Amman) -> epoch milliseconds. Rejects impossible dates and local times
// that do not exist in the zone (a skipped hour). For a repeated hour one of the two instants is returned, always the same one.
export function localToUtcMs(local) {
  if (typeof local !== 'string') throw new TypeError('local date-time must be a string');
  const m = LOCAL_RE.exec(local);
  if (!m) throw new RangeError('local date-time must look like YYYY-MM-DDTHH:MM');
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) {
    throw new RangeError('local date-time is not a real calendar time');
  }
  // Two-step fixed point: the offset at the guess may differ from the offset at the answer near a transition.
  let result = naive - offsetMinutesAt(naive) * 60000;
  result = naive - offsetMinutesAt(result) * 60000;
  const w = wallParts(result);
  if (w.year !== year || w.month !== month || w.day !== day || w.hour !== hour || w.minute !== minute) {
    throw new RangeError('local time does not exist in Asia/Amman');
  }
  return result;
}

export function localToUtc(local) {
  return toTs(localToUtcMs(local));
}

// Instant (epoch ms or Ts string) -> LocalDateTime "YYYY-MM-DDTHH:MM" in Asia/Amman.
export function utcToLocal(instant) {
  const ms = typeof instant === 'number' ? instant : parseTs(instant);
  const w = wallParts(ms);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

// "HH:MM" wall-clock time of an instant in Asia/Amman.
export function formatLocalTime(instant) {
  return utcToLocal(instant).slice(11);
}

// "YYYY-MM-DD" calendar day of an instant in Asia/Amman (used for the daily counters).
export function localDay(instant) {
  return utcToLocal(instant).slice(0, 10);
}

// Local calendar date "YYYY-MM-DD" plus wall-clock "HH:MM" -> Ts. Used to place a fixture's "ready 10:30" on its day.
export function localTimeOnDate(date, hhmm) {
  if (!DATE_RE.test(date)) throw new RangeError('date must look like YYYY-MM-DD');
  parseHHMM(hhmm);
  return localToUtc(`${date}T${hhmm}`);
}

// "10:30" -> 630 minutes after midnight. Rejects 24:00 and out-of-range fields.
export function parseHHMM(text) {
  if (typeof text !== 'string') throw new TypeError('time must be a string');
  const m = HHMM_RE.exec(text);
  if (!m) throw new RangeError('time must look like HH:MM');
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new RangeError('time is out of range');
  return h * 60 + mi;
}

export function formatHHMM(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) throw new RangeError('minutes must be 0..1439');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function minutesBetween(fromMs, toMs) {
  return (toMs - fromMs) / 60000;
}
