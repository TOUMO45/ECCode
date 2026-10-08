'use strict';
// Data access for the weekly grid and its exceptions.

function termContaining(db, day) {
  return db.all('terms').find((t) => t.starts_on <= day && day <= t.ends_on) || null;
}

function lessonsOnWeekday(db, weekday) {
  return db.all('lessons').filter((l) => l.weekday === weekday);
}

function periodsByNumber(db) {
  return new Map(db.all('periods').map((p) => [p.number, p]));
}

function closuresByDate(db) {
  return new Map(db.all('closures').map((c) => [c.date, c.reason]));
}

/** Substitutions keyed by `${lessonId}|${date}`. */
function substitutionsByLessonDate(db) {
  return new Map(db.all('substitutions').map((s) => [`${s.lesson_id}|${s.date}`, s]));
}

function lookup(db, table) {
  return new Map(db.all(table).map((r) => [r.id, r]));
}

module.exports = { termContaining, lessonsOnWeekday, periodsByNumber, closuresByDate, substitutionsByLessonDate, lookup };
