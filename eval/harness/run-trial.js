#!/usr/bin/env node
'use strict';
// Run ONE headless trial: a fresh Claude Code session (isolated config dir and
// HOME, only the condition's toolkit loaded) works on a task, then the hidden
// grader scores the result. Writes <out>/result.json, transcript.jsonl,
// stderr.log and final.diff.
//
//   node eval/harness/run-trial.js --task <id> --condition C0|C1|C2 --out <dir>
//        --toolkits <dir> --state <condition state dir>
//        [--phase attempt|feedback --feedback-file <f> --workdir <dir>]
//        [--budget-usd 5] [--timeout-min 40] [--model claude-sonnet-5-5]
//
// Conditions (same model, tools, budget, timeout and prompt wording):
//   C0  original ECC (affaan-m/ECC, pinned commit), its native workflows and learning
//   C1  ECCode with learning OFF (ECCODE_LEARNING=off)
//   C2  ECCode with verified learning ON (shared memory in the state dir)

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { listTasks, materialize, runVisible, runGrader, score } = require('./lib');

const UNATTENDED = [
  'This is an unattended evaluation run. No human will read or answer anything during this session.',
  'Complete the request end to end in the current working directory: change the code, add or update tests, and run them.',
  'Ordinary confirmations (plans, commits, gates that would normally ask the user) are pre-approved by the operator. Do not stop to ask questions.',
  'Do not push, deploy, open pull requests or contact external services. Stay inside the current working directory, plus the toolkit\'s own state directories.',
].join(' ');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

function promptFor(cond, task, phase, feedback) {
  if (phase === 'feedback') {
    const body = `QA re-tested your change to this service. These acceptance checks still fail:\n\n${feedback}\n\nFind the root cause and fix it, with a regression test. Afterwards, use your toolkit's learning features to retain what you learned, so future tasks in Acme services avoid this mistake.`;
    return cond === 'C0' ? `/ecc:orch-fix-defect ${body}` : `/eccode:investigate ${body}`;
  }
  const what = task.kind === 'bug' ? 'Fix the defect described in TASK.md in the current directory.' : 'Implement the change requested in TASK.md in the current directory.';
  if (cond === 'C0') return `${task.kind === 'bug' ? '/ecc:orch-fix-defect' : '/ecc:orch-add-feature'} ${what}`;
  return `/eccode:change ${what}`;
}

function conditionEnv(cond, toolkits, state) {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_SYNC_PLUGINS', 'CLAUDE_CODE_SYNC_SKILLS', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'CLAUDE_ADDITIONAL_DIRECTORIES', 'ECCODE_LEARNING', 'ECCODE_SHARED_MEMORY', 'ECCODE_ACTOR', 'ECCODE_ROOT']) delete env[k];
  fs.mkdirSync(path.join(state, 'home'), { recursive: true });
  fs.mkdirSync(path.join(state, 'claude-config'), { recursive: true });
  Object.assign(env, { HOME: path.join(state, 'home'), CLAUDE_CONFIG_DIR: path.join(state, 'claude-config'), IS_SANDBOX: '1' });
  let pluginDir;
  if (cond === 'C0') pluginDir = path.join(toolkits, 'ecc');
  else {
    pluginDir = path.join(toolkits, 'eccode');
    const binDir = path.join(state, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'eccode'), `#!/bin/sh\nexec node "${path.join(pluginDir, 'bin', 'eccode.js')}" "$@"\n`, { mode: 0o755 });
    env.PATH = `${binDir}:${env.PATH}`;
    env.ECCODE_SHARED_MEMORY = path.join(state, 'eccode-shared');
    env.ECCODE_LEARNING = cond === 'C1' ? 'off' : 'on';
  }
  return { env, pluginDir };
}

/** Summarise the stream-json transcript: final result, cost, turns, subagents, tool use. */
function summarize(transcriptFile) {
  const out = { result: null, costUsd: null, durationMs: null, numTurns: null, subtype: null, isError: null, toolUses: 0, agentDispatches: 0, models: {} };
  if (!fs.existsSync(transcriptFile)) return out;
  for (const line of fs.readFileSync(transcriptFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const c of j.message.content) {
        if (c.type === 'tool_use') {
          out.toolUses++;
          if (c.name === 'Agent' || c.name === 'Task') out.agentDispatches++;
        }
      }
    }
    if (j.type === 'result') {
      Object.assign(out, { result: j.result, costUsd: j.total_cost_usd, durationMs: j.duration_ms, numTurns: j.num_turns, subtype: j.subtype, isError: j.is_error, models: Object.keys(j.modelUsage || {}) });
    }
  }
  return out;
}

const QUESTION = /(would you like|do you want|should i\b|shall i\b|please confirm|let me know if|awaiting (your|user)|waiting for (your|user)|need(s)? your (approval|decision|input)|before i proceed)/i;

function intervention(sum, timedOut, work) {
  const reasons = [];
  if (timedOut) reasons.push('timeout');
  if (sum.subtype && sum.subtype !== 'success') reasons.push(`ended: ${sum.subtype}`);
  if (!sum.result && !timedOut) reasons.push('no final result');
  const text = String(sum.result || '');
  const tail = text.trim().split('\n').slice(-6).join('\n');
  if (QUESTION.test(tail) || /\?\s*$/.test(text.trim())) reasons.push('ended asking the user');
  const stateFile = path.join(work, '.eccode', 'state.json');
  if (fs.existsSync(stateFile)) {
    try {
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const esc = [...Object.values(st.gates || {}).filter((g) => g.status === 'escalated').map((g) => `gate ${g.id}`), ...Object.values(st.tasks || {}).filter((t) => t.status === 'escalated').map((t) => `task ${t.id}`)];
      if (esc.length) reasons.push(`escalated to user: ${esc.join(', ')}`);
    } catch {}
  }
  return { needed: reasons.length > 0, reasons };
}

async function main() {
  const taskId = arg('task');
  const cond = arg('condition');
  const outDir = path.resolve(arg('out'));
  const toolkits = path.resolve(arg('toolkits'));
  const state = path.resolve(arg('state'));
  const phase = arg('phase', 'attempt');
  const budget = arg('budget-usd', '5');
  const timeoutMin = Number(arg('timeout-min', '40'));
  const model = arg('model', 'claude-sonnet-5-5');
  if (!taskId || !['C0', 'C1', 'C2'].includes(cond) || !arg('out') || !arg('toolkits') || !arg('state')) {
    console.error('usage: run-trial.js --task <id> --condition C0|C1|C2 --out <dir> --toolkits <dir> --state <dir> [--phase attempt|feedback --feedback-file f --workdir d]');
    process.exit(2);
  }
  const task = listTasks().find((t) => t.id === taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  fs.mkdirSync(outDir, { recursive: true });
  const work = arg('workdir') ? path.resolve(arg('workdir')) : materialize(task);
  const feedback = phase === 'feedback' ? fs.readFileSync(arg('feedback-file'), 'utf8') : null;
  const { env, pluginDir } = conditionEnv(cond, toolkits, state);
  const prompt = promptFor(cond, task, phase, feedback);
  const cliArgs = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--max-budget-usd', String(budget), '--permission-mode', 'bypassPermissions', '--plugin-dir', pluginDir, '--append-system-prompt', UNATTENDED];
  const transcript = path.join(outDir, 'transcript.jsonl');
  const started = Date.now();
  const timedOut = await new Promise((resolve) => {
    const child = spawn('claude', cliArgs, { cwd: work, env, stdio: ['ignore', fs.openSync(transcript, 'w'), fs.openSync(path.join(outDir, 'stderr.log'), 'w')], detached: true });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMin * 60000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(killed);
    });
  });
  const wallMs = Date.now() - started;
  const sum = summarize(transcript);
  spawnSync('git', ['add', '-A'], { cwd: work });
  const diff = spawnSync('git', ['diff', '--cached', 'HEAD', '--', '.', ':(exclude).eccode'], { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  spawnSync('git', ['reset', '-q'], { cwd: work });
  fs.writeFileSync(path.join(outDir, `final.diff`), diff);
  const visible = runVisible(work);
  const grade = runGrader(task, work);
  const s = score(visible, grade);
  const result = {
    task: task.id,
    family: task.family,
    split: task.split,
    relation: task.relation || null,
    condition: cond,
    phase,
    model,
    budgetUsd: Number(budget),
    workdir: work,
    wallMs,
    timedOut,
    ...sum,
    resultText: String(sum.result || '').slice(-4000),
    grade: s,
    graderTail: grade.tail,
    visibleTail: visible.ok ? '' : visible.tail,
    intervention: intervention(sum, timedOut, work),
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ task: task.id, condition: cond, phase, success: s.success, ac: `${s.acPassed}/${s.acTotal}`, regressions: s.regressions, traps: s.failedTraps, costUsd: sum.costUsd, wallMin: Math.round(wallMs / 6000) / 10, intervention: result.intervention }));
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
