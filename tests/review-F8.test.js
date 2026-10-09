'use strict';
// Independent review finding F8: limits were accounting checks, not runtime enforcement.
// The engine now caps open runs (limits.maxActiveRuns), reserves budget for runs in flight
// (limits.reserveUsdPerRun), records unknown usage as unknown (null) instead of zero, counts the
// real elapsed time of interrupted runs, and says at read time when recorded spend is only a
// lower bound. Old logs carry 0 for unknown usage and must keep replaying identically.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { Store } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const runs = require('../lib/runs');
const gates = require('../lib/gates');
const status = require('../lib/status');
const { tmpProject, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const cli = (dir, args) => spawnSync(process.execPath, [BIN, ...args, '--root', dir], { encoding: 'utf8' });

function withClock(iso, fn) {
  process.env.ECCODE_TEST = '1';
  process.env.ECCODE_NOW = iso;
  try {
    return fn();
  } finally {
    delete process.env.ECCODE_NOW;
    delete process.env.ECCODE_TEST;
  }
}

test('F8 fifth concurrent run is refused with RUN_LIMIT until one is closed or recovered', () => {
  const ctx = tmpProject();
  assert.strictEqual(ctx.config.limits.maxActiveRuns, 4, 'default cap');
  const open = [];
  for (let i = 0; i < 4; i += 1) open.push(runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'backend-engineer' }));
  const err = expectCode(() => runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'test-engineer' }), 'RUN_LIMIT');
  assert.match(err.message, /maxActiveRuns=4/);
  assert.match(err.message, /eccode recover --actor orchestrator/);
  for (const id of open) assert.ok(err.message.includes(id), `refusal names the open run ${id}`);
  assert.strictEqual(Object.keys(ctx.store.state().runs).length, 4, 'nothing was recorded');
  // The CLI refuses with exit 2 (a workflow rule), not a crash.
  const res = cli(ctx.dir, ['run', 'start', '--actor', 'orchestrator', '--agent', 'test-engineer']);
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /RUN_LIMIT/);
  // Closing one run frees a slot.
  runs.endRun(ctx.store, ctx.config, open[0], 'orchestrator', { tokens: 10 });
  const fifth = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'test-engineer' });
  expectCode(() => runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'test-engineer' }), 'RUN_LIMIT');
  // So does recovering the interrupted ones.
  assert.strictEqual(runs.recover(ctx.store, ctx.config, { all: true, actor: 'orchestrator' }).length, 4);
  runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'test-engineer' });
  assert.strictEqual(ctx.store.state().runs[fifth].status, 'interrupted');
  // A lower cap is honoured.
  const small = tmpProject({ configOverrides: { limits: { maxActiveRuns: 1 } } });
  runs.startRun(small.store, small.config, 'product-architect');
  expectCode(() => runs.startRun(small.store, small.config, 'product-architect'), 'RUN_LIMIT');
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('F8 reserveUsdPerRun makes run start refuse before the cap is spent', () => {
  const ctx = tmpProject({ configOverrides: { limits: { maxCostUsd: 10, reserveUsdPerRun: 3 } } });
  const first = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'product-architect', gate: 'architecture' });
  runs.endRun(ctx.store, ctx.config, first, 'orchestrator', { costUsd: 5, tokens: 1000 });
  // $5 spent + one open run reserved at $3 = $8: within the $10 cap.
  const second = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'technical-designer', gate: 'design' });
  // $5 + (1 open + 1 new) x $3 = $11 > $10: refused although only $5 is recorded.
  const err = expectCode(() => runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'technical-reviewer' }), 'BUDGET_EXCEEDED');
  assert.match(err.message, /reserved/);
  assert.match(err.message, /\$3/);
  assert.match(err.details.recovery, /user's explicit authorization/);
  // New work that implies another run is refused the same way, before anything is dispatched.
  expectCode(() => gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator'), 'BUDGET_EXCEEDED');
  // Closing the open run under the reserve frees the budget again.
  runs.endRun(ctx.store, ctx.config, second, 'orchestrator', { costUsd: 1, tokens: 100 });
  runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'technical-reviewer' });
  const sum = status.summary(ctx.store.state(), ctx.config);
  assert.strictEqual(sum.budget.reserveUsdPerRun, 3);
  assert.strictEqual(sum.budget.reservedUsd, 3, 'one open run reserved');
  // The reservation is off by default and the key is validated like the other limits.
  assert.strictEqual(tmpProject().config.limits.reserveUsdPerRun, null);
  const cfgErr = expectCode(() => tmpProject({ configOverrides: { limits: { reserveUsdPerRun: -1 } } }), 'INVALID_CONFIG'); // tmpProject loads the config
  assert.match(cfgErr.message, /reserveUsdPerRun must be a positive number or null/);
});

test('F8 run end --no-usage records null usage (never zero) and status counts the run as unknown', () => {
  const ctx = tmpProject();
  const id = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'backend-engineer' });
  runs.endRun(ctx.store, ctx.config, id, 'orchestrator', { status: 'failed', noUsage: true });
  const ended = ctx.store.readEvents().find((e) => e.type === 'run.ended' && e.data.id === id);
  assert.strictEqual(ended.data.tokens, null, 'the event carries unknown tokens as null');
  assert.strictEqual(ended.data.costUsd, null, 'the event carries unknown cost as null');
  assert.strictEqual(ended.data.usageReported, false);
  let st = ctx.store.state();
  assert.strictEqual(st.runs[id].tokens, null);
  assert.strictEqual(st.runs[id].costUsd, null);
  assert.deepStrictEqual(st.totals, { costUsd: 0, runtimeMinutes: st.totals.runtimeMinutes, tokens: 0 }, 'totals stay numbers');
  assert.strictEqual(typeof st.totals.runtimeMinutes, 'number');
  let sum = status.summary(st, ctx.config);
  assert.deepStrictEqual(sum.budget.runsWithUnknownUsage, { count: 1, ids: [id] });
  assert.strictEqual(sum.budget.lowerBound, true);
  const brief = status.formatBrief(sum);
  assert.match(brief, /Budget: \$0\/25 \(1 run with unknown usage; spend is a lower bound\)/);
  // status and resume print the same qualified budget line.
  for (const args of [['status', '--brief'], ['resume']]) {
    const res = cli(ctx.dir, args);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /1 run with unknown usage; spend is a lower bound/, args.join(' '));
  }
  const json = JSON.parse(cli(ctx.dir, ['status', '--json']).stdout);
  assert.deepStrictEqual(json.budget.runsWithUnknownUsage, { count: 1, ids: [id] });
  // Filling the usage in with run correct clears the qualification.
  runs.correctRun(ctx.store, id, 'orchestrator', { tokens: 4000, costUsd: 0.25, reason: 'usage arrived after the close' });
  st = ctx.store.state();
  assert.deepStrictEqual(st.totals, { costUsd: 0.25, runtimeMinutes: st.totals.runtimeMinutes, tokens: 4000 });
  sum = status.summary(st, ctx.config);
  assert.deepStrictEqual(sum.budget.runsWithUnknownUsage, { count: 0, ids: [] });
  assert.doesNotMatch(status.formatBrief(sum), /lower bound/);
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('F8 recover records the real elapsed time of an interrupted run and unknown usage', () => {
  const ctx = tmpProject();
  const id = withClock('2026-03-01T10:00:00.000Z', () => runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'backend-engineer' }));
  const recovered = withClock('2026-03-01T11:30:00.000Z', () => runs.recover(ctx.store, ctx.config, { actor: 'orchestrator' }));
  assert.strictEqual(recovered.length, 1);
  const ended = ctx.store.readEvents().find((e) => e.type === 'run.ended' && e.data.id === id);
  assert.strictEqual(ended.data.durationMinutes, 90, 'start to recovery, not 0');
  assert.strictEqual(ended.data.tokens, null);
  assert.strictEqual(ended.data.costUsd, null);
  assert.strictEqual(ended.data.usageReported, false);
  const st = ctx.store.state();
  assert.strictEqual(st.runs[id].status, 'interrupted');
  assert.strictEqual(st.runs[id].durationMinutes, 90);
  assert.strictEqual(st.totals.runtimeMinutes, 90, 'the elapsed time counts toward maxRuntimeMinutes');
  assert.strictEqual(st.totals.costUsd, 0);
  assert.strictEqual(st.totals.tokens, 0);
  const sum = status.summary(st, ctx.config);
  assert.deepStrictEqual(sum.budget.runsWithUnknownUsage, { count: 1, ids: [id] });
});

test('F8 totals stay exact numbers with unknown usage, estimates are flagged, and refusals point at run correct', () => {
  const ctx = tmpProject({ configOverrides: { limits: { maxCostUsd: 6 }, pricing: { usdPerMillionTokens: 10 } } });
  const exact = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'product-architect' });
  runs.endRun(ctx.store, ctx.config, exact, 'orchestrator', { tokens: 100000, costUsd: 2 });
  const unknown = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'technical-designer' });
  runs.endRun(ctx.store, ctx.config, unknown, 'orchestrator', { status: 'failed', noUsage: true });
  const estimated = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'delivery-lead' });
  runs.endRun(ctx.store, ctx.config, estimated, 'orchestrator', { tokens: 300000 }); // $3 at $10/M
  let st = ctx.store.state();
  assert.deepStrictEqual(st.totals, { costUsd: 5, runtimeMinutes: st.totals.runtimeMinutes, tokens: 400000 });
  assert.strictEqual(st.runs[estimated].costEstimated, true);
  assert.strictEqual(st.runs[exact].costEstimated, undefined, 'a reported figure is not an estimate');
  let sum = status.summary(st, ctx.config);
  assert.strictEqual(sum.budget.estimatedCostUsd, 3);
  assert.deepStrictEqual(sum.budget.runsWithUnknownUsage, { count: 1, ids: [unknown] });
  let brief = status.formatBrief(sum);
  assert.match(brief, /Budget: \$5\/6 \(1 run with unknown usage; spend is a lower bound; \$3 of it estimated from tokens\)/);
  // Without pricing, tokens alone give no dollar figure: the cost is unknown, not $0.
  const noPrice = tmpProject();
  const tokensOnly = runs.startRun(noPrice.store, noPrice.config, 'orchestrator', { agent: 'test-engineer' });
  runs.endRun(noPrice.store, noPrice.config, tokensOnly, 'orchestrator', { tokens: 1234 });
  assert.strictEqual(noPrice.store.state().runs[tokensOnly].costUsd, null);
  assert.strictEqual(noPrice.store.state().runs[tokensOnly].usageReported, true);
  assert.strictEqual(noPrice.store.state().totals.tokens, 1234);
  assert.deepStrictEqual(status.summary(noPrice.store.state(), noPrice.config).budget.runsWithUnknownUsage.ids, [tokensOnly]);
  // Over the cap: the refusal says the figure is a lower bound and how to fix the unknown runs.
  const more = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'test-engineer' });
  runs.endRun(ctx.store, ctx.config, more, 'orchestrator', { tokens: 100000 }); // $1 estimated -> $6
  const err = expectCode(() => gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator'), 'BUDGET_EXCEEDED');
  assert.match(err.message, /lower bound/);
  assert.match(err.message, /eccode run correct/);
  assert.ok(err.message.includes(unknown), 'names the run with unknown usage');
  assert.deepStrictEqual(err.details.unknownUsage, [unknown]);
  // Correcting the estimate with the reported figure clears the flag.
  runs.correctRun(ctx.store, estimated, 'orchestrator', { costUsd: 2.5, reason: 'invoice figure' });
  st = ctx.store.state();
  assert.strictEqual(st.runs[estimated].costEstimated, false);
  assert.strictEqual(st.totals.costUsd, 5.5);
  sum = status.summary(st, ctx.config);
  assert.strictEqual(sum.budget.estimatedCostUsd, 1);
  assert.strictEqual(ctx.store.audit().ok, true);
});

test('F8 shipped records replay unchanged and their recovered runs count as unknown usage at read time', () => {
  for (const rel of ['examples/triage-desk', 'examples/groundwork', 'examples/learning-cycle/legacy-project', '.']) {
    const root = path.join(__dirname, '..', rel);
    const store = new Store(root);
    assert.deepStrictEqual(store.audit().errors, [], rel);
  }
  // Groundwork's log holds runs recovered by the old code (recorded as 0/0): the snapshot still
  // says 0, and only the read-time view calls them unknown.
  const root = path.join(__dirname, '..', 'examples/groundwork');
  const state = new Store(root).state();
  const recovered = Object.values(state.runs).filter((r) => r.note === 'recovered after interruption');
  assert.ok(recovered.length >= 3);
  for (const r of recovered) {
    assert.strictEqual(r.costUsd, 0);
    assert.strictEqual(r.tokens, 0);
    assert.strictEqual(r.usageReported, false);
  }
  const sum = status.summary(state, loadConfig(root));
  assert.ok(sum.budget.runsWithUnknownUsage.count >= recovered.length);
  for (const r of recovered) assert.ok(sum.budget.runsWithUnknownUsage.ids.includes(r.id));
  assert.match(status.formatBrief(sum), /runs with unknown usage; spend is a lower bound/);
});
