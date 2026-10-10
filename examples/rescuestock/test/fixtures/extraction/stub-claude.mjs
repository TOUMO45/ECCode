#!/usr/bin/env node
// Stand-in for the `claude` binary in the CLI adapter tests. It never contacts a model.
// Invoked as: node stub-claude.mjs <mode> <the arguments the adapter passed to claude...>
// (the test writes a one-line `claude` shell wrapper into a temp bin directory that is put on PATH).
//
// It records what it was given in $TMPDIR/stub-report.json: { argv, cwd, cwdEntries, envKeys, stdin }.
// "transcript" replays test/fixtures/extraction/cli-transcript.ndjson, the recorded shape of a successful
// stream-json run (system init, assistant tool_use of StructuredOutput, result with structured_output).
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [mode, ...argv] = process.argv.slice(2);

if (argv[0] === '--version') {
  process.stdout.write('2.1.296 (Claude Code)\n');
  process.exit(0);
}

const transcript = () => readFileSync(join(HERE, 'cli-transcript.ndjson'), 'utf8');
const resultEvent = () => transcript().split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'result');
const out = (s) => process.stdout.write(s);
const line = (o) => out(`${JSON.stringify(o)}\n`);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', run);

function run() {
  if (process.env.TMPDIR) {
    appendFileSync(join(process.env.TMPDIR, 'spawns.log'), 'x\n');
    writeFileSync(join(process.env.TMPDIR, 'stub-report.json'), JSON.stringify({
      argv, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), envKeys: Object.keys(process.env), stdin,
    }));
  }
  const base = resultEvent();
  switch (mode) {
    case 'transcript':
      return out(transcript());
    case 'noise':
      out('this line is not JSON\n');
      out('{"type":"assistant","truncated\n');
      out(transcript());
      return out('{"type":"system","subtype":"trailer"}\n');
    case 'result-text': {
      const { structured_output: structured, ...rest } = base;
      return line({ ...rest, result: JSON.stringify(structured) });
    }
    case 'prose': {
      const { structured_output: _drop, ...rest } = base;
      return line({ ...rest, result: 'Sorry, I could not produce the JSON you asked for.' });
    }
    case 'schema-extra':
      return line({ ...base, structured_output: { ...base.structured_output, approvedSupplier: 'C' } });
    case 'is-error':
      return line({ ...base, is_error: true, structured_output: undefined, result: 'Authentication error: please run /login' });
    case 'budget':
      return line({ ...base, subtype: 'error_max_budget_usd', is_error: true, structured_output: undefined, total_cost_usd: 0.05 });
    case 'rephrase-ok': {
      const { structured_output: _drop, ...rest } = base;
      return line({ ...rest, structured_output: { text: 'A short rewording.' } });
    }
    case 'no-result':
      return out('{"type":"system","subtype":"init"}\n');
    case 'exit1':
      process.stderr.write('boom /secret/path\n');
      return process.exit(1);
    case 'hang': {
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(join(process.env.TMPDIR, 'grandchild.pid'), String(grandchild.pid));
      return setInterval(() => {}, 1000);
    }
    case 'flood': {
      const block = 'x'.repeat(256 * 1024);
      const write = () => {
        for (let i = 0; i < 64; i += 1) if (!process.stdout.write(block)) return process.stdout.once('drain', write);
        return undefined;
      };
      return write();
    }
    case 'slow':
      return setTimeout(() => out(transcript()), 400);
    default:
      return process.exit(2);
  }
}
