'use strict';
const { timezone } = require('../config');

/** Calendar day (YYYY-MM-DD) of an instant in the school's time zone. */
function localDay(instant, tz = timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Add whole days to a YYYY-MM-DD day. */
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from day `a` to day `b`. */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Weekday of a YYYY-MM-DD day: 1 (Monday) to 7 (Sunday). */
function weekdayOf(day) {
  return ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** The Monday on or before a day. */
function mondayOf(day) {
  return addDays(day, 1 - weekdayOf(day));
}

/** True for a real calendar day written as YYYY-MM-DD. */
function isDay(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
}

module.exports = { localDay, addDays, daysBetween, weekdayOf, mondayOf, isDay };
