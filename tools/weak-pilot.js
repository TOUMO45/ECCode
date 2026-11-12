#!/usr/bin/env node
'use strict';
// Weak-model pilot W1 runner (docs/build/weak-model-pilot.md). One run per call; the protocol fixes everything else.
//   node tools/weak-pilot.js run --arm w|e|s --project <name> --brief <brief.md> [--starter <dir>] --oracle <script>
//                                --out <dir> --run <n>
// Writes <out>/<project>-<arm>-<n>/{workspace/, transcript.jsonl, result.json}. The oracle is run after the arm ends.
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const MODELS = { w: 'claude-haiku-5-5', e: 'claude-haiku-5-5', s: 'claude-sonnet-5-5' };
const P = 'Deliver the project described in brief.md in this directory. I am unreachable, so do not ask me anything: decide and finish.';
const TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'Read', 'Glob', 'Grep', 'Task', 'Agent', 'Skill', 'TodoWrite'];
const WALL_MS = 40 * 60 * 1000;

function flags(argv) {
  const f = {};
  for (let i = 1; i < argv.length; i += 2) f[argv[i].replace(/^--/, '')] = argv[i + 1];
  return f;
}

function pluginExport(repo, dest) {
  if (fs.existsSync(path.join(dest, 'bin', 'eccode.js'))) return dest;
  fs.mkdirSync(dest, { recursive: true });
  const tar = execFileSync('git', ['-C', repo, 'archive', 'HEAD'], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dest, '--exclude=docs', '--exclude=.eccode', '--exclude=.supervisor'], { input: tar });
  return dest;
}

function entryPrompt(repo) {
  // ECCode's own entry command, body only, with the idea in place of $ARGUMENTS
  const body = fs.readFileSync(path.join(repo, 'commands', 'start.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  return body.replace('$ARGUMENTS', P);
}

function run(f) {
  const repo = path.join(__dirname, '..');
  const arm = f.arm;
  if (!MODELS[arm]) throw new Error('--arm w|e|s');
  const dir = path.resolve(f.out, `${f.project}-${arm}-${f.run}`);
  if (fs.existsSync(dir)) throw new Error(`${dir} exists: a run is done once`);
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  if (f.starter) execFileSync('cp', ['-r', `${path.resolve(f.starter)}/.`, ws]);
  fs.copyFileSync(path.resolve(f.brief), path.join(ws, 'brief.md'));
  const args = ['-p', '--model', MODELS[arm], '--setting-sources', '', '--strict-mcp-config', '--allowedTools', ...TOOLS,
    '--max-turns', '200', '--output-format', 'stream-json', '--verbose'];
  let prompt = P;
  if (arm === 'e') {
    args.push('--plugin-dir', pluginExport(repo, path.resolve(f.out, 'eccode-plugin')));
    prompt = entryPrompt(repo);
  }
  const started = Date.now();
  const r = spawnSync('claude', args, { cwd: ws, input: prompt, encoding: 'utf8', timeout: WALL_MS, maxBuffer: 1 << 30 });
  const wall = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), r.stdout || '');
  let last = null;
  let usedEccode = false;
  let toolCalls = 0;
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'result') last = o;
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      if (b.type !== 'tool_use') continue;
      toolCalls += 1;
      const input = JSON.stringify(b.input || {});
      if ((b.name === 'Bash' && /eccode(\.js|-gf)?\b/.test(input)) || (b.name === 'Skill' && /eccode|orchestrate/.test(input))) usedEccode = true;
    }
  }
  const contaminated = /hidden_acceptance|Supervisor-Skill|tests\/e2e/.test(r.stdout || '');
  const oracle = spawnSync('python3', ['-I', path.resolve(f.oracle), ws], { encoding: 'utf8', timeout: 300000 });
  const m = /SCORE (\d+)\/(\d+)/.exec(oracle.stdout || '');
  const result = {
    project: f.project, arm, run: Number(f.run), model: MODELS[arm], prompt,
    exit: r.status, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), wallSeconds: wall,
    turns: last ? last.num_turns : null, costUsd: last ? last.total_cost_usd : null, stopReason: last ? last.subtype : null,
    toolCalls, usedEccode: arm === 'e' ? usedEccode : null, contaminated,
    oracle: m ? { passed: Number(m[1]), total: Number(m[2]) } : null,
    oracleTail: (oracle.stdout || oracle.stderr || '').trim().split('\n').slice(-3),
    finalMessage: last && typeof last.result === 'string' ? last.result.slice(0, 1500) : null,
  };
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const cost = result.costUsd === null ? 'n/a' : result.costUsd.toFixed(2);
  process.stdout.write(`${f.project} ${arm}${f.run}: Q ${m ? `${m[1]}/${m[2]}` : 'n/a'}  cost ${cost}  ${result.turns} turns  ${wall}s  eccode:${result.usedEccode}  contaminated:${contaminated}\n`);
}

if (process.argv[2] === 'run') run(flags(process.argv.slice(2)));
else { process.stderr.write('usage: weak-pilot.js run --arm w|e|s --project <name> --brief <file> [--starter <dir>] --oracle <script> --out <dir> --run <n>\n'); process.exitCode = 1; }
