#!/usr/bin/env node
'use strict';
// Stop hook: completion gate for UNATTENDED ECCode workflows.
//
// Observed in pilots: with nobody to answer, an orchestrator sometimes judges
// the process "too heavy for a one-line fix", does the work itself and ends the
// session - no gates, no independent review, no lessons. The skill text cannot
// prevent that; this hook can. When ECCODE_UNATTENDED=1 and the session was
// started with /eccode:start, /eccode:change or /eccode:resume, the session may
// end only when the delivery is complete or the record is waiting for a user
// decision. Otherwise the hook blocks the stop and says what to do next.
//
// Interactive sessions are never blocked (the model may legitimately stop to ask
// the user). To bound the damage of any hook bug, at most MAX_BLOCKS stops per
// session are blocked. Disable with ECCODE_HOOKS=off.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BLOCKS = 4;
const WORKFLOW_COMMANDS = /<command-name>\/eccode:(start|change|resume)<\/command-name>|^\/eccode:(start|change|resume)\b/m;

function findRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.eccode', 'events.jsonl'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function startedWithWorkflowCommand(transcriptPath) {
  try {
    const head = fs.readFileSync(transcriptPath, 'utf8').split('\n').slice(0, 40).join('\n');
    return WORKFLOW_COMMANDS.test(head) || /"content":"\/eccode:(start|change|resume)\b/.test(head);
  } catch {
    return false;
  }
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

function blockedSoFar(session) {
  const f = path.join(os.tmpdir(), `eccode-stop-${String(session).replace(/[^\w-]/g, '_')}`);
  let n = 0;
  try {
    n = Number(fs.readFileSync(f, 'utf8')) || 0;
  } catch {
    n = 0;
  }
  return { n, bump: () => fs.writeFileSync(f, String(n + 1)) };
}

function main(input) {
  if (process.env.ECCODE_HOOKS === 'off' || process.env.ECCODE_UNATTENDED !== '1') return;
  if (!startedWithWorkflowCommand(input.transcript_path)) return;
  const counter = blockedSoFar(input.session_id || 'unknown');
  if (counter.n >= MAX_BLOCKS) {
    process.stderr.write(`eccode stop-hook: blocked ${MAX_BLOCKS} stops in this session; letting it end\n`);
    return;
  }
  const root = findRoot(input.cwd || process.cwd());
  if (!root) {
    counter.bump();
    return block('This session was started with an ECCode command, but no ECCode project exists here. You are the orchestrator, not the implementer: run `eccode init --name "<name>" --idea "<the request in its own words>"` (add `--profile change` for a change request) and follow the orchestrate skill: reviewed plan, an implementer subagent that claims the task, an independent phase review, then `eccode deliver --actor orchestrator`. Do not make the change yourself in the main session, however small it looks. No human will answer questions in this run; ordinary confirmations are pre-approved.');
  }
  const lib = path.join(__dirname, '..', '..', 'lib');
  const { Store } = require(path.join(lib, 'store'));
  const { loadConfig } = require(path.join(lib, 'config'));
  const { nextAction } = require(path.join(lib, 'status'));
  const { pendingRedelivery } = require(path.join(lib, 'rework'));
  const state = new Store(root).state();
  const next = nextAction(state, loadConfig(root));
  if (next.action === 'user-decision') return; // a legitimate place to stop: only the user can proceed
  if (next.action === 'done' && !pendingRedelivery(state)) return;
  counter.bump();
  block(`The ECCode workflow is not finished: NEXT: ${next.action}${next.gate ? ` [${next.gate}]` : ''} - ${next.detail}. Continue with the orchestrate skill from there. Only a delivered project or a pending user decision ends this run. No human will answer questions in this run; ordinary confirmations are pre-approved.`);
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    main(JSON.parse(raw || '{}'));
  } catch (err) {
    process.stderr.write(`eccode stop-hook: ${err.message} (allowing the stop)\n`);
  }
});
