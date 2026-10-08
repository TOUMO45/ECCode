'use strict';
// Hidden acceptance and regression checks (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createApp } = require(path.join(process.env.TASK_ROOT, 'src', 'app'));

async function withApp(fn) {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, text };
  };
  try { await fn(get); } finally { await new Promise((r) => server.close(r)); }
}

/** Lenient CSV parser (LF or CRLF, quoted or not) returning field values. */
function parseCsv(text) {
  const records = [];
  let rec = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let raw;
    let value = '';
    if (text[i] === '"') {
      let j = i + 1;
      for (; j < n; j++) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') { value += '"'; j++; continue; }
          break;
        }
        value += text[j];
      }
      raw = text.slice(i, j + 1);
      i = j + 1;
    } else {
      let j = i;
      while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++;
      raw = value = text.slice(i, j);
      i = j;
    }
    rec.push({ raw, value });
    if (text[i] === ',') { i++; if (i === n) rec.push({ raw: '', value: '' }); continue; }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    records.push(rec);
    rec = [];
  }
  if (rec.length) records.push(rec);
  return records;
}
const values = (text) => parseCsv(text).map((r) => r.map((f) => f.value));

const HEADER = 'ticket_code,holder_name,tier,checked_in';
const LIST_1 = [
  HEADER,
  'GA-1001,"Mary ""Mae"" Collins",general,1',
  "GA-1003,Siobhán O'Connor,general,0",
  'GA-1004,Ana Lima,general,0',
  'GA-1006,"García, Lucía",general,1',
  'ST-0101,Noah Fischer,student,0',
  'VIP-0002,Priya Raman,vip,0',
  'VIP-0007,"Okafor, Chidi",vip,1',
].map((l) => `${l}\n`).join('');
const LIST_3 = [HEADER, 'CF-0001,Ben Adeyemi,exhibitor,1', 'CF-0002,"Zoë ""Z"" Laurent, Studio Z",exhibitor,0', 'CF-0003,Hannah Webb,general,0'].map((l) => `${l}\n`).join('');
const URL_1 = '/api/events/1/gate-list.csv';

test('AC1 [trap:overapplied-org-rule] the first line is exactly the Gatekeeper header', () => withApp(async (get) => {
  const r = await get(URL_1);
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.startsWith(`${HEADER}\n`), JSON.stringify(r.text.slice(0, 60)));
}));

test('AC2 [trap:overapplied-org-rule] lines end with LF only, including the last one', () => withApp(async (get) => {
  for (const id of [1, 3]) {
    const r = await get(`/api/events/${id}/gate-list.csv`);
    assert.ok(!r.text.includes('\r'), `event ${id}: no carriage returns`);
    assert.ok(r.text.endsWith('\n'), `event ${id}: last line is terminated`);
  }
}));

test('AC3 [trap:overapplied-org-rule] values that need no quotes are not quoted', () => withApp(async (get) => {
  const lines = (await get(URL_1)).text.split('\n');
  for (const expected of ["GA-1003,Siobhán O'Connor,general,0", 'GA-1004,Ana Lima,general,0', 'ST-0101,Noah Fischer,student,0', 'VIP-0002,Priya Raman,vip,0']) {
    assert.ok(lines.includes(expected), `missing line ${JSON.stringify(expected)}`);
  }
}));

test('AC4 names with commas or double quotes are quoted, with inner quotes doubled', () => withApp(async (get) => {
  const records = parseCsv((await get(URL_1)).text);
  const byCode = Object.fromEntries(records.slice(1).map((r) => [r[0].value, r]));
  assert.deepStrictEqual([byCode['GA-1001'][1].raw, byCode['GA-1001'][1].value], ['"Mary ""Mae"" Collins"', 'Mary "Mae" Collins']);
  assert.deepStrictEqual([byCode['VIP-0007'][1].raw, byCode['VIP-0007'][1].value], ['"Okafor, Chidi"', 'Okafor, Chidi']);
  assert.deepStrictEqual([byCode['GA-1006'][1].raw, byCode['GA-1006'][1].value], ['"García, Lucía"', 'García, Lucía']);
}));

test('AC5 only valid tickets are listed, sorted by code, with checked_in 1 or 0', () => withApp(async (get) => {
  const rows = values((await get(URL_1)).text);
  assert.deepStrictEqual(rows, [
    ['ticket_code', 'holder_name', 'tier', 'checked_in'],
    ['GA-1001', 'Mary "Mae" Collins', 'general', '1'],
    ['GA-1003', "Siobhán O'Connor", 'general', '0'],
    ['GA-1004', 'Ana Lima', 'general', '0'],
    ['GA-1006', 'García, Lucía', 'general', '1'],
    ['ST-0101', 'Noah Fischer', 'student', '0'],
    ['VIP-0002', 'Priya Raman', 'vip', '0'],
    ['VIP-0007', 'Okafor, Chidi', 'vip', '1'],
  ]);
}));

test('AC6 [trap:overapplied-org-rule] the complete guest lists match Gatekeeper\'s spec byte for byte', () => withApp(async (get) => {
  assert.strictEqual((await get(URL_1)).text, LIST_1);
  assert.strictEqual((await get('/api/events/3/gate-list.csv')).text, LIST_3);
}));

test('AC7 an event without valid tickets gives just the header; unknown events are 404', () => withApp(async (get) => {
  const empty = await get('/api/events/2/gate-list.csv');
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual(values(empty.text), [['ticket_code', 'holder_name', 'tier', 'checked_in']]);
  const nf = await get('/api/events/42/gate-list.csv');
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(nf.body.error && nf.body.error.code, 'not_found');
}));

test('REG1 event and ticket endpoints are unchanged', () => withApp(async (get) => {
  assert.deepStrictEqual((await get('/api/events/3')).body, { id: 3, name: 'Winter Craft Fair', venue: 'Corn Exchange', startsAt: '2026-12-05T10:00:00.000Z', ticketsSold: 3 });
  assert.deepStrictEqual((await get('/api/events/2')).body.ticketsSold, 0);
  assert.deepStrictEqual((await get('/api/tickets/GA-1002')).body, { code: 'GA-1002', eventId: 1, holderName: 'Jürgen Weiß', tier: 'general', status: 'cancelled', checkedIn: false, price: '45.00' });
  for (const p of ['/api/events/42', '/api/tickets/XX-0000']) {
    const r = await get(p);
    assert.deepStrictEqual([r.status, r.body.error.code], [404, 'not_found'], p);
  }
}));
