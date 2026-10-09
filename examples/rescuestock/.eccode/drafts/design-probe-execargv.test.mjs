// Design probe (technical-designer): does `node --test` forward the parent's
// execArgv and NODE_OPTIONS to the per-file test process, and does a child
// spawned with process.execPath inherit them?
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('probe', () => {
  const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS || null}))'], { encoding: 'utf8' });
  console.log('TESTFILE', JSON.stringify({ execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS || null }));
  console.log('GRANDCHILD', child.stdout.trim());
});
