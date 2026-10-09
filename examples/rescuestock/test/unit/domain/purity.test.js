// src/domain imports nothing outside src/domain, never reads the clock or the environment, and does no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DOMAIN_DIR = fileURLToPath(new URL('../../../src/domain/', import.meta.url));
const files = readdirSync(DOMAIN_DIR).filter((f) => f.endsWith('.js')).sort();
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('domain purity: the module set is the one the design lists', () => {
  for (const f of ['canonical', 'compat', 'derive', 'explain', 'money', 'oracle', 'planner', 'states', 'time']) assert.ok(files.includes(`${f}.js`), f);
});

test('domain purity: every import is another file of src/domain or node:crypto', () => {
  for (const f of files) {
    const src = strip(readFileSync(path.join(DOMAIN_DIR, f), 'utf8'));
    const specs = [...src.matchAll(/(?:import|export)[^'"`;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.equal(/\bimport\s*\(/.test(src), false, `${f} uses a dynamic import`);
    assert.equal(/\brequire\s*\(/.test(src), false, `${f} uses require`);
    for (const spec of specs) {
      const ok = spec === 'node:crypto' || (/^\.\/[a-z]+\.js$/.test(spec) && files.includes(spec.slice(2)));
      assert.ok(ok, `${f} imports "${spec}"`);
    }
  }
});

test('domain purity: no ambient clock, randomness, environment, I/O or timers', () => {
  const forbidden = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bnew Date\s*\(\s*\)/, 'new Date()'],
    [/\bperformance\.now\s*\(/, 'performance.now()'],
    [/\bMath\.random\s*\(/, 'Math.random()'],
    [/\bprocess\b/, 'process'],
    [/\bglobalThis\b/, 'globalThis'],
    [/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/, 'timers'],
    [/\bfetch\s*\(/, 'fetch'],
    [/\bconsole\./, 'console'],
    [/\brandomUUID|randomBytes|randomInt/, 'crypto randomness'],
  ];
  for (const f of files) {
    const src = strip(readFileSync(path.join(DOMAIN_DIR, f), 'utf8'));
    for (const [re, name] of forbidden) assert.equal(re.test(src), false, `${f} uses ${name}`);
  }
});
