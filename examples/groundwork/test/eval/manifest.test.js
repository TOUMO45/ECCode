// Holdout integrity (spec 8.5): recomputes SHA-256 for every file under eval/holdout/ and compares
// with MANIFEST.sha256 (sha256sum format, paths relative to eval/holdout, manifest itself excluded).
// Fails on a missing, extra or changed file. Also pins the holdout shape and canary hygiene.
// No network, no clock, no model.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EVAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eval');
const HOLD = path.join(EVAL, 'holdout');
const MANIFEST = 'MANIFEST.sha256';
const LINE_RE = /^([0-9a-f]{64}) [ *](\S.*)$/u;

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(HOLD, rel))).digest('hex');

/** Parse sha256sum output. Throws on any malformed or duplicate line. */
function parseManifest(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const m = LINE_RE.exec(line);
    assert.ok(m, `malformed manifest line: ${JSON.stringify(line)}`);
    assert.ok(!map.has(m[2]), `duplicate manifest entry: ${m[2]}`);
    map.set(m[2], m[1]);
  }
  return map;
}

/** Compare manifest map with actual map; returns problem strings. */
function diffManifest(expected, actual) {
  const problems = [];
  for (const [rel, h] of expected) {
    if (!actual.has(rel)) problems.push(`missing: ${rel}`);
    else if (actual.get(rel) !== h) problems.push(`changed: ${rel}`);
  }
  for (const rel of actual.keys()) if (!expected.has(rel)) problems.push(`extra: ${rel}`);
  return problems;
}

describe('holdout manifest', () => {
  const files = walk(HOLD).filter((f) => f !== MANIFEST).sort();
  const actual = new Map(files.map((f) => [f, sha(f)]));
  const expected = parseManifest(fs.readFileSync(path.join(HOLD, MANIFEST), 'utf8'));

  test('every holdout file matches MANIFEST.sha256 (no missing, extra or changed files)', () => {
    assert.deepEqual(diffManifest(expected, actual), []);
  });

  test('manifest is sorted and uses relative paths', () => {
    const keys = [...expected.keys()];
    assert.deepEqual(keys, [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const k of keys) assert.ok(!k.startsWith('/') && !k.includes('..'), k);
  });

  test('detector flags missing, extra and changed files (synthetic)', () => {
    const exp = new Map([['a.json', 'h1'], ['b.json', 'h2']]);
    assert.deepEqual(diffManifest(exp, new Map([['a.json', 'h1'], ['b.json', 'h2']])), []);
    assert.deepEqual(diffManifest(exp, new Map([['a.json', 'h1']])), ['missing: b.json']);
    assert.deepEqual(diffManifest(exp, new Map([['a.json', 'h1'], ['b.json', 'h2'], ['c.json', 'h3']])), ['extra: c.json']);
    assert.deepEqual(diffManifest(exp, new Map([['a.json', 'hX'], ['b.json', 'h2']])), ['changed: a.json']);
  });

  test('parser rejects malformed and duplicate lines', () => {
    assert.throws(() => parseManifest('nothex  a.json\n'));
    assert.throws(() => parseManifest(`${'a'.repeat(64)}  a.json\n${'b'.repeat(64)}  a.json\n`));
  });

  test('holdout has exactly 12 incident and 10 injection files and nothing else', () => {
    assert.equal(files.filter((f) => /^incidents\/[^/]+\.json$/u.test(f)).length, 12);
    assert.equal(files.filter((f) => /^injections\/[^/]+\.json$/u.test(f)).length, 10);
    assert.equal(files.length, 22, `unexpected files: ${files.join(', ')}`);
  });
});

describe('holdout dataset hygiene', () => {
  const load = (dir) => fs.readdirSync(path.join(HOLD, dir)).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(HOLD, dir, f), 'utf8')));
  const inc = load('incidents');
  const inj = load('injections');
  const tune = ['tune/incidents', 'tune/injections'].flatMap((d) => fs.readdirSync(path.join(EVAL, d))
    .map((f) => fs.readFileSync(path.join(EVAL, d, f), 'utf8')));

  test('shape and labels', () => {
    for (const d of [...inc, ...inj]) {
      const n = d.lines.length;
      assert.ok(n >= 40 && n <= 120, `${d.id}: ${n} lines`);
      d.lines.forEach((l, i) => {
        assert.equal(l.n, i + 1);
        assert.match(l.time, /^\d{2}:\d{2}$/u);
        assert.ok(l.author.length >= 1 && l.author.length <= 64 && !l.author.includes(':'));
        assert.ok(l.text.length >= 1 && l.text.length <= 2000);
      });
      assert.ok(d.gold.timeline.length >= 6 && d.gold.timeline.length <= 15, `${d.id}: timeline`);
      assert.ok(d.gold.actions.length >= 2 && d.gold.actions.length <= 6, `${d.id}: actions`);
      for (const e of d.gold.timeline) assert.ok(e.lines.some((x) => d.lines[x - 1].time === e.time), `${d.id}: ${e.time}`);
      for (const g of [...d.gold.timeline, ...d.gold.actions]) assert.ok(g.lines.every((x) => x >= 1 && x <= n));
      for (const s of d.correctStatements) assert.ok(s.cites.length >= 1 && s.cites.every((x) => x >= 1 && x <= n));
      for (const e of d.gold.timeline) {
        assert.ok(d.correctStatements.some((s) => s.section === 'timeline' && s.text.includes(e.time) && s.cites.some((c) => e.lines.includes(c))), `${d.id}: no statement for ${e.time}`);
      }
      for (const a of d.gold.actions) {
        assert.ok(d.correctStatements.some((s) => s.section === 'actionItems' && s.cites.some((c) => a.lines.includes(c))));
      }
    }
    assert.equal(new Set([...inc, ...inj].map((d) => d.id)).size, 22);
    for (const d of inc) assert.equal(d.injection, undefined);
  });

  test('injection canaries are unique, confined to payload lines, absent from tune and statements', () => {
    const canaries = inj.map((d) => d.injection.canary);
    assert.equal(new Set(canaries).size, 10);
    assert.equal(new Set(inj.map((d) => d.injection.kind)).size, 10, 'ten distinct attack kinds');
    for (const d of inj) {
      const { canary, injectionLines } = d.injection;
      assert.match(canary, /^CANARY-[a-z0-9]+$/u);
      d.lines.forEach((l) => {
        assert.equal(`${l.author} ${l.text}`.includes(canary), injectionLines.includes(l.n), `${d.id}: line ${l.n}`);
      });
      for (const s of d.correctStatements) assert.ok(!s.text.includes(canary));
      for (const t of tune) assert.ok(!t.includes(canary), `${d.id}: canary appears in the tune set`);
      for (const other of [...inc, ...inj]) if (other !== d) assert.ok(!JSON.stringify(other).includes(canary));
    }
  });
});

describe('retired holdout', () => {
  test('holdout-retired-1 is kept for history but is not what loadSet(holdout) reads', async () => {
    const { loadSet } = await import('../../eval/lib/load.js');
    const retired = path.join(EVAL, 'holdout-retired-1');
    assert.ok(fs.existsSync(path.join(retired, MANIFEST)));
    const ids = loadSet(EVAL, true);
    const all = [...ids.incidents, ...ids.injections].map((d) => d.id);
    assert.equal(all.length, 22);
    assert.ok(all.every((id) => id.startsWith('hold3-')), all.join(','));
  });
});
