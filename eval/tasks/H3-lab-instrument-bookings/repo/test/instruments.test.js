'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('lists all instruments for the kiosk', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/instruments');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
    assert.deepStrictEqual(body.map((i) => i.name), ['Zeiss LSM 980 confocal', 'Bruker Avance NEO 600 NMR', 'Leica TCS SP5 confocal', 'Thermo Orbitrap Exploris 480']);
  } finally {
    await app.close();
  }
});

test('one instrument', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/instruments/3');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 3, name: 'Leica TCS SP5 confocal', room: 'B2.110', status: 'retired' });
  } finally {
    await app.close();
  }
});

test('one booking', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/bookings/61');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { id: 61, instrumentId: 1, bookedBy: 'r.mendes', purpose: 'Live-cell imaging', startsAt: '2026-10-12T09:00:00.000Z', endsAt: '2026-10-12T11:00:00.000Z' });
  } finally {
    await app.close();
  }
});

test('unknown instrument and booking are 404 in the Acme error envelope', async () => {
  const app = await start();
  try {
    for (const p of ['/api/instruments/99', '/api/bookings/999']) {
      const { status, body } = await app.get(p);
      assert.strictEqual(status, 404, p);
      assert.strictEqual(body.error.code, 'not_found', p);
    }
  } finally {
    await app.close();
  }
});
