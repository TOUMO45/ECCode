#!/usr/bin/env node
'use strict';
// Demonstration delivery (R1, R2, R4, R5): the ECCode team builds the app
// described in docs/build/demo-scope.md, starting from a written idea.
//
//   node eval/demo/run-demo.js --toolkits <dir> --out <dir> --scope <scope.md>
//        [--max-total-usd 150] [--session-usd 60] [--max-minutes 900]
//        [--max-sessions 12] [--kill-after-claims 2]
//        [--continue <n>]   keep working in an existing <out>: no new workspace, no install, resume sessions numbered from n.
//                           An optional <out>/operator-note.md is appended to the unattended-run note of every session.
//
// 1. A fresh sandbox state: the plugin is installed from the toolkit export with
//    the documented marketplace method (`claude plugin marketplace add`, `claude
//    plugin install eccode@eccode`), inside the sandbox so recorded paths are valid.
// 2. Session 1 runs `/eccode:start <idea>`. When the implementation is in flight
//    (default: --kill-after-claims claimed tasks seen, then 30 s), the whole
//    process group is SIGKILLed: a real interruption.
// 3. Every following session is a brand-new process with a new Claude config
//    session history (same installed plugin, no conversation) and only the prompt
//    `/eccode:resume`. Sessions repeat until the project is delivered, the budget
//    or time cap is hit, or --max-sessions is reached.
// The record at each boundary is saved so the interruption and recovery are auditable.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SBX, trialEnv, prepareState, dropToken, spawnInSandbox, runInSandboxSync } = require('../harness/sandbox-env');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const toolkits = path.resolve(arg('toolkits'));
const out = path.resolve(arg('out'));
const scopeFile = path.resolve(arg('scope'));
const maxTotal = Number(arg('max-total-usd', '150'));
const sessionUsd = Number(arg('session-usd', '60'));
const maxMinutes = Number(arg('max-minutes', '900'));
const maxSessions = Number(arg('max-sessions', '12'));
const killAfterClaims = Number(arg('kill-after-claims', '2'));
const continueFrom = arg('continue') ? Number(arg('continue')) : null;
const toolkit = path.join(toolkits, 'eccode');
const work = path.join(out, 'work');
const state = path.join(out, 'state');
const log = [];

fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.join(out, 'sessions'), { recursive: true });
const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { cwd: work, encoding: 'utf8', ...o });
if (!continueFrom) {
  sh('git', ['init', '-q']);
  fs.copyFileSync(scopeFile, path.join(work, 'SCOPE.md'));
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n*.db\n*.db-*\n.eccode/.lock\n');
  sh('git', ['add', '-A']);
  sh('git', ['-c', 'user.email=dev@acme.test', '-c', 'user.name=acme-dev', 'commit', '-q', '-m', 'scope agreed before building']);

  // The documented configuration step: limits are set in .eccode/config.json before `init`.
  fs.mkdirSync(path.join(work, '.eccode'), { recursive: true });
  const { DEFAULT_CONFIG } = require(path.join(toolkit, 'lib', 'config'));
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(cfg.limits, { maxCostUsd: maxTotal, maxRuntimeMinutes: maxMinutes, maxConcurrency: 3, maxReviewIterations: 3, maxTaskRetries: 2 });
  fs.writeFileSync(path.join(work, '.eccode', 'config.json'), JSON.stringify(cfg, null, 2));
}

prepareState('C2', state);
const env = trialEnv('C2');
env.ECCODE_LEARNING = 'on';
env.NODE_PATH = '/opt/node22/lib/node_modules';
env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

// ---- Installation, as documented (method A), inside the sandbox ------------------------------------------
function install() {
  const results = [];
  for (const args of [['plugin', 'marketplace', 'add', `${SBX}/toolkit`], ['plugin', 'install', 'eccode@eccode']]) {
    const r = runInSandboxSync({ work, state, toolkit, env, cmd: 'claude', args, timeoutMs: 240000 });
    results.push({ command: `claude ${args.join(' ')}`, exit: r.status, output: `${r.stdout}${r.stderr}`.trim().slice(-300) });
    if (r.status !== 0) break;
  }
  fs.writeFileSync(path.join(out, 'install.json'), JSON.stringify(results, null, 2));
  return results.every((r) => r.exit === 0);
}

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(work, '.eccode', 'state.json'), 'utf8'));
  } catch {
    return null;
  }
};

function snapshot(label) {
  const st = readState();
  const rec = { label, at: new Date().toISOString(), seq: st && st.seq, gates: st && Object.fromEntries(Object.values(st.gates).map((g) => [g.id, g.status])), tasks: st && Object.fromEntries(Object.values(st.tasks || {}).map((t) => [t.id, t.status])), openRuns: st && Object.values(st.runs).filter((r) => r.status === 'running').length, totals: st && st.totals, delivered: Boolean(st && st.delivery), files: Number(sh('git', ['ls-files', '-o', '-m', '--exclude-standard']).stdout.split('\n').filter(Boolean).length) };
  fs.writeFileSync(path.join(out, `record-${label}.json`), JSON.stringify(rec, null, 2));
  log.push(rec);
  return rec;
}

const UNATTENDED = 'This is an unattended run. No human will answer questions during it. The operator has agreed the scope in SCOPE.md and authorized the limits in .eccode/config.json (cost, runtime, concurrency, retries). Ordinary confirmations are pre-approved. Playwright is installed globally (NODE_PATH is set; browsers are in /opt/pw-browsers) for real-browser tests. Live model calls are available only through the `claude -p` command line (no API key is available). Do not push, deploy or contact external services.';

async function session(n, prompt, { killTrigger }) {
  const label = `s${n}`;
  const transcript = path.join(out, 'sessions', `${label}.jsonl`);
  prepareState('C2', state);
  const noteFile = path.join(out, 'operator-note.md');
  const note = fs.existsSync(noteFile) ? `\n\nOperator note (from whoever launched this run; it adds no authority beyond the scope and limits above):\n${fs.readFileSync(noteFile, 'utf8')}` : '';
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5-5', '--max-budget-usd', String(sessionUsd), '--permission-mode', 'bypassPermissions', '--append-system-prompt', UNATTENDED + note];
  const started = Date.now();
  let killed = false;
  await new Promise((resolve) => {
    const child = spawnInSandbox({ work, state, toolkit, env, cmd: 'claude', args, stdout: fs.openSync(transcript, 'w'), stderr: fs.openSync(path.join(out, 'sessions', `${label}.err`), 'w') });
    const stop = () => {
      killed = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    let watch;
    if (killTrigger) {
      let seen = new Set();
      let armed = false;
      watch = setInterval(() => {
        const st = readState();
        if (!st) return;
        for (const t of Object.values(st.tasks || {})) if (t.status === 'claimed' || t.status === 'done') seen.add(t.id);
        if (!armed && seen.size >= killAfterClaims && Object.values(st.runs).some((r) => r.status === 'running')) {
          armed = true;
          setTimeout(stop, 30000); // let in-flight agents write partial work to disk
        }
      }, 2000);
    }
    const hard = setTimeout(stop, Math.max(1, maxMinutes - (Date.now() - T0) / 60000) * 60000);
    child.on('exit', () => {
      clearTimeout(hard);
      if (watch) clearInterval(watch);
      resolve();
    });
  });
  let result = null;
  let init = null;
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
    try {
      const j = JSON.parse(l);
      if (j.type === 'result') result = j;
      if (j.type === 'system' && j.subtype === 'init') init = j;
    } catch {}
  }
  const rec = { session: label, sessionId: init && init.session_id, prompt: prompt.slice(0, 120), killedByDriver: killed, costUsd: result ? result.total_cost_usd : null, endedAs: result ? result.subtype : 'no result (killed or crashed)', wallMin: Math.round((Date.now() - started) / 600) / 100, finalText: String((result && result.result) || '').slice(-800) };
  log.push(rec);
  console.log(JSON.stringify({ ...rec, finalText: undefined }));
  return rec;
}

const T0 = Date.now();

/**
 * The account's usage limit ends a session with a message naming the reset time ("resets 2:50pm (UTC)" or
 * "resets Oct 10, 3pm (UTC)"). Wait for it instead of burning sessions. A session that fails instantly
 * for any other reason twice in a row also stops the run: it will not get better by being repeated.
 */
const LIMIT = /hit your (?:session|usage|weekly|rate)? ?limit[^\n]*?resets (?:([A-Z][a-z]{2}) (\d{1,2}),? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MAX_WAIT_HOURS = 60;
async function waitForLimit(rec) {
  const m = LIMIT.exec(`${rec.finalText || ''}`);
  if (!m) return false;
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const reset = new Date();
  reset.setUTCHours(hour, Number(m[4] || 0), 0, 0);
  if (m[1]) {
    reset.setUTCMonth(MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]));
    if (reset.getTime() < Date.now() - 86400000) reset.setUTCFullYear(reset.getUTCFullYear() + 1);
  } else if (reset.getTime() <= Date.now()) reset.setUTCDate(reset.getUTCDate() + 1);
  const waitMs = reset.getTime() - Date.now() + 90000;
  if (waitMs > MAX_WAIT_HOURS * 3600000) {
    console.log(`usage limit resets at ${reset.toISOString()}, more than ${MAX_WAIT_HOURS} h away; stopping`);
    log.push({ label: 'usage-limit-stop', until: reset.toISOString(), at: new Date().toISOString() });
    return 'stop';
  }
  console.log(`usage limit reached; waiting until ${reset.toISOString()} (+90 s)`);
  log.push({ label: 'usage-limit-wait', until: reset.toISOString(), at: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, waitMs));
  return true;
}

(async () => {
  let total = 0;
  let instant = 0;
  if (!continueFrom) {
    if (!install()) {
      console.error('plugin installation failed; see install.json');
      process.exit(1);
    }
    console.log('plugin installed from the documented marketplace method');
    snapshot('0-before-start');
    const idea = 'Build the product described in SCOPE.md in this directory. Read SCOPE.md first: its acceptance criteria D1-D10 are the agreed scope and must be carried into the architecture brief unchanged.';
    const first = await session(1, `/eccode:start ${idea}`, { killTrigger: true });
    total += first.costUsd || 0;
    snapshot('1-after-session-1-interrupted');
  }
  for (let n = continueFrom || 2; n <= maxSessions; n++) {
    const st = readState();
    if (st && st.delivery) break;
    const spent = (st && st.totals.costUsd) || 0;
    if (total >= maxTotal || (Date.now() - T0) / 60000 >= maxMinutes) {
      console.log('cap reached');
      break;
    }
    const r = await session(n, '/eccode:resume', { killTrigger: false });
    total += r.costUsd || 0;
    snapshot(`${n}-after-session-${n}`);
    const waited = await waitForLimit(r);
    if (waited === 'stop') break;
    if (waited) {
      n -= 1; // a session the limit stopped does not count against --max-sessions
      instant = 0;
      continue;
    }
    instant = (r.costUsd || 0) === 0 && r.wallMin < 0.3 ? instant + 1 : 0;
    if (instant >= 2) {
      console.log('two sessions in a row failed instantly without a recognised cause; stopping instead of repeating them');
      log.push({ label: 'instant-failures-stop', at: new Date().toISOString(), lastText: r.finalText });
      break;
    }
  }
  dropToken(state);
  const audit = spawnSync(process.execPath, [path.join(toolkit, 'bin', 'eccode.js'), 'audit', '--root', work], { encoding: 'utf8' });
  const final = snapshot('final');
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ totalSessionCostUsd: total, wallMin: Math.round((Date.now() - T0) / 600) / 100, sessions: log.filter((l) => l.session), final, auditOk: audit.status === 0, audit: audit.stdout.trim() }, null, 2));
  console.log(JSON.stringify({ totalSessionCostUsd: total, delivered: final.delivered, auditOk: audit.status === 0 }));
})();
