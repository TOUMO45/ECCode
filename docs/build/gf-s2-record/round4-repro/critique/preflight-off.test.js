'use strict';
// E2 reproduction: the managed-path preflight (lib/greenfield/preflight.js, F0 of design 16.4) reads only the hook
// matcher of .claude/settings.json and its OWN process environment. Project settings that turn the guard off for the
// session (the settings "env" block setting ECCODE_HOOKS=off, which the guard obeys at scripts/hooks/guard.js:369, or
// "disableAllHooks", in settings.json or settings.local.json) leave the report at "managed-path" with no warning.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const COPY = path.resolve(__dirname, '..', 'copy');
const { gfProject } = require(path.join(COPY, 'tests/fixtures/gf/flow'));
const { install } = require(path.join(COPY, 'lib/install'));
const preflightMod = require(path.join(COPY, 'lib/greenfield/preflight'));

const variants = [
  ['settings.json env ECCODE_HOOKS=off', (dir) => { const f = path.join(dir, '.claude/settings.json'); const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.env = { ...(s.env || {}), ECCODE_HOOKS: 'off' }; fs.writeFileSync(f, JSON.stringify(s, null, 2)); }],
  ['settings.json disableAllHooks', (dir) => { const f = path.join(dir, '.claude/settings.json'); const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.disableAllHooks = true; fs.writeFileSync(f, JSON.stringify(s, null, 2)); }],
  ['settings.local.json disableAllHooks', (dir) => fs.writeFileSync(path.join(dir, '.claude/settings.local.json'), JSON.stringify({ disableAllHooks: true }))],
];
for (const [name, apply] of variants) {
  test(`E2-8: ${name}: the preflight still reports the managed-path regime with no warning`, () => {
    delete process.env.ECCODE_HOOKS;
    const ctx = gfProject();
    install({ target: ctx.dir, profile: 'sandbox' });
    assert.strictEqual(preflightMod.preflight(ctx.dir).regime, 'managed-path', 'control: a fresh sandbox install is managed-path');
    apply(ctx.dir);
    const r = preflightMod.preflight(ctx.dir);
    console.log(`${name}: regime=${r.regime} guardWired=${r.guardWired} hooksOff=${r.hooksOff} warnings=${JSON.stringify(r.warnings)}`);
    assert.strictEqual(r.regime, 'text-level', 'F0: settings that turn the guard off must not be reported as the managed-path regime');
    assert.ok(r.warnings.length > 0, 'F0: a guard that does nothing is a warning that names the consequence');
  });
}
