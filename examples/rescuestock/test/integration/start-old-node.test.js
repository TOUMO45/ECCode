// NFR1 (F-TR-4): on a Node older than 22.13 the start script exits non-zero and names the floor.
// Flags are parsed by Node before any script runs, so the flag-free gate must come first.
// The exact `start` (and `seed`) string from package.json runs through /bin/sh -c with an older
// Node first on PATH: /opt/node20/bin and /opt/node21/bin, or the entries of RS_OLD_NODE_BINS
// (directories or node binaries, separated by commas or the path delimiter). With no older Node
// the run is reported as skipped with its reason; the prefix assertion still runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsSqliteFlag } from '../helpers/node-proc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
const GATE = 'node scripts/check-node.cjs &&';
const DEFAULT_DIRS = ['/opt/node20/bin', '/opt/node21/bin'];

function candidateDirs(env = process.env) {
  const configured = (env.RS_OLD_NODE_BINS ?? '').split(new RegExp(`[,${delimiter}]`)).map((s) => s.trim()).filter(Boolean);
  const entries = configured.length > 0 ? configured : DEFAULT_DIRS;
  return entries.map((entry) => {
    if (!existsSync(entry)) return { entry, dir: null, why: 'does not exist' };
    return { entry, dir: statSync(entry).isDirectory() ? entry : dirname(entry) };
  });
}

// -> [{ dir, version }] for the older Nodes that can run here, and [reason] for the ones that cannot.
function olderNodes() {
  const usable = [];
  const notes = [];
  for (const c of candidateDirs()) {
    if (!c.dir) {
      notes.push(`${c.entry} ${c.why}`);
      continue;
    }
    if (c.dir !== c.entry && basename(c.entry) !== 'node') {
      notes.push(`${c.entry} is not a directory or a node binary`);
      continue;
    }
    const probe = spawnSync(join(c.dir, 'node'), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    if (probe.status !== 0) {
      notes.push(`${join(c.dir, 'node')} does not run`);
      continue;
    }
    const version = probe.stdout.trim().replace(/^v/, '');
    if (!needsSqliteFlag(version)) {
      notes.push(`${join(c.dir, 'node')} is ${version}, not older than 22.13`);
      continue;
    }
    usable.push({ dir: c.dir, version });
  }
  return { usable, notes };
}

test('NFR1: every flagged script begins with the flag-free Node gate', () => {
  for (const name of ['start', 'seed', 'test', 'test:browser', 'test:live-model', 'test:live-paypal']) {
    assert.equal(typeof scripts[name], 'string', `scripts.${name} exists`);
    assert.equal(scripts[name].startsWith(`${GATE} `), true, `scripts.${name} begins with "${GATE}"`);
  }
});

const { usable, notes } = olderNodes();

function runScript(name, dir) {
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` };
  // Flags in these variables would be parsed by the old Node before the gate runs.
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync('/bin/sh', ['-c', scripts[name]], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
}

if (usable.length === 0) {
  test('NFR1: npm start on an older Node exits non-zero naming the floor', { skip: `no older Node binary found (${notes.join('; ') || 'none configured'}); set RS_OLD_NODE_BINS` }, () => {});
} else {
  for (const { dir, version } of usable) {
    for (const name of ['start', 'seed']) {
      test(`NFR1: the ${name} script on Node ${version} exits non-zero naming the floor`, () => {
        const result = runScript(name, dir);
        assert.equal(result.error, undefined, String(result.error));
        assert.notEqual(result.status, 0, `exit code (stdout: ${result.stdout})`);
        assert.match(result.stderr, /needs Node >= 22\.13 \(found /);
        assert.match(result.stderr, new RegExp(`\\(found ${version.replace(/\./g, '\\.')}\\)`));
        assert.equal(result.stdout, '', 'the server did not start');
      });
    }
  }
}
