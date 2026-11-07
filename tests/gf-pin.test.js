'use strict';
// S2, T4: GF-CONF-1. The three guard configurations (.eccode/behavior.json, guards.json, security.json) are engine
// configuration: an agent must not weaken the security policy by editing them. The orchestrator (or the user) pins
// their hashes; a change after the pin is detected by the audit, and no group role may write them (the hook).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sample = require('./fixtures/gf/sample');
const { gfProject, run, WRAPPED } = require('./fixtures/gf/flow');
const wrap = require('../lib/greenfield/wrap');
const pinMod = require('../lib/greenfield/pin');
const audit = require('../lib/greenfield/audit');
const mcp = require('../lib/mcp');
const { project } = require('../lib/greenfield/projection');
const { sha256 } = require('../lib/util');
const { tmpProject } = require('./helpers');

const GUARD = path.join(__dirname, '..', 'scripts/hooks/guard.js');
const CLI = path.join(__dirname, '..', 'bin', 'eccode-gf.js');
const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);
const errs = (ctx) => audit.run(ctx.store, ctx.config).errors;
const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refusal(fn) { try { fn(); } catch (e) { return e; } throw new Error('expected a refusal, but the call succeeded'); }
const call = (name, args, ctx, actor) => mcp.tools().find((t) => t.name === name).handler(args, { store: ctx.store, config: ctx.config, actor });
const REASON = 'pin the guard configuration for slice S1';
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
const SEC = '{"policy":{"cells":[{"role":"member","operation":"listTasks","allow":"own"}]}}\n';
const BEH = '{"app":"app.main:app","python":"python3"}\n';
const sealed = () => { const ctx = gfProject(); run(ctx, sample.build(), WRAPPED); put(ctx, '.eccode/security.json', SEC); put(ctx, '.eccode/behavior.json', BEH); return ctx; };
function expectAudit(ctx, re) {
  const found = errs(ctx);
  assert.ok(found.some((e) => e.rule === 'GF-CONF-1' && re.test(e.message)), `expected GF-CONF-1 /${re.source}/; got ${JSON.stringify(found.map((e) => `${e.rule}: ${e.message.slice(0, 100)}`))}`);
}

// ------------------------------------------------------------------ positive
test('GF-CONF-1 positive: the orchestrator pins the config files that exist; the audit is clean on the pin', () => {
  const ctx = sealed();
  const r = pinMod.pin(ctx.store, ctx.config, 'orchestrator', { scope: 'S1', reason: REASON });
  assert.strictEqual(r.event.type, 'gf.config.pinned');
  assert.deepStrictEqual(r.event.data.files, { '.eccode/behavior.json': sha256(BEH), '.eccode/security.json': sha256(SEC) });
  assert.deepStrictEqual(errs(ctx).filter((e) => e.rule === 'GF-CONF-1'), []);
  assert.strictEqual(project(ctx.store.readEvents()).configPins.length, 1);
});
test('GF-CONF-1 positive: the user may pin; a second pin after an authorised change moves the expected hashes', () => {
  const ctx = sealed();
  pinMod.pin(ctx.store, ctx.config, 'user', { scope: 'S1', reason: REASON });
  put(ctx, '.eccode/security.json', '{"policy":{"cells":[]}}\n');
  expectAudit(ctx, /security\.json differs from the pin/);
  pinMod.pin(ctx.store, ctx.config, 'orchestrator', { scope: 'S2', reason: 'the slice S2 adds operations to the matrix' });
  assert.deepStrictEqual(errs(ctx).filter((e) => e.rule === 'GF-CONF-1'), []);
});
test('the MCP tool pins the same way', () => {
  const ctx = sealed();
  const out = call('gf_config_pin', { scope: 'S1', reason: REASON }, ctx, 'orchestrator');
  assert.strictEqual(out.scope, 'S1');
  assert.deepStrictEqual(Object.keys(out.files).sort(), ['.eccode/behavior.json', '.eccode/security.json']);
});

// ------------------------------------------------------------------ negative
const NEG = [
  ['a group role', 'backend-engineer', { scope: 'S1', reason: REASON }, (c) => {}, /orchestrator or the user/],
  ['a reviewer', 'technical-reviewer', { scope: 'S1', reason: REASON }, (c) => {}, /orchestrator or the user/],
  ['no scope', 'orchestrator', { reason: REASON }, (c) => {}, /scope/],
  ['a reason under 10 characters', 'orchestrator', { scope: 'S1', reason: 'short' }, (c) => {}, /reason/],
  ['no config file at all', 'orchestrator', { scope: 'S1', reason: REASON }, (c) => { fs.rmSync(path.join(c.dir, '.eccode/security.json')); fs.rmSync(path.join(c.dir, '.eccode/behavior.json')); }, /no guard configuration/],
  ['a config file that is not JSON', 'orchestrator', { scope: 'S1', reason: REASON }, (c) => put(c, '.eccode/security.json', '{not json'), /security\.json is not valid JSON/],
];
for (const [name, actor, input, setup, re] of NEG) {
  test(`GF-CONF-1 negative: pinning with ${name} is refused and writes nothing`, () => {
    const ctx = sealed();
    setup(ctx);
    const before = ctx.store.readEvents().length;
    const err = refusal(() => pinMod.pin(ctx.store, ctx.config, actor, input));
    assert.ok(rulesOf(err).includes('GF-CONF-1'), err.message);
    assert.match(err.message, re);
    assert.strictEqual(ctx.store.readEvents().length, before);
  });
}
test('pinning in a record that is not a Greenfield-Senior project is GF-INIT-1', () => {
  const plain = tmpProject();
  const err = refusal(() => pinMod.pin(plain.store, plain.config, 'orchestrator', { scope: 'S1', reason: REASON }));
  assert.ok(rulesOf(err).includes('GF-INIT-1'));
});

// ------------------------------------------------------------------ bypass
test('bypass: a security.json cell loosened after the pin, by any writer, is GF-CONF-1 in the audit', () => {
  const ctx = sealed();
  pinMod.pin(ctx.store, ctx.config, 'orchestrator', { scope: 'S1', reason: REASON });
  put(ctx, '.eccode/security.json', SEC.replace('"own"', '"all"'));
  expectAudit(ctx, /security\.json differs from the pin/);
});
test('bypass: a pinned config file deleted after the pin is GF-CONF-1', () => {
  const ctx = sealed();
  pinMod.pin(ctx.store, ctx.config, 'orchestrator', { scope: 'S1', reason: REASON });
  fs.rmSync(path.join(ctx.dir, '.eccode/behavior.json'));
  expectAudit(ctx, /behavior\.json is missing/);
});
test('bypass: a config file added after the pin (one the pin does not cover) is GF-CONF-1', () => {
  const ctx = sealed();
  pinMod.pin(ctx.store, ctx.config, 'orchestrator', { scope: 'S1', reason: REASON });
  put(ctx, '.eccode/guards.json', '{"migration":{}}\n');
  expectAudit(ctx, /guards\.json exists but is not in the pin/);
});
test('bypass: a pin forged through Store.commit by a group role is GF-CONF-1 in the audit', () => {
  const ctx = sealed();
  F(ctx, 'gf.config.pinned', 'backend-engineer', { id: 'pin-forged', scope: 'S1', files: { '.eccode/security.json': sha256(SEC) }, reason: 'forged pin by a group role' });
  expectAudit(ctx, /backend-engineer.*not the orchestrator or the user/);
});
test('bypass: a forged pin with no files is GF-CONF-1', () => {
  const ctx = sealed();
  F(ctx, 'gf.config.pinned', 'orchestrator', { id: 'pin-empty', scope: 'S1', files: {}, reason: 'a pin that pins nothing at all' });
  expectAudit(ctx, /pins no file/);
});
test('bypass: a pin that is correct audits clean however it was written', () => {
  const ctx = sealed();
  F(ctx, 'gf.config.pinned', 'orchestrator', { id: 'pin-ok', scope: 'S1', files: { '.eccode/behavior.json': sha256(BEH), '.eccode/security.json': sha256(SEC) }, reason: 'a correct pin committed directly' });
  assert.deepStrictEqual(errs(ctx).filter((e) => e.rule === 'GF-CONF-1'), []);
});
test('the project that has no pin has no opinion (the pin is made at slice open)', () => {
  const ctx = sealed();
  put(ctx, '.eccode/security.json', '{"anything":true}\n');
  assert.deepStrictEqual(errs(ctx).filter((e) => e.rule === 'GF-CONF-1'), []);
});

// ------------------------------------------------------------------ the hook
function hook(ctx, role, tool, input) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: ctx.dir, tool_name: tool, agent_type: `eccode:${role}`, tool_input: input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_ACTOR: '' } });
  if (!res.stdout) return { decision: 'allow', reason: '' };
  const o = JSON.parse(res.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason || '' };
}
const CONFIGS = ['.eccode/behavior.json', '.eccode/guards.json', '.eccode/security.json'];
for (const rel of CONFIGS) {
  for (const role of ['backend-engineer', 'integration-engineer', 'security-engineer', 'delivery-lead']) {
    test(`hook: ${role} writing ${rel} is denied with GF-CONF-1 by the file tool and by shell`, () => {
      const ctx = sealed();
      const viaTool = hook(ctx, role, 'Write', { file_path: path.join(ctx.dir, rel) });
      assert.strictEqual(viaTool.decision, 'deny');
      assert.match(viaTool.reason, /GF-CONF-1/);
      const viaShell = hook(ctx, role, 'Bash', { command: `echo '{}' > ${rel}` });
      assert.strictEqual(viaShell.decision, 'deny');
      assert.match(viaShell.reason, /GF-RUN-1/); // round 5: a group role has no shell
    });
  }
}
test('hook: the orchestrator (the main session) is not a group role and may write the config before pinning', () => {
  const ctx = sealed();
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: ctx.dir, tool_name: 'Write', tool_input: { file_path: path.join(ctx.dir, '.eccode/security.json') } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_ACTOR: '' } });
  assert.strictEqual(res.stdout, '');
});

// ------------------------------------------------------------------ CLI
test('eccode-gf config pin pins from the command line (exit 0); a group role is refused (exit 2)', () => {
  const ctx = sealed();
  const run1 = spawnSync(process.execPath, [CLI, 'config', 'pin', '--actor', 'orchestrator', '--scope', 'S1', '--reason', REASON, '--root', ctx.dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
  assert.strictEqual(run1.status, 0, run1.stderr);
  assert.match(run1.stdout, /Pinned 2 guard configuration file/);
  const run2 = spawnSync(process.execPath, [CLI, 'config', 'pin', '--actor', 'backend-engineer', '--scope', 'S1', '--reason', REASON, '--root', ctx.dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
  assert.strictEqual(run2.status, 2, run2.stderr);
});
void wrap;
