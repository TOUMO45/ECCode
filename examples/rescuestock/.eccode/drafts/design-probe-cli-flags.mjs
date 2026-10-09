// Design probe (technical-designer): flag constraints of `claude -p` that the
// extraction adapter depends on. Empty stdin, so no model call is made.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = mkdtempSync(join(tmpdir(), 'rs-probe-'));
const run = (args) => spawnSync('claude', args, { cwd, input: '', encoding: 'utf8', timeout: 30000 });

const v = run(['--version']);
console.log('version:', v.stdout.trim());
const a = run(['-p', '--input-format', 'stream-json', '--output-format', 'json', '--tools', '', '--no-session-persistence']);
console.log('stream-json in + json out: exit', a.status, '|', (a.stderr + a.stdout).trim().slice(0, 200));
const b = run(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--tools', '', '--no-session-persistence']);
console.log('stream-json in + stream-json out without --verbose: exit', b.status, '|', (b.stderr + b.stdout).trim().slice(0, 200));
const okA = a.status !== 0 && /requires output-format=stream-json/.test(a.stderr + a.stdout);
const okB = b.status !== 0 && /requires --verbose/.test(b.stderr + b.stdout);
console.log('constraints confirmed:', okA && okB);
process.exit(okA && okB ? 0 : 1);
