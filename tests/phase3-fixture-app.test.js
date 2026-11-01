'use strict';
// The Phase 3 fixture app (tests/fixtures/phase3/ledger) and its seeded
// flaws: the clean app's suite passes; every flaw applies (each find exactly
// once), its migrations (if any) form a valid revision chain, and the app's
// suite stays green, except for the entries seeds.js marks `suiteBreaks`,
// which are tolerated by id. Needs an interpreter with fastapi, httpx,
// sqlalchemy, alembic and pytest (ECCODE_PYTHON); without one these tests
// skip and say so, and fail instead when ECCODE_REQUIRE_PHASE3=1 (CI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { materialize, seedFlaw, python, runSuite, FLAWS } = require('./fixtures/phase3/build');

const py = python();
const skip = py.python ? false : (process.env.ECCODE_REQUIRE_PHASE3 === '1' ? (() => { throw new Error(py.reason); })() : py.reason);
const PY = py.python;

// Entries whose suite cannot stay green by construction (see the comments in seeds.js).
const SUITE_EXCEPTIONS = {
  // The chain is valid and upgrades a fresh database; on a populated one the ALTER is refused.
  'b1-notnull-no-default': { migrationFailsOnData: { table: 'transfers', error: /NOT NULL column/ } },
  'b1-drop-column': {},
};

function alembic(dir, dbFile, args) {
  return spawnSync(PY, ['-m', 'alembic', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, LEDGER_DB: dbFile, PYTHONDONTWRITEBYTECODE: '1' } });
}

test('the seed list has the required entries and every exception is a listed flaw', () => {
  const ids = FLAWS.map((f) => f.id);
  const required = ['b1-notnull-no-default', 'b1-drop-column', 'b1-missing-downgrade', 'b1-rename-in-place', 'b1-add-nullable', 'b1-add-index', 'b1-expand-step', 'b1-add-default',
    'b2-remove-endpoint', 'b2-field-type', 'b2-new-required-param', 'b2-optional-param', 'b2-new-endpoint', 'b2-new-field',
    'b3-nplus1-orders', 'b3-nplus1-accounts', 'b3-latency', 'b3-same-queries', 'b3-faster',
    'b4-double-spend', 'b4-duplicate-insert', 'b4-transfer-ok',
    'c-idor-read', 'c-idor-update', 'c-idor-delete', 'c-mass-assignment', 'c-field-leak', 'c-missing-auth', 'c-reset-reuse', 'c-sql-concat', 'c-safe-rename'];
  for (const id of required) assert.ok(ids.includes(id), `missing seed ${id}`);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');
  for (const f of FLAWS) {
    assert.ok(['B1', 'B2', 'B3', 'B4', 'C'].includes(f.part), `${f.id}: part`);
    assert.ok(['caught', 'clean'].includes(f.expect), `${f.id}: expect`);
    assert.ok(f.kind && f.description && Array.isArray(f.changes) && f.changes.length > 0, `${f.id}: shape`);
    if (f.suiteBreaks) assert.ok(SUITE_EXCEPTIONS[f.id], `${f.id} is marked suiteBreaks but the test does not list it`);
  }
  for (const id of Object.keys(SUITE_EXCEPTIONS)) assert.ok(FLAWS.find((f) => f.id === id && f.suiteBreaks), `${id} is listed as an exception but not marked suiteBreaks`);
});

test('the clean app: its suite passes and the migration round-trips', { skip }, () => {
  const { dir, base } = materialize();
  try {
    assert.match(base, /^[0-9a-f]{40}$/);
    const r = runSuite(dir, PY);
    assert.ok(r.passed, `clean suite: ${r.summary}\n${r.stdout}`);
    assert.match(r.summary, /\b(3\d|4\d) passed\b/, `roughly 30 to 45 tests: ${r.summary}`);
    const dbFile = path.join(dir, 'roundtrip.sqlite');
    for (const args of [['upgrade', 'head'], ['downgrade', 'base'], ['upgrade', 'head']]) {
      const a = alembic(dir, dbFile, ['-q', ...args]);
      assert.strictEqual(a.status, 0, `alembic ${args.join(' ')}: ${a.stderr}`);
    }
    assert.strictEqual(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.replace(/.*roundtrip\.sqlite.*\n?/, '').trim(), '', 'the suite leaves the tree clean');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every seeded flaw applies, migrates and keeps the suite green (except the listed exceptions)', { skip }, async (t) => {
  const rows = [];
  for (const flaw of FLAWS) {
    await t.test(flaw.id, () => {
      const s = seedFlaw(flaw.id);
      try {
        const changed = s.apply();
        assert.ok(changed.length > 0, `${flaw.id}: changed files`);
        for (const f of changed) assert.ok(fs.existsSync(path.join(s.dir, f)) || flaw.changes.some((c) => c.deleteFile === f), `${flaw.id}: ${f} exists`);
        const diff = spawnSync('git', ['status', '--porcelain'], { cwd: s.dir, encoding: 'utf8' }).stdout.trim();
        assert.ok(diff, `${flaw.id}: the working tree differs from the base`);
        const exception = SUITE_EXCEPTIONS[flaw.id];
        const added = flaw.changes.filter((c) => c.addFile && c.addFile.startsWith('alembic/versions/')).map((c) => c.addFile);
        let migrated = 'n/a';
        if (added.length) {
          const dbFile = path.join(s.dir, 'chain.sqlite');
          const heads = alembic(s.dir, dbFile, ['heads']);
          assert.strictEqual(heads.status, 0, `${flaw.id}: alembic heads: ${heads.stderr}`);
          assert.strictEqual(heads.stdout.trim().split('\n').length, 1, `${flaw.id}: exactly one head: ${heads.stdout}`);
          assert.match(heads.stdout, /0002/, `${flaw.id}: the new migration is the head`);
          const up = alembic(s.dir, dbFile, ['-q', 'upgrade', 'head']);
          assert.strictEqual(up.status, 0, `${flaw.id}: alembic upgrade head on a fresh database: ${up.stderr}`);
          migrated = 'ok';
          if (exception && exception.migrationFailsOnData) {
            // Base schema, one row in the table, then the new migration: refused.
            const populated = path.join(s.dir, 'populated.sqlite');
            assert.strictEqual(alembic(s.dir, populated, ['-q', 'upgrade', '0001']).status, 0, `${flaw.id}: upgrade to 0001`);
            const fill = spawnSync(PY, ['-c', `import sqlite3; c = sqlite3.connect(${JSON.stringify(populated)}); c.execute("INSERT INTO ${exception.migrationFailsOnData.table} (from_account, to_account, amount, created_at) VALUES (1, 2, 1, '2026-01-01 00:00:00')"); c.commit()`], { encoding: 'utf8' });
            assert.strictEqual(fill.status, 0, `${flaw.id}: insert a row: ${fill.stderr}`);
            const again = alembic(s.dir, populated, ['-q', 'upgrade', 'head']);
            assert.notStrictEqual(again.status, 0, `${flaw.id}: the migration is expected to fail on a populated table`);
            assert.match(again.stderr, exception.migrationFailsOnData.error, `${flaw.id}: fails for the expected reason`);
            migrated = 'ok (fails on data)';
          }
        }
        const r = runSuite(s.dir, PY, ['-x']);
        if (exception) assert.ok(!r.passed, `${flaw.id} is listed as an exception but its suite passes: ${r.summary}`);
        else assert.ok(r.passed, `${flaw.id}: the suite still passes\n${r.summary}\n${r.stdout.slice(-3000)}`);
        rows.push({ id: flaw.id, part: flaw.part, expect: flaw.expect, files: changed.length, migrated, suite: r.passed ? 'green' : `red (expected: ${flaw.suiteBreaks})` });
      } finally {
        fs.rmSync(s.dir, { recursive: true, force: true });
      }
    });
  }
  process.stdout.write(`\n${rows.map((r) => `${r.id.padEnd(24)} ${r.part}  ${r.expect.padEnd(6)} files ${r.files}  migration ${r.migrated.padEnd(18)} suite ${r.suite}`).join('\n')}\n\n`);
});
