// Clock interface: { now(): number } in milliseconds since the epoch.
// Services receive a clock by injection so tests can pin time.

export const systemClock = Object.freeze({
  now() {
    return Date.now();
  },
});

// A settable clock for tests. advance(ms) and set(ms) move it.
export function fixedClock(startMs) {
  if (!Number.isSafeInteger(startMs)) throw new TypeError('fixedClock needs an integer millisecond value');
  let current = startMs;
  return {
    now() {
      return current;
    },
    set(ms) {
      if (!Number.isSafeInteger(ms)) throw new TypeError('clock.set needs an integer millisecond value');
      current = ms;
    },
    advance(ms) {
      if (!Number.isSafeInteger(ms)) throw new TypeError('clock.advance needs an integer millisecond value');
      current += ms;
    },
  };
}

export const DEMO_TIME_ZONE = 'Asia/Amman';

export function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

function zoneParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

// Local calendar date (YYYY-MM-DD) of an instant in a time zone, via Intl.
export function localDateInZone(ms, timeZone = DEMO_TIME_ZONE) {
  const p = zoneParts(ms, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Converts a local wall-clock time in a zone to a UTC instant (ms) via Intl.
// The offset is derived from the zone database, never from a constant.
export function zonedTimeToUtcMs(dateText, timeText, timeZone = DEMO_TIME_ZONE) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  const t = /^(\d{2}):(\d{2})$/.exec(timeText);
  if (!d || !t) throw new TypeError('zonedTimeToUtcMs needs YYYY-MM-DD and HH:MM');
  const asUtc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const next = guess - (shown - asUtc);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
