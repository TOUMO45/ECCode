'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('a fuel purchase shows net amount and VAT rate', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/fuel-purchases/1');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, {
      id: 1,
      vehicleId: 1,
      plate: 'B-FL 1042',
      driver: 'Marta Kowalski',
      station: 'Aral Kassel-Ost',
      purchasedAt: '2026-09-02T07:45:00.000Z',
      litres: '52.10',
      net: '84.12',
      vatRate: '19%',
    });
  } finally {
    await app.close();
  }
});

test('monthly fuel spend of a vehicle', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/vehicles/1/fuel-spend?month=2026-09');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { vehicleId: 1, plate: 'B-FL 1042', month: '2026-09', purchases: 2, net: '124.62' });
  } finally {
    await app.close();
  }
});

test('an invalid month is a 422 in the Acme error envelope', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/vehicles/1/fuel-spend?month=09-2026');
    assert.strictEqual(status, 422);
    assert.strictEqual(body.error.code, 'validation_failed');
    assert.deepStrictEqual(body.error.fields, ['month']);
  } finally {
    await app.close();
  }
});

test('unknown purchase is a 404', async () => {
  const app = await start();
  try {
    const { status, body } = await app.get('/api/fuel-purchases/404');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'not_found');
  } finally {
    await app.close();
  }
});
