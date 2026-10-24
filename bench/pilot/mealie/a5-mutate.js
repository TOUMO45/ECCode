#!/usr/bin/env node
'use strict';
// A5: `eccode mutate` on the changed lines of every real fix that ships a
// test (the A4 population), with the fix's own changed tests as the test
// command: mutants per changed line, kill rate, timeouts, errors, wall time.
// The criterion is that the run completes; the kill rate is reported.
// usage: node a5-mutate.js <range>
const lib = require('../lib');
const { fixPopulation, scratchRepo, eccode } = require('./scratch');

function one(mirror, c) {
  const s = scratchRepo(mirror, c);
  try {
    const started = Date.now();
    const r = eccode(s.root, ['mutate', '--test', s.testCmd, '--base', s.base, '--json'], s.venvEnv);
    let res = null;
    try {
      res = JSON.parse(r.stdout);
    } catch {
      res = null;
    }
    const error = res ? null : (r.stderr.match(/eccode: \[([A-Z_]+)\]/) || [])[1] || `exit ${r.code}`;
    return { sha: c.sha, subject: c.subject, tests: s.testFiles, lines: res ? res.lines : null, available: res ? res.available : null, total: res ? res.total : null, killed: res ? res.killed : null, survived: res ? res.survived : null, timeouts: res ? res.timeouts : null, invalid: res ? res.invalid : null, score: res ? res.score : null, ms: Date.now() - started, error };
  } finally {
    s.cleanup();
  }
}

function main(argv) {
  const range = argv[0];
  if (!range) throw new Error('usage: a5-mutate.js <range>');
  const mirror = lib.mealieMirror();
  const population = fixPopulation(lib.commitsIn(mirror, range));
  process.stderr.write(`a5: ${population.length} fixes with tests\n`);
  const out = lib.replay(population, (c) => {
    const row = one(mirror, c);
    process.stderr.write(`a5: ${c.sha.slice(0, 8)} ${row.error || `${row.killed}/${row.total} killed`}\n`);
    return row;
  });
  const rows = out.results;
  const completed = rows.filter((r) => !r.error);
  const killed = completed.reduce((s, r) => s + r.killed, 0);
  const total = completed.reduce((s, r) => s + r.total, 0);
  const result = { range, population: population.length, rows, skipped: out.skipped, completedShare: rows.length ? completed.length / rows.length : null, killed, total, killRate: total ? killed / total : null, errors: rows.filter((r) => r.error).reduce((m, r) => ({ ...m, [r.error]: (m[r.error] || 0) + 1 }), {}) };
  const file = lib.writeResult('a5-mutate', result, process.env.ECCODE_PILOT_RESULTS || lib.RESULTS);
  process.stdout.write(`${file}\n${JSON.stringify({ population: result.population, replayed: rows.length, completedShare: result.completedShare, killRate: result.killRate, errors: result.errors })}\n`);
}

if (require.main === module) main(process.argv.slice(2));
