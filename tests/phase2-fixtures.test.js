'use strict';
// Real capability on the Phase 2 fixtures (tests/fixtures/phase2): six
// seeded bugs for the localizers and ten seeded behaviour changes for the
// diff, with a scorecard. Needs an interpreter with fastapi, httpx,
// hypothesis, coverage and pytest (ECCODE_PYTHON); without one these tests
// skip and say so, and fail instead when ECCODE_REQUIRE_PHASE2=1 (CI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { seedBug, seedChange, python, BUGS, CHANGES } = require('./fixtures/phase2/build');
const { Store } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const { init } = require('../lib/project');
const lab = require('../lib/lab');
const behavior = require('../lib/behavior');

const py = python();
const skip = py.python ? false : (process.env.ECCODE_REQUIRE_PHASE2 === '1' ? (() => { throw new Error(py.reason); })() : py.reason);
if (py.python) process.env.ECCODE_PYTHON = py.python;
const PY = py.python;
const score = { localization: [], bisect: [], diff: [] };

function pytest(dir, args) {
  return spawnSync(PY, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-W', 'ignore', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
}

function reproCommand(bug) {
  return bug.repro.command.replace(/^pytest\b/, `${PY} -m pytest`);
}

test('debug fixtures: SBFL ranks the faulty line in the top 5 (or says why not); bisect finds the breaking commit', { skip }, () => {
  for (const bug of BUGS) {
    const s = seedBug(bug.id);
    try {
      assert.notStrictEqual(pytest(s.dir, reproCommand(bug).split(' ').slice(3)).status, 0, `${bug.id}: the reproduction fails`);
      require('../lib/quick').start(s.dir, 'orchestrator', { request: `bug ${bug.id}`, track: 'debug', command: 'pytest' });
      const store = new Store(s.dir);
      const config = loadConfig(s.dir);
      lab.recordRepro(store, config, 'backend-engineer', { command: reproCommand(bug) });
      if (bug.history) {
        const r = lab.bisect(store, config, 'backend-engineer', { good: s.base });
        const hit = r.suspects.length && r.suspects[0].commit === s.bugCommit;
        score.bisect.push({ bug: bug.id, status: r.status, hit: Boolean(hit) });
        assert.ok(hit, `${bug.id}: bisect found ${JSON.stringify(r.suspects)} (${r.problem || ''}), expected ${s.bugCommit}`);
      }
      const r = lab.localizeSbfl(store, config, 'backend-engineer', {});
      const top = r.suspects.map((x) => `${x.file}:${x.line}`);
      const hit = r.suspects.some((x) => x.file === bug.file && s.faulty.includes(x.line));
      score.localization.push({ bug: bug.id, kind: bug.kind, hit, top, faulty: s.faulty.map((l) => `${bug.file}:${l}`), failing: r.totals.failing, passing: r.totals.passing });
      assert.strictEqual(store.audit().ok, true, `${bug.id}: audit`);
      assert.strictEqual(spawnSync('git', ['worktree', 'list'], { cwd: s.dir, encoding: 'utf8' }).stdout.trim().split('\n').length, 1, 'no worktree left behind');
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }
  // Pre-registered expectation (docs/design/phase2-plan.md): the four bugs
  // with a wrong line are ranked; the import-time constant and the omission
  // are known SBFL blind spots and are reported, not asserted.
  for (const id of ['off-by-one', 'wrong-condition', 'state-leak']) assert.ok(score.localization.find((x) => x.bug === id).hit, `${id} in the top 5: ${JSON.stringify(score.localization.find((x) => x.bug === id))}`);
});

test('behaviour fixtures: six unintended changes that pass the suite are flagged; three declared changes pass; one refactor yields zero differences', { skip }, () => {
  for (const change of CHANGES) {
    const s = seedChange(change.id);
    try {
      const store = init(s.dir, { name: 'shop', idea: change.kind, track: change.refactor ? 'refactor' : 'fix', behavior: change.refactor ? `${PY} -m pytest` : undefined });
      const config = loadConfig(s.dir);
      s.apply();
      assert.strictEqual(pytest(s.dir, []).status, 0, `${change.id}: the suite still passes after the change`);
      if (change.contract) behavior.contract(store, config, 'backend-engineer', change.contract);
      const routing = behavior.route(store, config, 'backend-engineer');
      assert.strictEqual(routing.decision, 'run', `${change.id}: the change reaches a public surface`);
      const d = behavior.diff(store, config, 'backend-engineer', {});
      const row = { change: change.id, kind: change.kind, expect: change.expect, probes: d.probes, executed: d.executed, dropped: d.dropped, differences: d.differences.length, unexplained: d.unexplained, coverage: d.coverage, verdict: null };
      row.verdict = change.expect === 'flagged' ? (d.unexplained > 0 ? 'caught' : 'MISSED') : change.expect === 'clean' ? (d.unexplained === 0 && d.differences.length > 0 ? 'clean' : d.unexplained ? 'FALSE POSITIVE' : 'clean (no difference observed)') : (d.differences.length === 0 ? 'zero' : 'FALSE POSITIVE');
      score.diff.push(row);
      assert.strictEqual(d.coverage, 'ok', `${change.id}: coverage ${d.coverageNote}`);
      if (change.expect === 'flagged') assert.ok(d.unexplained > 0, `${change.id}: expected an unexplained difference, got ${JSON.stringify(d.differences.slice(0, 3))} notes ${d.notes.join('; ')}`);
      else assert.strictEqual(d.unexplained, 0, `${change.id}: expected no unexplained difference, got ${JSON.stringify(d.differences.filter((x) => x.classification === 'unexplained').slice(0, 3))}`);
      if (change.expect === 'zero') assert.strictEqual(d.differences.length, 0, `${change.id}: a refactor yields zero differences`);
      assert.strictEqual(store.audit().ok, true, `${change.id}: audit`);
      assert.strictEqual(spawnSync('git', ['worktree', 'list'], { cwd: s.dir, encoding: 'utf8' }).stdout.trim().split('\n').length, 1, 'no worktree left behind');
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }
});

test('scorecard', { skip }, () => {
  const lines = ['# Phase 2 fixture scorecard', '', `Generated by tests/phase2-fixtures.test.js on ${new Date().toISOString().slice(0, 10)} with ${PY}.`, ''];
  lines.push('## Localization (SBFL, Ochiai, top 5)', '', '| Bug | Kind | Faulty line in top 5 | Top 5 | Faulty lines | Failing / passing tests |', '|---|---|---|---|---|---|');
  for (const r of score.localization) lines.push(`| ${r.bug} | ${r.kind} | ${r.hit ? 'yes' : 'no'} | ${r.top.join(', ')} | ${r.faulty.join(', ')} | ${r.failing} / ${r.passing} |`);
  lines.push('', `Hit rate: ${score.localization.filter((r) => r.hit).length} of ${score.localization.length}.`, '');
  lines.push('## Bisect', '', '| Bug | Status | Right commit |', '|---|---|---|');
  for (const r of score.bisect) lines.push(`| ${r.bug} | ${r.status} | ${r.hit ? 'yes' : 'no'} |`);
  lines.push('', '## Behavior diff', '', '| Change | Kind | Expected | Probes (executed / dropped) | Differences (unexplained) | Coverage | Verdict |', '|---|---|---|---|---|---|---|');
  for (const r of score.diff) lines.push(`| ${r.change} | ${r.kind} | ${r.expect} | ${r.probes} (${r.executed} / ${r.dropped}) | ${r.differences} (${r.unexplained}) | ${r.coverage} | ${r.verdict} |`);
  const caught = score.diff.filter((r) => r.expect === 'flagged' && r.verdict === 'caught').length;
  const flaggedTotal = score.diff.filter((r) => r.expect === 'flagged').length;
  const falsePositives = score.diff.filter((r) => r.verdict.startsWith('FALSE')).length;
  lines.push('', `Unintended changes caught: ${caught} of ${flaggedTotal}. False positives on declared changes and the refactor: ${falsePositives} of ${score.diff.length - flaggedTotal}.`, '');
  const text = lines.join('\n');
  process.stdout.write(`\n${text}\n`);
  if (process.env.ECCODE_WRITE_SCORECARD === '1') fs.writeFileSync(path.join(__dirname, 'fixtures', 'phase2', 'scorecard.md'), text);
});
