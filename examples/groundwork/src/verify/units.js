// Unit table (spec 5.3 rule 4). Maps surface forms to a canonical unit.
export const UNIT_MAP = Object.freeze({
  minutes: 'minute', minute: 'minute', mins: 'minute', min: 'minute',
  seconds: 'second', second: 'second', secs: 'second', sec: 'second', s: 'second',
  hours: 'hour', hour: 'hour', hrs: 'hour', hr: 'hour', h: 'hour',
  milliseconds: 'ms', millisecond: 'ms', ms: 'ms',
  '%': 'percent', percent: 'percent', pct: 'percent',
  kb: 'kb', mb: 'mb', gb: 'gb', tb: 'tb',
  days: 'day', day: 'day',
});

const alt = Object.keys(UNIT_MAP)
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

export const UNIT_ALT = alt;
// Unit directly following a number; used sticky at the end of a number.
export const UNIT_AFTER_RE = new RegExp(`\\s*(${alt})(?![\\p{L}\\d_])`, 'yiu');
export const NUMBER_RE_SRC = '(?<![\\w.-])\\d+(?:\\.\\d+)?(?![\\w-])';

export function canonUnit(u) {
  return UNIT_MAP[String(u).toLowerCase()] ?? null;
}
