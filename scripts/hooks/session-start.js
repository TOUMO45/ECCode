#!/usr/bin/env node
'use strict';
// SessionStart hook: if the project has an ECCode record, inject a resume
// brief (gates, tasks, open/interrupted runs, budget, next action) so an
// interrupted delivery continues from the record instead of from memory.
// Silent for projects without .eccode/. Disable with ECCODE_HOOKS=off.

const fs = require('fs');
const path = require('path');

function findRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.eccode', 'events.jsonl'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    if (process.env.ECCODE_HOOKS === 'off') return;
    const input = JSON.parse(raw || '{}');
    const root = findRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
    if (!root) return;
    const lib = path.join(__dirname, '..', '..', 'lib');
    const { Store } = require(path.join(lib, 'store'));
    const { loadConfig } = require(path.join(lib, 'config'));
    const { summary, formatBrief } = require(path.join(lib, 'status'));
    const { inspect, formatIssues } = require(path.join(lib, 'reconcile'));
    const store = new Store(root);
    const audit = store.audit();
    const state = store.state();
    const brief = formatBrief(summary(state, loadConfig(root)));
    const text = [
      '## ECCode delivery in progress (from the persistent project record)',
      brief,
      formatIssues(inspect(store, state)),
      audit.ok ? '' : `WARNING: event log integrity check failed: ${audit.errors.slice(0, 3).join('; ')}`,
      'Use the `orchestrate` skill to continue. First run `eccode reconcile --verify --actor orchestrator` and resolve BLOCKING items. Open runs from a previous session are interrupted: recover them with `eccode recover --all` before dispatching.',
    ]
      .filter(Boolean)
      .join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text.slice(0, 9500) } }));
  } catch (err) {
    process.stderr.write(`eccode session-start: ${err.message}\n`);
  }
});
