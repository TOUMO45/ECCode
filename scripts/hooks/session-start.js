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
    const store = new Store(root);
    const audit = store.audit();
    // Anchor check: history already on the upstream branch must still be
    // present unchanged. A locally recomputed hash chain passes audit();
    // the upstream copy is outside a local agent's reach.
    let anchor = '';
    try {
      const { execFileSync } = require('child_process');
      const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
      const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      const committed = git(['show', `${upstream}:./.eccode/events.jsonl`]);
      const diverged = store.divergenceFrom(committed);
      anchor = diverged.length
        ? `WARNING: the record diverges from ${upstream}: ${diverged[0]} — STOP and tell the user; do not continue on a rewritten record.`
        : `Record anchored: history matches ${upstream}.`;
    } catch {
      anchor = ''; // no upstream, or the record is not committed there: nothing to anchor against
    }
    const brief = formatBrief(summary(store.state(), loadConfig(root)));
    const PROTECTION = {
      sandbox: 'Record protection: OS sandbox. Shell commands cannot write the record; record changes go through the eccode MCP tools of your role (mcp__eccode_<role>__*).',
      'no-shell': 'Record protection: no shell. Shell tools are denied in this project; use the eccode MCP tools of your role (mcp__eccode_<role>__*) and the file tools.',
      guard: 'Record protection: text guard only (profile "guard"). Obfuscated shell commands can get past it. For enforced protection reinstall with `eccode install --profile sandbox` (or `--profile no-shell`).',
    };
    const protection = PROTECTION[require(path.join(lib, 'install')).protectionProfile(root)];
    // MCP servers ECCode did not install run outside both the sandbox and the
    // shell deny; name them so their file-write tools can be denied.
    let others = [];
    try {
      const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
      // codebase_memory is ECCode's own optional integration; its writes go to
      // its index (ADRs included), never to repository files.
      others = Object.keys(mcp.mcpServers || {}).filter((n) => !n.startsWith('eccode_') && n !== 'codebase_memory');
    } catch { /* no project MCP config */ }
    const foreign = others.length
      ? `Other MCP servers in .mcp.json run outside the record protection: ${others.join(', ')}. If any can write files, deny those tools (permissions.deny: "mcp__<server>__<tool>").`
      : '';
    const text = [
      '## ECCode delivery in progress (from the persistent project record)',
      brief,
      audit.ok ? '' : `WARNING: event log integrity check failed: ${audit.errors.slice(0, 3).join('; ')}`,
      anchor,
      protection,
      foreign,
      'Use the `orchestrate` skill to continue. Open runs from a previous session are interrupted: recover them with `eccode recover --all` before dispatching.',
    ]
      .filter(Boolean)
      .join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text.slice(0, 9500) } }));
  } catch (err) {
    process.stderr.write(`eccode session-start: ${err.message}\n`);
  }
});
