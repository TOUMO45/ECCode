'use strict';
// What really happens in a school week: A/B pattern, closures and substitutions applied to the grid.
const repo = require('./repository');
const { addDays, daysBetween } = require('../lib/dates');

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/** Every lesson that runs in the week starting on `monday`, grouped by day. */
function buildWeek(db, monday) {
  const term = repo.termContaining(db, monday);
  const weekType = term ? (daysBetween(term.starts_on, monday) / 7) % 2 === 0 ? 'A' : 'B' : null;
  const periods = repo.periodsByNumber(db);
  const closures = repo.closuresByDate(db);
  const subs = repo.substitutionsByLessonDate(db);
  const classes = repo.lookup(db, 'classes');
  const teachers = repo.lookup(db, 'teachers');
  const rooms = repo.lookup(db, 'rooms');

  const days = DAY_NAMES.map((weekday, i) => {
    const date = addDays(monday, i);
    const closed = closures.get(date) || null;
    let lessons = [];
    if (term && !closed) {
      lessons = repo
        .lessonsOnWeekday(db, i + 1)
        .filter((l) => l.week_type === 'both' || l.week_type === weekType)
        .map((l) => {
          const sub = subs.get(`${l.id}|${date}`);
          const cancelled = Boolean(sub && sub.cancelled);
          const teacherId = (sub && sub.teacher_id) || l.teacher_id;
          const roomId = (sub && sub.room_id) || l.room_id;
          const period = periods.get(l.period);
          return {
            teacherId,
            roomId,
            classId: l.class_id,
            view: {
              period: l.period,
              start: period.start,
              end: period.end,
              subject: l.subject,
              class: classes.get(l.class_id).code,
              teacher: teachers.get(teacherId).name,
              room: rooms.get(roomId).code,
              substituted: Boolean(sub && !cancelled && (sub.teacher_id || sub.room_id)),
              cancelled,
            },
          };
        })
        .sort((a, b) => a.view.period - b.view.period || a.view.class.localeCompare(b.view.class));
    }
    return { date, weekday, closed, lessons };
  });
  return { week: monday, term: term ? term.name : null, weekType, days };
}

/** The week as the API shows it, keeping only the lessons for which `keep(lesson)` is true. */
function viewWeek(week, keep) {
  return {
    week: week.week,
    term: week.term,
    weekType: week.weekType,
    days: week.days.map((d) => ({ date: d.date, weekday: d.weekday, closed: d.closed, lessons: d.lessons.filter(keep).map((l) => l.view) })),
  };
}

module.exports = { buildWeek, viewWeek };
