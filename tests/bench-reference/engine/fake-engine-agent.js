'use strict';
// A scripted stand-in for an agent that follows .claude/commands/eccode/quick.md
// in a bench sandbox, using the INSTALLED toolkit: quick, claim, the change (a
// reference solution), evidence, a drafted handoff, phase review, verification,
// delivery. It ends with a result line shaped like `claude -p --output-format json`.
// Usage (cwd = sandbox): node fake-engine-agent.js <reference.js> <verification command>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [ref, command] = process.argv.slice(2);
const cli = path.join(process.cwd(), '.claude', 'eccode', 'bin', 'eccode.js');
const E = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
const prompt = fs.readFileSync('PROMPT.md', 'utf8');
if (!/quick track/.test(prompt)) throw new Error('not an engine prompt');

E('quick', 'The change in PROMPT.md', '--actor', 'orchestrator', '--command', command);
const run = E('run', 'start', '--actor', 'orchestrator', '--for', 'backend-engineer', '--task', 'change').trim();
E('task', 'claim', 'change', '--actor', 'backend-engineer');
require(path.resolve(ref));
E('evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', command);
E('handoff', 'draft', '--task', 'change', '--actor', 'backend-engineer', '--out', '.eccode/drafts/handoff-change.json');
const h = JSON.parse(fs.readFileSync('.eccode/drafts/handoff-change.json', 'utf8'));
h.context = 'Scripted bench agent following the quick track.';
h.completedWork = 'Applied the reference change and its test; the planned check passes.';
fs.writeFileSync('.eccode/drafts/handoff-change.json', JSON.stringify(h));
E('task', 'complete', 'change', '--actor', 'backend-engineer', '--handoff', '.eccode/drafts/handoff-change.json');
E('gate', 'submit', 'phase:change', '--actor', 'backend-engineer');
E('run', 'end', run, '--actor', 'orchestrator', '--tokens', '1234');
const review = (gate, actor, extra = []) => {
  const ev = JSON.parse(E('evidence', 'run', '--actor', actor, '--gate', gate, '--label', 'review', '--json', '--', command));
  fs.mkdirSync('.eccode/reviews/drafts', { recursive: true });
  const file = `.eccode/reviews/drafts/${gate.replace(':', '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ decision: 'approve', summary: 'The change and its test pass under the reviewer run.', criteria: [{ id: 'C1', description: 'the change works and its verification command passes', met: true, evidence: [`ev:${ev.id}`, ...extra] }], findings: [] }));
  E('gate', 'review', gate, '--actor', actor, '--file', file);
};
review('phase:change', 'technical-reviewer');
E('gate', 'start', 'verification', '--actor', 'orchestrator');
fs.writeFileSync('.eccode/artifacts/verification.md', '# Verification\nThe planned check passes.\n');
E('gate', 'submit', 'verification', '--actor', 'delivery-lead', '--artifact', '.eccode/artifacts/verification.md');
review('verification', 'security-reviewer', ['artifact:.eccode/artifacts/verification.md']);
E('deliver', '--actor', 'delivery-lead');
process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 0.4321, num_turns: 12, modelUsage: { a: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200 }, b: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }, subagent_stats: { spawned: 4 } }) + '\n');
