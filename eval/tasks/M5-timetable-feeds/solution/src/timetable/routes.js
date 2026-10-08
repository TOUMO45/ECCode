'use strict';
const { json, problem, HttpError } = require('../../vendor/acme-kit/http');
const classes = require('../classes/repository');
const teachers = require('../teachers/repository');
const rooms = require('../rooms/repository');
const { buildWeek, viewWeek } = require('./service');
const { localDay, mondayOf, weekdayOf, isDay } = require('../lib/dates');

const CSV_HEADER = 'date,start,end,class,subject,teacher';

/** The Monday asked for with ?week=, or the current week at the school. */
function weekFrom(query, now) {
  const w = query.get('week');
  if (w === null) return mondayOf(localDay(now()));
  if (!isDay(w) || weekdayOf(w) !== 1) throw new HttpError(422, 'validation_failed', 'week must be the Monday of a week, like 2026-03-09', { fields: ['week'] });
  return w;
}

/** The signage loader splits on commas, so commas inside values become semicolons. */
const plain = (v) => String(v).replace(/,/g, ';');

function register(router, { db, now }) {
  router.add('GET', '/api/classes/:id/timetable', async (req, res, { params, query }) => {
    const c = classes.getClass(db, params.id);
    if (!c) return problem(res, 404, 'not_found', `Class ${params.id} not found`);
    const week = buildWeek(db, weekFrom(query, now));
    json(res, 200, viewWeek(week, (l) => l.classId === c.id));
  });

  router.add('GET', '/api/teachers/:id/timetable', async (req, res, { params, query }) => {
    const t = teachers.getTeacher(db, params.id);
    if (!t) return problem(res, 404, 'not_found', `Teacher ${params.id} not found`);
    const week = buildWeek(db, weekFrom(query, now));
    json(res, 200, viewWeek(week, (l) => l.teacherId === t.id));
  });

  router.add('GET', '/api/rooms/:id/schedule.csv', async (req, res, { params, query }) => {
    const r = rooms.getRoom(db, params.id);
    if (!r) return problem(res, 404, 'not_found', `Room ${params.id} not found`);
    const week = viewWeek(buildWeek(db, weekFrom(query, now)), (l) => l.roomId === r.id && !l.view.cancelled);
    const lines = [CSV_HEADER];
    for (const day of week.days) {
      for (const l of [...day.lessons].sort((a, b) => a.start.localeCompare(b.start) || a.class.localeCompare(b.class))) {
        lines.push([day.date, l.start, l.end, l.class, plain(l.subject), plain(l.teacher)].join(','));
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end(lines.join('\n') + '\n');
  });
}

module.exports = { register };
