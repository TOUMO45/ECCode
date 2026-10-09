import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgv, buildEnv, ALLOWED_TOOLS } from '../../src/ai/cli.js';
import { buildUserMessage } from '../../src/ai/prompt.js';
import { SKIP, liveConfig, incident, fixtureNotes } from './support.js';

test('live: CLI init event exposes exactly [StructuredOutput], nothing else, no permission denials', { skip: SKIP, timeout: 150000 }, async () => {
  const cfg = liveConfig().cli;
  const ver = spawnSync(cfg.bin, ['--version'], { env: buildEnv([]), encoding: 'utf8' });
  console.log(`# claude --version: ${ver.stdout.trim()}`);
  assert.equal(ver.status, 0);
  // Same argv as the provider but stream-json so the system/init event is visible.
  const argv = buildArgv({ model: cfg.model, maxBudgetUsd: cfg.maxBudgetUsd });
  const i = argv.indexOf('json');
  assert.equal(argv[i - 1], '--output-format');
  argv.splice(i, 1, 'stream-json', '--verbose');
  const cwd = mkdtempSync(join(tmpdir(), 'gw-iso-'));
  try {
    const out = await new Promise((resolve, reject) => {
      const c = spawn(cfg.bin, argv, { cwd, env: buildEnv([]), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let s = '';
      c.stdout.on('data', (d) => { s += d; });
      c.on('error', reject);
      c.on('close', () => resolve(s));
      c.stdin.end(buildUserMessage({ incident, lines: fixtureNotes().slice(0, 8) }));
    });
    const events = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
    assert.ok(init, 'no system/init event');
    assert.deepEqual(init.tools, [...ALLOWED_TOOLS]);
    assert.deepEqual(init.mcp_servers, []);
    assert.deepEqual(init.skills ?? [], []);
    assert.deepEqual(init.slash_commands ?? [], []);
    const result = events.findLast((e) => e.type === 'result');
    assert.ok(result, 'no result event');
    assert.deepEqual(result.permission_denials, []);
    console.log(`# cost usd ${result.total_cost_usd}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
