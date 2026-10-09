#!/usr/bin/env node
// Fake `claude` executable for tests (selected with GW_CLAUDE_BIN).
// Behaviour comes from GW_FAKE_CLAUDE_MODE; the provider only forwards it when listed in GW_CLI_ENV_PASS.
// GW_FAKE_CLAUDE_REPORT: file that receives { argv, cwd, cwdEntries, envKeys, stdin }.
// GW_FAKE_CLAUDE_STATE: counter file for the "bad-once" mode.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('2.1.295 (Claude Code)\n');
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => run());

function quoteDraft() {
  const m = /^<<<GW_DATA_BEGIN id=[0-9a-f]{16}>>>\n(.*)\n<<<GW_DATA_END/m.exec(stdin);
  let lines = [];
  try { lines = JSON.parse(m[1]).lines; } catch { /* leave empty */ }
  const l = lines[0] ?? { n: 1, time: '00:00', author: 'x', text: 'x' };
  return {
    summary: [{ text: `First note: ${l.time} ${l.author}: ${l.text}`.slice(0, 600), cites: [l.n] }],
    impact: [], timeline: [{ text: `${l.time} ${l.author}: ${l.text}`.slice(0, 600), cites: [l.n] }],
    contributingFactors: [], actionItems: [],
  };
}

function result(extra) {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 2, stop_reason: 'tool_use',
    total_cost_usd: 0.002, usage: { input_tokens: 120, output_tokens: 80 },
    modelUsage: { 'claude-haiku-5-5': {} }, permission_denials: [], ...extra,
  });
}

function run() {
  const mode = process.env.GW_FAKE_CLAUDE_MODE ?? 'good';
  const report = process.env.GW_FAKE_CLAUDE_REPORT;
  if (report) {
    writeFileSync(report, JSON.stringify({
      argv, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), envKeys: Object.keys(process.env), stdin,
    }));
  }
  const out = (s) => process.stdout.write(s);
  switch (mode) {
    case 'good': return out(result({ structured_output: quoteDraft(), result: '' }));
    case 'fenced': return out(result({ result: '```json\n' + JSON.stringify(quoteDraft()) + '\n```' }));
    case 'extra-field': return out(result({ structured_output: { ...quoteDraft(), status: 'verified' } }));
    case 'malformed': return out(result({ result: 'sorry, here is prose' }));
    case 'not-json': return out('this is not json');
    case 'is-error': return out(result({ is_error: true, subtype: 'success', result: 'Authentication error' }));
    case 'budget': return out(result({ is_error: true, subtype: 'error_max_budget_usd' }));
    case 'exit1': process.stderr.write('boom /secret/path'); process.exit(1); break;
    case 'hang': return setInterval(() => {}, 1000);
    case 'flood': { const big = 'x'.repeat(64 * 1024); for (let i = 0; i < 64; i++) out(big); return undefined; }
    case 'bad-once': {
      const f = process.env.GW_FAKE_CLAUDE_STATE;
      const seen = f && existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;
      if (f) writeFileSync(f, String(seen + 1));
      return out(seen === 0 ? result({ result: 'not json at all' }) : result({ structured_output: quoteDraft() }));
    }
    case 'slow': return setTimeout(() => out(result({ structured_output: quoteDraft() })), 400);
    default: process.exit(2);
  }
  return undefined;
}
