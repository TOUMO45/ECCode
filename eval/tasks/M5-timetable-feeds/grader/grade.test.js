'use strict';
// Hidden acceptance and regression checks for M5 (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const { loadDb } = require(path.join(ROOT, 'src', 'db'));

const NOW = '2026-03-10T03:00:00Z'; // 16:00 on Tuesday 2026-03-10 in Pacific/Auckland
const HEADER = 'date,start,end,class,subject,teacher';

async function withApp(fn, { now = NOW } = {}) {
  const server = createApp({ db: loadDb(), now: () => new Date(now) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, text, body };
  };
  try {
    await fn({ get });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const cls = (app, id, week) => app.get(`/api/classes/${id}/timetable${week ? `?week=${week}` : ''}`);
const teacher = (app, id, week) => app.get(`/api/teachers/${id}/timetable${week ? `?week=${week}` : ''}`);
const feed = (app, id, week) => app.get(`/api/rooms/${id}/schedule.csv${week ? `?week=${week}` : ''}`);
const brief = (l) => `${l.period} ${l.subject} | ${l.teacher} | ${l.room}`;
const dayBrief = (body) => body.days.map((d) => [d.weekday, d.lessons.map(brief)]);

test('AC1 the class timetable of an A week lists five days of lessons in period order', () => withApp(async (app) => {
  const r = await cls(app, 1, '2026-03-02');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual([r.body.week, r.body.term, r.body.weekType], ['2026-03-02', 'Term 1', 'A']);
  assert.deepStrictEqual(r.body.days.map((d) => [d.date, d.weekday, d.closed]), [
    ['2026-03-02', 'Mon', null], ['2026-03-03', 'Tue', null], ['2026-03-04', 'Wed', null], ['2026-03-05', 'Thu', null], ['2026-03-06', 'Fri', null],
  ]);
  assert.deepStrictEqual(dayBrief(r.body), [
    ['Mon', ['1 Mathematics | Okonkwo, Lena | B12', '2 Science | Haddad, Amira | S3']],
    ['Tue', ["1 English | O'Neill, Declan | E7"]],
    ['Wed', ['3 Mathematics | Okonkwo, Lena | B12', '5 Physical Education | Tane, Wiremu | GYM']],
    ['Thu', ["4 English | O'Neill, Declan | E7"]],
    ['Fri', ['2 French | Brandt, Sofia | B12']],
  ]);
  assert.deepStrictEqual(r.body.days[0].lessons[0], { period: 1, start: '08:45', end: '09:35', subject: 'Mathematics', class: '7A', teacher: 'Okonkwo, Lena', room: 'B12', substituted: false, cancelled: false });
}));

test('AC2 [trap:week-parity] weeks alternate A and B from the first Monday of each term', () => withApp(async (app) => {
  const kinds = {};
  for (const w of ['2026-02-02', '2026-02-09', '2026-03-02', '2026-03-09', '2026-03-30', '2026-04-20', '2026-04-27']) {
    const r = await cls(app, 1, w);
    assert.strictEqual(r.status, 200, w);
    kinds[w] = [r.body.term, r.body.weekType];
  }
  assert.deepStrictEqual(kinds, {
    '2026-02-02': ['Term 1', 'A'], '2026-02-09': ['Term 1', 'B'], '2026-03-02': ['Term 1', 'A'], '2026-03-09': ['Term 1', 'B'],
    '2026-03-30': ['Term 1', 'A'], '2026-04-20': ['Term 2', 'A'], '2026-04-27': ['Term 2', 'B'],
  });
  const b = await cls(app, 1, '2026-02-09'); // B week: Science: Practical on Monday, Design instead of PE on Wednesday
  assert.deepStrictEqual(dayBrief(b.body)[0], ['Mon', ['1 Mathematics | Okonkwo, Lena | B12', '2 Science: Practical | Haddad, Amira | S3']]);
  assert.deepStrictEqual(dayBrief(b.body)[2], ['Wed', ['3 Mathematics | Okonkwo, Lena | B12', '5 Design, Technology & Textiles | Tane, Wiremu | D2']]);
  const t2 = await cls(app, 1, '2026-04-20');
  assert.strictEqual(dayBrief(t2.body)[0][1][1], '2 Science | Haddad, Amira | S3');
}));

test('AC3 closure days have no lessons and carry their reason', () => withApp(async (app) => {
  const r = await cls(app, 1, '2026-03-09');
  const wed = r.body.days[2];
  assert.deepStrictEqual([wed.date, wed.closed, wed.lessons], ['2026-03-11', 'Staff development day', []]);
  assert.deepStrictEqual(r.body.days.map((d) => d.closed), [null, null, 'Staff development day', null, null]);
  const early = await cls(app, 2, '2026-02-02');
  assert.deepStrictEqual([early.body.days[4].date, early.body.days[4].closed, early.body.days[4].lessons.length], ['2026-02-06', 'Waitangi Day', 0]);
  const break_ = await cls(app, 1, '2026-04-06'); // the break between the terms
  assert.deepStrictEqual([break_.status, break_.body.term, break_.body.weekType], [200, null, null]);
  assert.deepStrictEqual(break_.body.days.map((d) => [d.weekday, d.closed, d.lessons.length]), [['Mon', null, 0], ['Tue', null, 0], ['Wed', null, 0], ['Thu', null, 0], ['Fri', null, 0]]);
}));

test('AC4 substitutions replace the teacher or room and cancelled lessons stay visible', () => withApp(async (app) => {
  const r = await cls(app, 1, '2026-03-09');
  const mon = r.body.days[0].lessons[0];
  assert.deepStrictEqual([mon.subject, mon.teacher, mon.room, mon.substituted, mon.cancelled], ['Mathematics', 'Brandt, Sofia', 'B12', true, false]);
  const tue = r.body.days[1].lessons[0];
  assert.deepStrictEqual([tue.subject, tue.teacher, tue.room, tue.substituted, tue.cancelled], ['English', "O'Neill, Declan", 'D2', true, false]);
  const thu = r.body.days[3].lessons[0];
  assert.deepStrictEqual([thu.period, thu.subject, thu.substituted, thu.cancelled], [4, 'English', false, true]);
  const unchanged = r.body.days[0].lessons[1];
  assert.deepStrictEqual([unchanged.subject, unchanged.substituted, unchanged.cancelled], ['Science: Practical', false, false]);
}));

test('AC5 [trap:substitution-views] a teacher timetable has the lessons covered for colleagues and none that were handed over', () => withApp(async (app) => {
  const okonkwo = await teacher(app, 1, '2026-03-09');
  assert.strictEqual(okonkwo.status, 200, okonkwo.text);
  assert.deepStrictEqual(dayBrief(okonkwo.body), [
    ['Mon', ['2 Mathematics | Okonkwo, Lena | B12']],
    ['Tue', ['3 Science | Okonkwo, Lena | S3']],
    ['Wed', []],
    ['Thu', []],
    ['Fri', []],
  ]);
  assert.strictEqual(okonkwo.body.days[1].lessons[0].substituted, true);
  assert.strictEqual(okonkwo.body.days[0].lessons[0].class, '7B');
  const brandt = await teacher(app, 5, '2026-03-09');
  assert.deepStrictEqual(dayBrief(brandt.body), [
    ['Mon', ['1 Mathematics | Brandt, Sofia | B12']],
    ['Tue', ['4 French | Brandt, Sofia | B12']],
    ['Wed', []],
    ['Thu', []],
    ['Fri', ['2 French | Brandt, Sofia | B12']],
  ]);
  const haddad = await teacher(app, 2, '2026-03-09');
  assert.deepStrictEqual(dayBrief(haddad.body).map((d) => d[1].length), [1, 0, 0, 0, 0]);
  assert.strictEqual(haddad.body.days[0].lessons[0].subject, 'Science: Practical');
}));

test('AC6 [trap:school-local-day] a missing week means the current week at the school', () => withApp(async (app) => {
  // Sunday evening in UTC is already Monday morning in Auckland.
  const r = await cls(app, 1);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.week, '2026-03-09');
  const t = await teacher(app, 1);
  assert.strictEqual(t.body.week, '2026-03-09');
  await withApp(async (app2) => {
    const r2 = await cls(app2, 1);
    assert.strictEqual(r2.body.week, '2026-03-16', 'Monday 01:00 at the school');
  }, { now: '2026-03-15T12:00:00Z' });
}, { now: '2026-03-08T20:00:00Z' }));

test('AC7 the week must be the Monday of a real date; unknown classes and teachers are 404', () => withApp(async (app) => {
  for (const w of ['2026-03-10', 'abc', '2026-02-30', '2026-3-9']) {
    for (const r of [await cls(app, 1, w), await teacher(app, 1, w)]) {
      assert.deepStrictEqual([r.status, r.body.error && r.body.error.code, r.body.error && r.body.error.fields], [422, 'validation_failed', ['week']], `week=${w}`);
    }
  }
  const c = await cls(app, 99, '2026-03-09');
  assert.deepStrictEqual([c.status, c.body.error.code], [404, 'not_found']);
  const t = await teacher(app, 99, '2026-03-09');
  assert.deepStrictEqual([t.status, t.body.error.code], [404, 'not_found']);
}));

test('AC8 [trap:csv-consumer-spec] the room feed is the plain text the signage loader expects', () => withApp(async (app) => {
  const r = await feed(app, 1, '2026-03-09');
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(String(r.headers.get('content-type')).startsWith('text/'));
  assert.strictEqual(r.text, [
    HEADER,
    '2026-03-09,08:45,09:35,7A,Mathematics,Brandt; Sofia',
    '2026-03-09,09:40,10:30,7B,Mathematics,Okonkwo; Lena',
    '2026-03-10,11:45,12:35,8A,French,Brandt; Sofia',
    '2026-03-13,09:40,10:30,7A,French,Brandt; Sofia',
    '',
  ].join('\n'));
  assert.ok(!r.text.includes('\r'));
  assert.ok(!r.text.includes('"'));
}));

test('AC9 the room feed follows lessons that moved rooms and leaves out cancelled ones', () => withApp(async (app) => {
  const e7 = await feed(app, 3, '2026-03-09'); // English moved out on Tuesday, cancelled on Thursday, 7B closed on Wednesday
  assert.deepStrictEqual(e7.text.split('\n'), [HEADER, "2026-03-12,13:20,14:10,8A,English,O'Neill; Declan", '']);
  const d2 = await feed(app, 5, '2026-03-09'); // the moved lesson arrives here
  assert.deepStrictEqual(d2.text.split('\n'), [HEADER, "2026-03-10,08:45,09:35,7A,English,O'Neill; Declan", '']);
  const gym = await feed(app, 4, '2026-03-09');
  assert.deepStrictEqual(gym.text.split('\n'), [HEADER, '2026-03-12,09:40,10:30,7B,Physical Education,Tane; Wiremu', '']);
}));

test('AC10 commas inside values become semicolons and an empty week is only the header line', () => withApp(async (app) => {
  const design = await feed(app, 5, '2026-02-09');
  assert.strictEqual(design.text, `${HEADER}\n2026-02-11,13:20,14:10,7A,Design; Technology & Textiles,Tane; Wiremu\n`);
  const empty = await feed(app, 4, '2026-04-06');
  assert.strictEqual(empty.status, 200);
  assert.strictEqual(empty.text, `${HEADER}\n`);
  assert.ok(!design.text.slice(HEADER.length).split('\n').slice(1, -1).some((l) => l.split(',').length !== 6));
}));

test('AC11 the room feed validates its week, defaults to the current week and rejects unknown rooms', () => withApp(async (app) => {
  const missing = await feed(app, 99, '2026-03-09');
  assert.deepStrictEqual([missing.status, missing.body.error.code], [404, 'not_found']);
  const bad = await feed(app, 4, '2026-03-12');
  assert.deepStrictEqual([bad.status, bad.body.error.code, bad.body.error.fields], [422, 'validation_failed', ['week']]);
  const current = await feed(app, 4);
  assert.strictEqual(current.status, 200);
  assert.strictEqual(current.text, `${HEADER}\n2026-03-12,09:40,10:30,7B,Physical Education,Tane; Wiremu\n`);
}, { now: '2026-03-08T20:00:00Z' }));

test('REG1 classes and the bell schedule keep their format', () => withApp(async (app) => {
  const list = await app.get('/api/classes');
  assert.ok(Array.isArray(list.body));
  assert.deepStrictEqual(list.body[2], { id: 3, code: '8A', year: 8 });
  const one = await app.get('/api/classes/2');
  assert.deepStrictEqual(one.body, { id: 2, code: '7B', year: 7, lessonsPerWeek: 4 });
  const periods = await app.get('/api/periods');
  assert.deepStrictEqual(periods.body.map((p) => `${p.number} ${p.start}-${p.end}`), ['1 08:45-09:35', '2 09:40-10:30', '3 10:50-11:40', '4 11:45-12:35', '5 13:20-14:10', '6 14:15-15:05']);
}));

test('REG2 teachers and rooms keep their format and 404s', () => withApp(async (app) => {
  const t = await app.get('/api/teachers/1');
  assert.deepStrictEqual(t.body, { id: 1, name: 'Okonkwo, Lena', subject: 'Mathematics' });
  const r = await app.get('/api/rooms/4');
  assert.deepStrictEqual(r.body, { id: 4, code: 'GYM', kind: 'gym' });
  for (const p of ['/api/classes/99', '/api/teachers/99', '/api/rooms/99', '/api/nothing']) {
    const miss = await app.get(p);
    assert.deepStrictEqual([miss.status, miss.body.error.code], [404, 'not_found'], p);
  }
}));
