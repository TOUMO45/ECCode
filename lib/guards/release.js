'use strict';
// Release plan (Phase 3, B.5): feature and greenfield deliveries carry a plan
// (a feature flag or a staged rollout, the monitoring signal, the rollback
// step) acknowledged by a reviewer. Report-only beyond presence and
// acknowledgement.
const { EccodeError, newId } = require('../util');
const common = require('./common');

const TRACKS = new Set(['feature', 'greenfield']);
const MIN = 10;

function text(v, what, min = MIN) {
  if (typeof v !== 'string' || v.trim().length < min) throw new EccodeError('INVALID_INPUT', `${what} is required (>= ${min} chars)`);
  return v.trim();
}

function plan(store, config, actor, { strategy, flag, rollout, monitoring, rollback } = {}) {
  if (!['orchestrator', 'delivery-lead', 'user'].includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not record the release plan; allowed: orchestrator, delivery-lead, user`);
  if (!['flag', 'staged'].includes(strategy)) throw new EccodeError('INVALID_INPUT', 'strategy is "flag" (a feature flag, name it) or "staged" (a staged rollout, describe the stages)');
  const data = { id: newId('rel'), strategy, monitoring: text(monitoring, 'monitoring (the signal watched after the release)'), rollback: text(rollback, 'rollback (the step that undoes the release)') };
  if (strategy === 'flag') data.flag = text(flag, 'flag (the feature flag name)', 2);
  else data.rollout = text(rollout, 'rollout (the stages)');
  return store.commit('release.plan', actor, data, (s) => common.assertActive(s)).event.data;
}

function acknowledge(store, config, actor, { plan: planId } = {}) {
  const reviewers = [...new Set([...config.roles.verification.reviewers, ...config.roles.phase.reviewers])];
  if (!reviewers.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not acknowledge a release plan; reviewers: ${reviewers.join(', ')}`);
  const data = { id: newId('rack'), plan: text(planId, 'plan id', 1) };
  return store.commit('release.acknowledged', actor, data, (s) => {
    common.assertActive(s);
    if (!s.guards.release.some((p) => p.id === data.plan)) throw new EccodeError('NOT_FOUND', `Unknown release plan ${data.plan}`);
  }).event.data;
}

function deliveryProblems(state) {
  if (!state.work || !TRACKS.has(state.work.track) || !state.guards) return [];
  const plans = state.guards.release;
  if (!plans.length) return [`${state.work.track} track: no release plan recorded (eccode guard release --strategy flag|staged --monitoring ... --rollback ... --actor delivery-lead)`];
  const last = plans[plans.length - 1];
  if (!state.guards.acknowledgements.some((a) => a.plan === last.id)) return [`release plan ${last.id} is not acknowledged by a reviewer (eccode guard release ack ${last.id} --actor <reviewer>)`];
  return [];
}

function reportLines(state) {
  const plans = (state.guards && state.guards.release) || [];
  if (!plans.length) return [];
  const p = plans[plans.length - 1];
  const ack = (state.guards.acknowledgements || []).find((a) => a.plan === p.id);
  return ['## Release plan', '', `- Strategy: ${p.strategy === 'flag' ? `feature flag \`${p.flag}\`` : `staged rollout: ${p.rollout}`}`, `- Monitoring: ${p.monitoring}`, `- Rollback: ${p.rollback}`, `- Acknowledged by: ${ack ? ack.by : 'nobody yet'}`, ''];
}

module.exports = { plan, acknowledge, deliveryProblems, reportLines, TRACKS };
