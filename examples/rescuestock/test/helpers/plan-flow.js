// HTTP helpers for tests that drive a real server process: sign in, make an approved plan, reserve.
// Works with a client from fixtures.js createClient(server.request) or createClient(harness.request).
import assert from 'node:assert/strict';

// Requirements of the canonical RS-FIX-1 request (200 cups + 200 lids, budget $120, deadline 11:00 on the
// demo date, at most 2 pickups). The planner answers A + B for $84.00 (one bundle each).
export function canonicalFields(demoDate, overrides = {}) {
  return {
    productType: 'cups_and_lids',
    cupQuantity: 200,
    lidQuantity: 200,
    capacityMl: 250,
    diameterMm: 90,
    material: null,
    deadline: `${demoDate}T11:00`,
    budgetCents: 12000,
    maxPickups: 2,
    ...overrides,
  };
}

// A new request with confirmed requirements and a feasible plan; approved unless `approve` is false.
// Returns { requestId, plan }.
export async function approvedPlan(client, demoDate, { approve = true, overrides = {} } = {}) {
  const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
  assert.equal(created.status, 201, created.text);
  const requestId = created.json.request.id;
  const confirmed = await client.post(`/api/requests/${requestId}/confirm`, { fields: canonicalFields(demoDate, overrides) });
  assert.equal(confirmed.status, 201, confirmed.text);
  const made = await client.post(`/api/requests/${requestId}/plan`, {});
  assert.equal(made.status, 201, made.text);
  const plan = made.json.plan;
  assert.ok(plan, `the plan is feasible: ${made.text}`);
  if (approve) {
    const res = await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
    assert.equal(res.status, 200, res.text);
  }
  return { requestId, plan };
}

export const idempotencyKey = (label) => `idem-${String(label).padStart(10, '0')}-abcdefgh`;

export function reserve(client, planId, key, body = {}) {
  return client.post(`/api/plans/${planId}/reserve`, body, { headers: { 'Idempotency-Key': key } });
}
