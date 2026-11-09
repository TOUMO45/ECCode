'use strict';
// S3.1 I4 (L-GF-89: refusals were never logged). Every Greenfield-Senior rule refusal raised through the engine's
// managed entry points writes exactly one entry to the append-only, hash-chained .eccode/rejections.jsonl, with who,
// what, which rule, why and when; a success writes none; secrets never reach the log; verify() detects tampering.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { gfProject } = require('./fixtures/gf/flow');
const wrap = require('../lib/greenfield/wrap');
const mcp = require('../lib/mcp');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts/hooks/guard.js');
const rejections = () => require('../lib/greenfield/rejections');
const logFile = (ctx) => path.join(ctx.dir, '.eccode', 'rejections.jsonl');
const entries = (ctx) => (fs.existsSync(logFile(ctx)) ? fs.readFileSync(logFile(ctx), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function refusal(fn) { try { fn(); } catch (e) { return e; } throw new Error('expected a refusal, but the call succeeded'); }
const call = (name, args, ctx, actor) => mcp.tools().find((t) => t.name === name).handler(args, { store: ctx.store, config: ctx.config, actor });

test('I4: a GF refusal through wrap writes exactly one entry (who, action, rule, why, when) and rethrows the same error', () => {
  const ctx = gfProject();
  let thrown = null;
  const err = refusal(() => { try { wrap.gateStart(ctx.store, ctx.config, 'phase:core', 'orchestrator'); } catch (e) { thrown = e; throw e; } });
  assert.strictEqual(err, thrown);
  assert.strictEqual(err.code, 'GF_RULE');
  const log = entries(ctx);
  assert.strictEqual(log.length, 1, JSON.stringify(log));
  const [e] = log;
  assert.strictEqual(e.seq, 1);
  assert.strictEqual(e.actor, 'orchestrator');
  assert.strictEqual(e.action, 'gate.start');
  assert.strictEqual(e.rule, 'GF-SEAL-1');
  assert.ok(/phase:core cannot start/.test(e.reason), e.reason);
  assert.ok(!Number.isNaN(Date.parse(e.ts)), e.ts);
  assert.match(e.hash, /^[0-9a-f]{64}$/);
  assert.strictEqual(e.prevHash, '0'.repeat(64));
  assert.deepStrictEqual(rejections().verify(ctx.dir), { ok: true, errors: [], count: 1 });
});

test('I4: a refusal through the MCP tool (gate_start) and through the task claim is logged once each; a success writes nothing', () => {
  const ctx = gfProject();
  call('gate_start', { gate: 'architecture' }, ctx, 'orchestrator');
  assert.strictEqual(entries(ctx).length, 0, 'a success writes no entry');
  refusal(() => call('gate_start', { gate: 'phase:core' }, ctx, 'orchestrator'));
  assert.strictEqual(entries(ctx).length, 1);
  refusal(() => wrap.taskClaim(ctx.store, ctx.config, 'T-1', 'backend-engineer', {}));
  const log = entries(ctx);
  assert.strictEqual(log.length, 2, JSON.stringify(log));
  assert.deepStrictEqual(log.map((e) => [e.seq, e.action, e.rule, e.actor]), [[1, 'gate.start', 'GF-SEAL-1', 'orchestrator'], [2, 'task.claim', 'GF-SEAL-1', 'backend-engineer']]);
  assert.strictEqual(log[1].prevHash, log[0].hash);
});

test('I4: neither the ECCODE_SEED_KEY value nor a password field value reaches the log', () => {
  const SEED = 'test-seed-value-not-real';
  const PW = 'pw-field-value-7731';
  const before = process.env.ECCODE_SEED_KEY;
  process.env.ECCODE_SEED_KEY = SEED;
  try {
    const ctx = gfProject();
    // The gate id (echoed in the refusal reason) carries the seed value; the options carry a password field.
    refusal(() => wrap.gateStart(ctx.store, ctx.config, `phase:${SEED}`, 'orchestrator', { password: PW, nested: { apiToken: PW, note: `x ${SEED} y` } }));
    const text = fs.readFileSync(logFile(ctx), 'utf8');
    assert.strictEqual(entries(ctx).length, 1);
    assert.ok(!text.includes(SEED), 'the seed value must not appear in the log');
    assert.ok(!text.includes(PW), 'a password/token field value must not appear in the log');
    assert.ok(/redacted/.test(text), text);
    assert.ok(rejections().verify(ctx.dir).ok);
  } finally {
    if (before === undefined) delete process.env.ECCODE_SEED_KEY; else process.env.ECCODE_SEED_KEY = before;
  }
});

test('I4: verify() detects a rewritten, a removed, a reordered and a truncated entry', () => {
  const ctx = gfProject();
  for (const g of ['phase:a', 'phase:b', 'phase:c']) refusal(() => wrap.gateStart(ctx.store, ctx.config, g, 'orchestrator'));
  const file = logFile(ctx);
  const pristine = fs.readFileSync(file, 'utf8');
  assert.strictEqual(rejections().verify(ctx.dir).ok, true);
  const lines = pristine.split('\n').filter(Boolean);
  const cases = {
    rewritten: () => { const e = JSON.parse(lines[1]); e.reason = 'nothing happened'; return [lines[0], JSON.stringify(e), lines[2]]; },
    removed: () => [lines[0], lines[2]],
    reordered: () => [lines[0], lines[2], lines[1]],
    truncated: () => [lines[0], lines[1]],
  };
  for (const [name, mk] of Object.entries(cases)) {
    fs.writeFileSync(file, `${mk().join('\n')}\n`);
    const r = rejections().verify(ctx.dir);
    assert.strictEqual(r.ok, false, `${name} must be detected`);
    assert.ok(r.errors.length > 0, name);
  }
  fs.writeFileSync(file, pristine);
  assert.strictEqual(rejections().verify(ctx.dir).ok, true);
});

test('I4: the guard protects .eccode/rejections.jsonl like the other record files (Write, Edit, shell redirection)', () => {
  const ctx = gfProject();
  const hook = (input) => {
    const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: ctx.dir, ...input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_HOOKS: '' } });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  for (const input of [
    { tool_name: 'Write', tool_input: { file_path: path.join(ctx.dir, '.eccode/rejections.jsonl'), content: '' } },
    { tool_name: 'Edit', tool_input: { file_path: '.eccode/rejections.jsonl', old_string: 'a', new_string: 'b' } },
    { tool_name: 'Write', tool_input: { file_path: '.eccode/rejections.head', content: '{}' } },
    { tool_name: 'Bash', tool_input: { command: 'echo {} >> .eccode/rejections.jsonl' } },
    { tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' .eccode/rejections.jsonl" } },
  ]) {
    const out = hook(input);
    assert.ok(out && out.permissionDecision === 'deny', `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
  const read = hook({ tool_name: 'Bash', tool_input: { command: 'cat .eccode/rejections.jsonl' } });
  assert.ok(!read || read.permissionDecision !== 'deny', `reading the log stays allowed: ${JSON.stringify(read)}`);
});
