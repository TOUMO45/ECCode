'use strict';
const { json, problem, readJson, HttpError } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');
const { today, viewSubscription, quote, refundFor, viewQuote } = require('./service');
const { record } = require('../lib/audit');
const { createIdempotency } = require('../lib/idempotency');

/** Read { planCode, seats } from a body or a query string and check it against the plans. */
function readChange(db, raw) {
  const fields = [];
  const plan = raw && typeof raw.planCode === 'string' ? repo.getPlanByCode(db, raw.planCode) : null;
  if (!plan) fields.push('planCode');
  let seats = null;
  if (raw && raw.seats !== undefined && raw.seats !== null && raw.seats !== '') {
    const n = typeof raw.seats === 'string' && /^\d+$/.test(raw.seats) ? Number(raw.seats) : raw.seats;
    if (Number.isInteger(n) && n >= 1) seats = n;
    else fields.push('seats');
  }
  if (fields.length) throw new HttpError(422, 'validation_failed', 'Request is invalid', { fields });
  return { newPlan: plan, seats };
}

function register(router, { db, now }) {
  const idem = createIdempotency();

  /** Everything a handler needs about a subscription, in account-local time. */
  const contextFor = (sub) => {
    const account = repo.getAccount(db, sub.account_id);
    return { account, plan: repo.planOf(db, sub), day: today(account, now()) };
  };

  /** Validate a requested change against the subscription; returns the target plan, seats and quote. */
  const plan = (sub, raw, { applying }) => {
    const ctx = contextFor(sub);
    const change = readChange(db, raw);
    if (sub.status === 'cancelled') throw new HttpError(409, 'conflict', 'Subscription is cancelled');
    const seats = change.seats === null ? sub.seats : change.seats;
    if (seats > change.newPlan.seat_limit) throw new HttpError(409, 'conflict', 'Seats exceed the plan limit');
    if (applying && change.newPlan.id === sub.plan_id && seats === sub.seats) throw new HttpError(409, 'conflict', 'Nothing to change');
    return { ctx, newPlan: change.newPlan, seats, q: quote(sub, { plan: ctx.plan, newPlan: change.newPlan, seats, day: ctx.day }) };
  };

  router.add('GET', '/api/subscriptions/:id', async (req, res, { params }) => {
    const sub = repo.getSubscription(db, params.id);
    if (!sub) return problem(res, 404, 'not_found', `Subscription ${params.id} not found`);
    const ctx = contextFor(sub);
    json(res, 200, viewSubscription(sub, ctx));
  });

  router.add('GET', '/api/subscriptions/:id/change-preview', async (req, res, { params, query }) => {
    const sub = repo.getSubscription(db, params.id);
    if (!sub) return problem(res, 404, 'not_found', `Subscription ${params.id} not found`);
    const p = plan(sub, { planCode: query.get('planCode'), seats: query.get('seats') }, { applying: false });
    json(res, 200, { effectiveOn: p.ctx.day, planCode: p.newPlan.code, seats: p.seats, ...viewQuote(p.q) });
  });

  router.add('POST', '/api/subscriptions/:id/change-plan', async (req, res, { params }) => {
    const replay = idem.lookup(req);
    if (replay) return json(res, replay.status, replay.body);
    const sub = repo.getSubscription(db, params.id);
    if (!sub) return problem(res, 404, 'not_found', `Subscription ${params.id} not found`);
    const body = await readJson(req);
    const p = plan(sub, body, { applying: true });
    const patch = { plan_id: p.newPlan.id, seats: p.seats };
    if (p.q.net > 0) patch.pendingCents = sub.pendingCents + p.q.net;
    if (p.q.net < 0) patch.creditCents = sub.creditCents - p.q.net;
    const updated = repo.updateSubscription(db, sub.id, patch);
    record(db, req, now, 'update', 'subscriptions', sub.id);
    const out = { ...viewSubscription(updated, { ...p.ctx, plan: p.newPlan }), effectiveOn: p.ctx.day, proration: viewQuote(p.q) };
    idem.store(req, 200, out);
    json(res, 200, out);
  });

  router.add('POST', '/api/subscriptions/:id/cancel', async (req, res, { params }) => {
    const replay = idem.lookup(req);
    if (replay) return json(res, replay.status, replay.body);
    const sub = repo.getSubscription(db, params.id);
    if (!sub) return problem(res, 404, 'not_found', `Subscription ${params.id} not found`);
    if (sub.status === 'cancelled') return problem(res, 409, 'conflict', 'Subscription is already cancelled');
    const ctx = contextFor(sub);
    const refund = refundFor(sub, ctx);
    const updated = repo.updateSubscription(db, sub.id, { status: 'cancelled', cancelled_on: ctx.day, creditCents: sub.creditCents + refund });
    record(db, req, now, 'update', 'subscriptions', sub.id);
    const out = { ...viewSubscription(updated, ctx), cancelledOn: ctx.day, refund: money.toDecimal(refund) };
    idem.store(req, 200, out);
    json(res, 200, out);
  });
}

module.exports = { register };
