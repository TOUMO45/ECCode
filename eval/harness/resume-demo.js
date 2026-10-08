#!/usr/bin/env node
'use strict';
// R5 demonstration: interrupt a real ECCode delivery mid-flight, then continue
// it in a brand-new session (new process, new Claude config dir, no
// conversation history) from the persistent record alone.
//
//   node eval/harness/resume-demo.js --task <id> --toolkits <dir> --out <dir>
//        [--kill-when claimed|phase-started] [--budget-usd 6] [--timeout-min 40]
//
// Session 1 runs /eccode:change. A watcher polls <work>/.eccode/state.json and
// SIGKILLs the whole process group at the chosen point (default: first task
// claimed, i.e. work in flight). Session 2 starts fresh and is only told to run
// /eccode:resume. Evidence written to <out>: events-before.json (record at the
// kill), session2 transcript, reconcile report, final grading.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { listTasks, materialize, parseTap, score } = require('./lib');
const { SBX, trialEnv, prepareState, dropToken, spawnInSandbox, runInSandboxSync } = require('./sandbox-env');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const UNATTENDED = 'This is an unattended evaluation run. No human will read or answer anything during this session. Complete the work end to end. Ordinary confirmations are pre-approved. Do not push, deploy or open pull requests.';

const task = listTasks().find((t) => t.id === arg('task'));
const toolkits = path.resolve(arg('toolkits'));
const out = path.resolve(arg('out'));
const killWhen = arg('kill-when', 'claimed');
const budget = arg('budget-usd', '6');
const timeoutMin = Number(arg('timeout-min', '40'));
if (!task) throw new Error('unknown --task');

const toolkit = path.join(toolkits, 'eccode');
const work = path.join(out, 'work');
if (fs.existsSync(work)) throw new Error(`${work} exists`);
materialize(task, { into: work });
fs.mkdirSync(out, { recursive: true });

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(work, '.eccode', 'state.json'), 'utf8'));
  } catch {
    return null;
  }
};
const reached = (st) => {
  if (!st) return false;
  if (killWhen === 'phase-started') return Object.values(st.gates).some((g) => g.id.startsWith('phase:') && g.status !== 'pending');
  return Object.values(st.tasks || {}).some((t) => t.status === 'claimed');
};

function session(label, prompt, stateName, { watch }) {
  const state = path.join(out, stateName);
  prepareState('C1', state);
  const env = trialEnv('C1');
  const transcript = path.join(out, `${label}.jsonl`);
  return new Promise((resolve) => {
    const child = spawnInSandbox({ work, state, toolkit, env, cmd: 'claude', args: ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5-5', '--max-budget-usd', budget, '--permission-mode', 'bypassPermissions', '--plugin-dir', `${SBX}/toolkit`, '--append-system-prompt', UNATTENDED], stdout: fs.openSync(transcript, 'w'), stderr: fs.openSync(path.join(out, `${label}.err`), 'w') });
    let killed = false;
    let timer;
    const stop = () => {
      killed = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    if (watch) {
      timer = setInterval(() => {
        if (reached(readState())) {
          clearInterval(timer);
          // Let the in-flight agent write something to disk first, so there is partial work to reconcile.
          setTimeout(stop, 20000);
        }
      }, 1000);
    }
    const hard = setTimeout(stop, timeoutMin * 60000);
    child.on('exit', () => {
      clearTimeout(hard);
      if (timer) clearInterval(timer);
      dropToken(state);
      resolve({ killed });
    });
  });
}

function result(transcript) {
  let r = null;
  let init = null;
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
    try {
      const j = JSON.parse(l);
      if (j.type === 'result') r = j;
      if (j.type === 'system' && j.subtype === 'init') init = j;
    } catch {}
  }
  return { result: r, init };
}

(async () => {
  const s1 = await session('session1', '/eccode:change Implement the change requested in TASK.md in the current directory.', 'state1', { watch: true });
  const stAtKill = readState();
  const gitStatus = spawnSync('git', ['status', '--short'], { cwd: work, encoding: 'utf8' }).stdout;
  fs.writeFileSync(path.join(out, 'record-at-kill.json'), JSON.stringify({ killedBySignal: s1.killed, seq: stAtKill && stAtKill.seq, gates: stAtKill && Object.fromEntries(Object.values(stAtKill.gates).map((g) => [g.id, g.status])), tasks: stAtKill && Object.fromEntries(Object.values(stAtKill.tasks || {}).map((t) => [t.id, t.status])), openRuns: stAtKill && Object.values(stAtKill.runs).filter((r) => r.status === 'running').map((r) => r.id), delivered: Boolean(stAtKill && stAtKill.delivery), workingTree: gitStatus }, null, 2));
  const s1res = result(path.join(out, 'session1.jsonl'));
  const sessionId1 = s1res.init && s1res.init.session_id;
  if (stAtKill && stAtKill.delivery) {
    console.log(JSON.stringify({ note: 'session 1 finished before it could be interrupted', outcome: 'no-interruption' }));
  }
  // Fresh session: new process, new config dir (no conversation history), same project directory.
  const s2 = await session('session2', '/eccode:resume', 'state2', { watch: false });
  const s2res = result(path.join(out, 'session2.jsonl'));
  const st2 = readState();
  const vis = runInSandboxSync({ work, state: path.join(out, 'state2'), toolkit, env: { PATH: process.env.PATH, HOME: `${SBX}/state/home`, NODE_ENV: 'test' }, cmd: process.execPath, args: ['--test'] });
  const graderDir = path.join(task.dir, 'grader');
  const gr = runInSandboxSync({ work, state: path.join(out, 'state2'), toolkit, extra: graderDir, env: { PATH: process.env.PATH, HOME: `${SBX}/state/home`, NODE_ENV: 'test', TASK_ROOT: `${SBX}/work` }, cmd: process.execPath, args: ['--test', '--test-concurrency=1', ...fs.readdirSync(graderDir).filter((f) => f.endsWith('.test.js')).map((f) => `${SBX}/extra/${f}`)] });
  const checks = parseTap(`${gr.stdout}${gr.stderr}`);
  const sc = score({ ok: vis.status === 0 }, { checks });
  const audit = spawnSync(process.execPath, [path.join(toolkit, 'bin', 'eccode.js'), 'audit', '--root', work], { encoding: 'utf8' });
  const events = fs.readFileSync(path.join(work, '.eccode', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const summary = {
    task: task.id,
    session1: { sessionId: sessionId1, killedBySignal: s1.killed, costUsd: s1res.result && s1res.result.total_cost_usd, recordSeqAtKill: stAtKill && stAtKill.seq },
    session2: { sessionId: s2res.init && s2res.init.session_id, differentSession: Boolean(sessionId1 && s2res.init && s2res.init.session_id !== sessionId1), costUsd: s2res.result && s2res.result.total_cost_usd, result: s2res.result && String(s2res.result.result).slice(-1500) },
    reconciledInSession2: events.some((e) => e.type === 'project.reconciled' && e.seq > (stAtKill ? stAtKill.seq : 0)),
    recoveredInterruptedRuns: events.filter((e) => e.type === 'run.ended' && e.data && e.data.note === 'recovered after interruption').length,
    finalGates: st2 && Object.fromEntries(Object.values(st2.gates).map((g) => [g.id, g.status])),
    delivered: Boolean(st2 && st2.delivery),
    auditOk: audit.status === 0,
    audit: audit.stdout.trim(),
    grade: { success: sc.success, ac: `${sc.acPassed}/${sc.acTotal}`, regressions: sc.regressions },
  };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})();
