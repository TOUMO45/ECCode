#!/usr/bin/env node
'use strict';
// A4: `fix verify` on every real fix of a range that ships a test. For each,
// a scratch repo holds the fix uncommitted over its parent; the engine sets up
// a debug-track task, the owner claims it and runs `fix verify`. Ground truth:
// the same test command run directly on the parent with the new tests, and on
// the fix. Expected verdict:
//   pre passes                 -> not proven (the test does not reproduce)
//   post fails                 -> not proven (the fix fails its test)
//   pre fails on missing API   -> inconclusive (ImportError, AttributeError, ...)
//   pre fails otherwise        -> proven
// The engine's verdict must equal it. This regex oracle cannot judge every
// reason a test fails, so each disagreement is labelled by hand afterwards
// (labels/fixverify.json: engine-wrong or oracle-wrong, with the reason).
// usage: node a4-fixverify.js <range>
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib');
const { fixPopulation, scratchRepo, run, eccode } = require('./scratch');

const MISSING_API = /\b(ImportError|ModuleNotFoundError|AttributeError|NameError)\b|cannot import name/;

// In fix verify's own words (lib/fixverify.js), so a match is an agreement.
function expectedVerdict(pre, post) {
  if (pre.code === 0) return 'tests-pass-without-fix';
  if (post.code !== 0) return 'fix-fails-tests';
  // The whole output: Mealie's warnings summary pushes a collection error far above the tail.
  return MISSING_API.test(pre.out || pre.tail) ? 'inconclusive' : 'proven';
}

function one(mirror, c) {
  const s = scratchRepo(mirror, c);
  try {
    // Direct truth, pre: the parent's tree with the new test files copied in.
    const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-pre-'));
    let direct;
    try {
      lib.treeAt(lib.MEALIE, c.parent, pre);
      for (const f of s.testFiles) {
        fs.mkdirSync(path.dirname(path.join(pre, f)), { recursive: true });
        fs.copyFileSync(path.join(s.root, f), path.join(pre, f));
      }
      direct = { pre: run(s.testCmd, pre, s.venvEnv), post: run(s.testCmd, s.root, s.venvEnv) };
    } finally {
      fs.rmSync(pre, { recursive: true, force: true });
    }
    const started = Date.now();
    const setup = eccode(s.root, ['debug', c.subject.slice(0, 120), '--actor', 'orchestrator', '--owner', 'backend-engineer', '--files', '**', '--command', s.testCmd], s.venvEnv);
    if (setup.code !== 0) throw new Error(`eccode debug failed: ${setup.stderr.split('\n')[0]}`);
    const claim = eccode(s.root, ['task', 'claim', 'fix', '--actor', 'backend-engineer'], s.venvEnv);
    if (claim.code !== 0) throw new Error(`claim failed: ${claim.stderr.split('\n')[0]}`);
    const fv = eccode(s.root, ['fix', 'verify', '--task', 'fix', '--actor', 'backend-engineer', '--json'], s.venvEnv);
    let r;
    try {
      r = JSON.parse(fv.stdout);
    } catch {
      throw new Error(`fix verify printed no result: ${fv.stderr.split('\n')[0]}`);
    }
    const expected = expectedVerdict(direct.pre, direct.post);
    return {
      sha: c.sha,
      subject: c.subject,
      tests: s.testFiles,
      verdict: r.verdict,
      reason: r.reason,
      engine: { pre: r.pre && r.pre.exitCode, post: r.post && r.post.exitCode },
      direct: { pre: direct.pre.code, post: direct.post.code, preLines: direct.pre.code ? direct.pre.out.split('\n').filter((l) => /^E\s|Error:|^FAILED|^ERROR/.test(l)).slice(0, 6) : [] },
      expected,
      agree: r.verdict === expected,
      ms: Date.now() - started,
    };
  } finally {
    s.cleanup();
  }
}

function main(argv) {
  const range = argv[0];
  if (!range) throw new Error('usage: a4-fixverify.js <range>');
  const mirror = lib.mealieMirror();
  const population = fixPopulation(lib.commitsIn(mirror, range));
  process.stderr.write(`a4: ${population.length} fixes with tests\n`);
  const out = lib.replay(population, (c) => {
    const row = one(mirror, c);
    process.stderr.write(`a4: ${c.sha.slice(0, 8)} ${row.verdict} (expected ${row.expected})\n`);
    return row;
  });
  const rows = out.results;
  const result = { range, population: population.length, rows, skipped: out.skipped, agreement: rows.length ? rows.filter((r) => r.agree).length / rows.length : null, byVerdict: rows.reduce((m, r) => ({ ...m, [r.verdict]: (m[r.verdict] || 0) + 1 }), {}) };
  const file = lib.writeResult('a4-fixverify', result, process.env.ECCODE_PILOT_RESULTS || lib.RESULTS);
  process.stdout.write(`${file}\n${JSON.stringify({ population: result.population, replayed: rows.length, skipped: out.skipped.length, agreement: result.agreement, byVerdict: result.byVerdict })}\n`);
}

module.exports = { expectedVerdict };

if (require.main === module) main(process.argv.slice(2));
