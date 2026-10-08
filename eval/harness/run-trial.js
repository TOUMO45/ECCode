#!/usr/bin/env node
'use strict';
// Run ONE sandboxed headless trial: a fresh Claude Code session works on a
// task with only the condition's toolkit loaded, then the hidden grader scores
// the working copy. Trial sessions run in their own mount and PID namespace
// (see sandbox.sh): they cannot see the evaluation suite, graders, other
// trials, the operator's session data or credentials.
//
//   node eval/harness/run-trial.js --task <id> --condition C0|C1|C2 --trial <dir>
//        --toolkits <dir> --state <condition state dir>
//        [--phase attempt|feedback --feedback-file <f>]   (feedback reuses <trial>/work)
//        [--budget-usd 5] [--timeout-min 40] [--model claude-sonnet-5-5] [--rep n]
//
// Writes <trial>/<phase>/{result.json,transcript.jsonl,stderr.log,final.diff}.
//
// Conditions (same model, tools, budget, timeout and prompt wording):
//   C0  original ECC (affaan-m/ECC at the pinned commit): native workflows and learning
//   C1  ECCode with learning OFF (ECCODE_LEARNING=off)
//   C2  ECCode with verified learning ON (shared memory lives in the state dir)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { listTasks, materialize, parseTap, score } = require('./lib');
const { SBX, trialEnv, prepareState, dropToken, spawnInSandbox, runInSandboxSync } = require('./sandbox-env');

const UNATTENDED = [
  'This is an unattended evaluation run. No human will read or answer anything during this session.',
  'Complete the request end to end in the current working directory: change the code, add or update tests, and run them.',
  'Ordinary confirmations (plans, commits, gates that would normally ask the user) are pre-approved by the operator. Do not stop to ask questions.',
  'Do not push, deploy, open pull requests or contact external services.',
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

/** Summarise the stream-json transcript: final result, cost, turns, subagents, tool use. */
function summarize(transcriptFile) {
  const out = { result: null, costUsd: null, durationMs: null, numTurns: null, subtype: null, isError: null, toolUses: 0, agentDispatches: 0, models: [], sessionId: null };
  if (!fs.existsSync(transcriptFile)) return out;
  for (const line of fs.readFileSync(transcriptFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'system' && j.subtype === 'init') out.sessionId = j.session_id;
    if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const c of j.message.content) {
        if (c.type !== 'tool_use') continue;
        out.toolUses++;
        if (c.name === 'Agent' || c.name === 'Task') out.agentDispatches++;
      }
    }
    if (j.type === 'result') Object.assign(out, { result: j.result, costUsd: j.total_cost_usd, durationMs: j.duration_ms, numTurns: j.num_turns, subtype: j.subtype, isError: j.is_error, models: Object.keys(j.modelUsage || {}) });
  }
  return out;
}

const QUESTION = /(would you like|do you want|should i\b|shall i\b|please confirm|let me know if|awaiting (your|user)|waiting for (your|user)|need(s)? your (approval|decision|input)|before i proceed)/i;

function intervention(sum, timedOut, work) {
  const reasons = [];
  if (timedOut) reasons.push('timeout');
  if (sum.subtype && sum.subtype !== 'success') reasons.push(`ended: ${sum.subtype}`);
  if (!sum.result && !timedOut) reasons.push('no final result');
  const text = String(sum.result || '').trim();
  if (QUESTION.test(text.split('\n').slice(-6).join('\n')) || /\?\s*$/.test(text)) reasons.push('ended asking the user');
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

/** Visible tests and hidden grader, both inside the sandbox, after the session has ended. */
function grade(task, work, state, toolkit) {
  const env = { PATH: process.env.PATH, HOME: `${SBX}/state/home`, NODE_ENV: 'test', TASK_ROOT: `${SBX}/work` };
  const vis = runInSandboxSync({ work, state, toolkit, env, cmd: process.execPath, args: ['--test'] });
  const visOut = `${vis.stdout || ''}${vis.stderr || ''}`;
  const visible = { ok: vis.status === 0, exitCode: vis.status, tail: visOut.split('\n').slice(-30).join('\n') };
  const graderDir = path.join(task.dir, 'grader');
  const files = fs.readdirSync(graderDir).filter((f) => f.endsWith('.test.js')).map((f) => `${SBX}/extra/${f}`);
  const g = runInSandboxSync({ work, state, toolkit, extra: graderDir, env, cmd: process.execPath, args: ['--test', '--test-concurrency=1', ...files] });
  const gOut = `${g.stdout || ''}${g.stderr || ''}`;
  const graded = { checks: parseTap(gOut), raw: gOut, tail: gOut.split('\n').filter((l) => /^(not ok|# |\s+(error|expected|actual):)/.test(l)).slice(0, 80).join('\n') };
  return { visible, graded, score: score(visible, graded) };
}

async function main() {
  const taskId = arg('task');
  const cond = arg('condition');
  const trialDir = arg('trial') && path.resolve(arg('trial'));
  const toolkits = arg('toolkits') && path.resolve(arg('toolkits'));
  const state = arg('state') && path.resolve(arg('state'));
  const phase = arg('phase', 'attempt');
  const budget = arg('budget-usd', '5');
  const timeoutMin = Number(arg('timeout-min', '40'));
  const model = arg('model', 'claude-sonnet-5-5');
  if (!taskId || !['C0', 'C1', 'C2'].includes(cond) || !trialDir || !toolkits || !state) {
    console.error('usage: run-trial.js --task <id> --condition C0|C1|C2 --trial <dir> --toolkits <dir> --state <dir> [--phase attempt|feedback --feedback-file f]');
    process.exit(2);
  }
  const task = listTasks().find((t) => t.id === taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  const work = path.join(trialDir, 'work');
  if (phase === 'attempt') {
    if (fs.existsSync(work)) throw new Error(`${work} exists; trials never reuse a working copy for a new attempt`);
    materialize(task, { into: work });
  } else if (!fs.existsSync(work)) throw new Error(`feedback phase needs the attempt's working copy at ${work}`);
  const outDir = path.join(trialDir, phase);
  fs.mkdirSync(outDir, { recursive: true });
  const base = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout.trim().split('\n')[0];
  const toolkit = path.join(toolkits, cond === 'C0' ? 'ecc' : 'eccode');
  const feedback = phase === 'feedback' ? fs.readFileSync(arg('feedback-file'), 'utf8') : null;
  prepareState(cond, state);
  const env = trialEnv(cond);
  const args = ['-p', promptFor(cond, task, phase, feedback), '--output-format', 'stream-json', '--verbose', '--model', model, '--max-budget-usd', String(budget), '--permission-mode', 'bypassPermissions', '--plugin-dir', `${SBX}/toolkit`, '--append-system-prompt', UNATTENDED];
  const transcript = path.join(outDir, 'transcript.jsonl');
  const started = Date.now();
  let timedOut = false;
  try {
    timedOut = await new Promise((resolve) => {
      const child = spawnInSandbox({ work, state, toolkit, env, cmd: 'claude', args, stdout: fs.openSync(transcript, 'w'), stderr: fs.openSync(path.join(outDir, 'stderr.log'), 'w') });
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
  } finally {
    if (arg('drop-token') === '1') dropToken(state);
  }
  const wallMs = Date.now() - started;
  const sum = summarize(transcript);
  spawnSync('git', ['add', '-A'], { cwd: work });
  const diff = spawnSync('git', ['diff', '--cached', base, '--', '.', ':(exclude).eccode'], { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  spawnSync('git', ['reset', '-q'], { cwd: work });
  fs.writeFileSync(path.join(outDir, 'final.diff'), diff);
  const g = grade(task, work, state, toolkit);
  const result = {
    task: task.id,
    family: task.family,
    split: task.split,
    relation: task.relation || null,
    condition: cond,
    rep: Number(arg('rep', '1')),
    phase,
    model,
    budgetUsd: Number(budget),
    trialDir,
    wallMs,
    timedOut,
    ...sum,
    resultText: String(sum.result || '').slice(-4000),
    grade: g.score,
    graderTail: g.graded.tail,
    visibleTail: g.visible.ok ? '' : g.visible.tail,
    diffLines: diff.split('\n').length,
    intervention: intervention(sum, timedOut, work),
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'grader.tap'), g.graded.raw);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ task: task.id, condition: cond, phase, success: g.score.success, ac: `${g.score.acPassed}/${g.score.acTotal}`, regressions: g.score.regressions, traps: g.score.failedTraps, costUsd: sum.costUsd, wallMin: Math.round(wallMs / 6000) / 10, intervention: result.intervention }));
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
