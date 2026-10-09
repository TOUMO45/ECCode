'use strict';
// F8 (limits as runtime enforcement), variations not in tests/review-F8.test.js:
//   maxActiveRuns under concurrent `run start` from several processes; the reservation arithmetic at the exact
//   boundary; --no-usage, recover and tokens-without-pricing through the CLI; maxActiveRuns: 0; --tokens 0.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { REPO, attempt, report, cleanup } = require('./_lib');
const runs = require(REPO + '/lib/runs');
const status = require(REPO + '/lib/status');
const { Store } = require(REPO + '/lib/store');
const { tmpProject } = require(REPO + '/tests/helpers');

const BIN = path.join(REPO, 'bin/eccode.js');
const cli = (dir, args, env = {}) => {
  const r = spawnSync(process.execPath, [BIN, '--root', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const m = /\[([A-Z_]+)\]/.exec(r.stderr);
  return { ok: r.status === 0, exit: r.status, code: m ? m[1] : undefined, stdout: r.stdout.trim().slice(0, 300), message: r.stderr.trim().slice(0, 300) };
};
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

const { step, finish } = report('F8-limits-variations');
const dirs = [];
(async () => {
  try {
    // ---- A. Three processes race for the one remaining slot.
    let ctx = tmpProject();
    dirs.push(ctx.dir);
    for (let i = 0; i < 3; i += 1) runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'backend-engineer' });
    const race = await Promise.all([0, 1, 2].map(() => new Promise((resolve) => {
      let out = '';
      let err = '';
      const p = spawn(process.execPath, [BIN, '--root', ctx.dir, 'run', 'start', '--actor', 'orchestrator', '--agent', 'test-engineer']);
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (err += c));
      p.on('exit', (code) => resolve({ code, code2: (/\[([A-Z_]+)\]/.exec(err) || [])[1] }));
    })));
    const open = Object.values(new Store(ctx.dir).state().runs).filter((r) => r.status === 'running').length;
    step('F8.race', 'maxActiveRuns=4, 3 open, three concurrent run start', 'documented', { ok: race.filter((r) => r.code === 0).length === 1 && open === 4 && race.filter((r) => r.code2 === 'RUN_LIMIT').length === 2, value: { results: race, openAfter: open, auditOk: ctx.store.audit().ok } });

    // ---- B. Reservation arithmetic at the boundary.
    ctx = tmpProject({ configOverrides: { limits: { maxCostUsd: 11, reserveUsdPerRun: 3 } } });
    dirs.push(ctx.dir);
    const first = runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'product-architect' });
    runs.endRun(ctx.store, ctx.config, first, 'orchestrator', { costUsd: 5, tokens: 1000 });
    runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'technical-designer' });
    step('F8.reserve.equal', '$5 spent + 1 open + 1 new at $3 = $11 against a $11 cap (not greater: allowed)', 'ok', attempt(() => runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'technical-reviewer' })));
    step('F8.reserve.over', 'a fourth: $5 + 3 x $3 = $14 > $11', 'refused:BUDGET_EXCEEDED', attempt(() => runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'test-engineer' })));
    const tight = tmpProject({ configOverrides: { limits: { maxCostUsd: 10.99, reserveUsdPerRun: 3 } } });
    dirs.push(tight.dir);
    const t1 = runs.startRun(tight.store, tight.config, 'orchestrator', { agent: 'product-architect' });
    runs.endRun(tight.store, tight.config, t1, 'orchestrator', { costUsd: 5, tokens: 1000 });
    runs.startRun(tight.store, tight.config, 'orchestrator', { agent: 'technical-designer' });
    step('F8.reserve.justOver', '$5 + 2 x $3 = $11 > $10.99', 'refused:BUDGET_EXCEEDED', attempt(() => runs.startRun(tight.store, tight.config, 'orchestrator', { agent: 'technical-reviewer' })));
    const atCap = tmpProject({ configOverrides: { limits: { maxCostUsd: 5 } } });
    dirs.push(atCap.dir);
    const c1 = runs.startRun(atCap.store, atCap.config, 'orchestrator', { agent: 'product-architect' });
    runs.endRun(atCap.store, atCap.config, c1, 'orchestrator', { costUsd: 5, tokens: 1000 });
    step('F8.spent.equal', 'recorded spend equal to the cap ($5 of $5): refused (>=), unlike the reservation (>)', 'refused:BUDGET_EXCEEDED', attempt(() => runs.startRun(atCap.store, atCap.config, 'orchestrator', { agent: 'test-engineer' })));

    // ---- C. CLI: --no-usage, status wording, recover, tokens without pricing.
    ctx = tmpProject();
    dirs.push(ctx.dir);
    const r1 = cli(ctx.dir, ['run', 'start', '--actor', 'orchestrator', '--agent', 'backend-engineer']).stdout;
    step('F8.cli.endWithoutUsage', 'run end with neither --tokens nor --no-usage', 'refused:USAGE_MISSING', cli(ctx.dir, ['run', 'end', r1, '--actor', 'orchestrator', '--status', 'failed']));
    step('F8.cli.noUsage', 'run end --no-usage', 'ok', cli(ctx.dir, ['run', 'end', r1, '--actor', 'orchestrator', '--status', 'failed', '--no-usage']));
    const brief = cli(ctx.dir, ['status', '--brief']);
    step('F8.cli.lowerBound', 'status --brief says the spend is a lower bound and names the run', 'documented', { ok: /unknown usage; spend is a lower bound/.test(brief.stdout), value: (brief.stdout.split('\n').find((l) => /Budget/.test(l)) || '').slice(0, 160) });
    const jsonOut = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'status', '--json'], { encoding: 'utf8' }).stdout;
    step('F8.cli.lowerBound.json', 'status --json: budget.lowerBound and runsWithUnknownUsage', 'documented', { ok: JSON.parse(jsonOut).budget.lowerBound === true, value: JSON.parse(jsonOut).budget.runsWithUnknownUsage });
    const r2 = cli(ctx.dir, ['run', 'start', '--actor', 'orchestrator', '--agent', 'test-engineer']).stdout;
    step('F8.cli.tokensNoPricing', 'run end --tokens 1234 without a cost and without pricing', 'ok', cli(ctx.dir, ['run', 'end', r2, '--actor', 'orchestrator', '--tokens', '1234']));
    let st = ctx.store.state();
    step('F8.cli.tokensNoPricing.cost', 'the run\'s cost is unknown (null), tokens counted, run listed as unknown usage', 'documented', { ok: st.runs[r2].costUsd === null && st.runs[r2].tokens === 1234 && status.summary(st, ctx.config).budget.runsWithUnknownUsage.ids.includes(r2), value: { costUsd: st.runs[r2].costUsd, tokens: st.runs[r2].tokens, unknown: status.summary(st, ctx.config).budget.runsWithUnknownUsage } });
    const r3 = cli(ctx.dir, ['run', 'start', '--actor', 'orchestrator', '--agent', 'delivery-lead']).stdout;
    step('F8.cli.tokensZero', 'run end --tokens 0 (an explicit zero is a reported figure)', 'ok', cli(ctx.dir, ['run', 'end', r3, '--actor', 'orchestrator', '--tokens', '0']));
    st = ctx.store.state();
    step('F8.cli.tokensZero.cost', 'cost $0, usageReported true (documented semantics: an explicit 0 is not unknown)', 'documented', { ok: true, value: { costUsd: st.runs[r3].costUsd, tokens: st.runs[r3].tokens, usageReported: st.runs[r3].usageReported } });

    // ---- D. recover: real elapsed time, unknown usage (clock pinned).
    ctx = tmpProject();
    dirs.push(ctx.dir);
    const stale = withClock('2026-03-01T10:00:00.000Z', () => runs.startRun(ctx.store, ctx.config, 'orchestrator', { agent: 'backend-engineer' }));
    const recovered = withClock('2026-03-01T12:00:00.000Z', () => runs.recover(ctx.store, ctx.config, { actor: 'orchestrator' }));
    st = ctx.store.state();
    step('F8.recover', 'a run started at 10:00 recovered at 12:00', 'documented', { ok: recovered.length === 1 && st.runs[stale].durationMinutes === 120 && st.runs[stale].costUsd === null && st.runs[stale].tokens === null && st.runs[stale].usageReported === false && st.totals.costUsd === 0, value: { durationMinutes: st.runs[stale].durationMinutes, costUsd: st.runs[stale].costUsd, tokens: st.runs[stale].tokens, totals: st.totals, status: (status.formatBrief(status.summary(st, ctx.config)).split('\n').find((l) => /Budget/.test(l)) || '').slice(0, 140) } });
    step('F8.recover.bySubagent', 'recover run by a subagent role', 'refused:ROLE_NOT_ALLOWED', attempt(() => runs.recover(ctx.store, ctx.config, { actor: 'backend-engineer', all: true })));

    // ---- E. Degenerate configuration values.
    step('F8.config.zeroRuns', 'limits.maxActiveRuns: 0', 'documented', attempt(() => { const c = tmpProject({ configOverrides: { limits: { maxActiveRuns: 0 } } }); dirs.push(c.dir); return runs.startRun(c.store, c.config, 'orchestrator', { agent: 'backend-engineer' }); }));
    step('F8.config.negativeRuns', 'limits.maxActiveRuns: -1', 'documented', attempt(() => { const c = tmpProject({ configOverrides: { limits: { maxActiveRuns: -1 } } }); dirs.push(c.dir); return 'config accepted'; }));
    step('F8.config.fractionalRuns', 'limits.maxActiveRuns: 1.5', 'documented', attempt(() => { const c = tmpProject({ configOverrides: { limits: { maxActiveRuns: 1.5 } } }); dirs.push(c.dir); runs.startRun(c.store, c.config, 'orchestrator', { agent: 'a-role' }); return attempt(() => runs.startRun(c.store, c.config, 'orchestrator', { agent: 'b-role' })); }));
    step('F8.usage.negative', 'run end --cost-usd -5 (would lower the recorded spend)', 'refused:INVALID_INPUT', (() => { const c = tmpProject(); dirs.push(c.dir); const id = runs.startRun(c.store, c.config, 'orchestrator', { agent: 'backend-engineer' }); return attempt(() => runs.endRun(c.store, c.config, id, 'orchestrator', { costUsd: -5 })); })());
  } finally {
    cleanup(...dirs);
  }
  finish();
})();
