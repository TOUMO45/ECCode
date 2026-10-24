'use strict';
// A scripted stand-in for an agent working one item of a chain through the
// INSTALLED toolkit's quick track: `quick` creates the record on the first item
// and starts the next work item on a delivered record after that. The item id
// is read from PROMPT.md ("Item: <id>"). Before working, it appends what it
// sees in the sandbox to $ECCODE_TEST_OBS (one JSON line per item), so tests
// can check what crossed from one item to the next.
//   ECCODE_TEST_CRASH_ITEM=<id>  that item claims its task and exits 1 (a crash mid-work)
//   ECCODE_TEST_COST=<usd>       the cost its result line reports (default 0.2)
// Usage (cwd = sandbox): node fake-chain-agent.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const prompt = fs.readFileSync('PROMPT.md', 'utf8');
const id = (prompt.match(/Item: (\S+)/) || [])[1];
if (!id) throw new Error('no item id in PROMPT.md');
if (process.env.ECCODE_TEST_OBS) {
  fs.appendFileSync(process.env.ECCODE_TEST_OBS, JSON.stringify({ item: id, extra: fs.existsSync('src/extra.txt'), hidden: fs.existsSync('.bench-hidden'), value: fs.readFileSync('src/value.txt', 'utf8') }) + '\n');
}
const cli = path.join(process.cwd(), '.claude', 'eccode', 'bin', 'eccode.js');
const E = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
const command = 'node check.js';

E('quick', `Item ${id}`, '--actor', 'orchestrator', '--command', command);
const run = E('run', 'start', '--actor', 'orchestrator', '--for', 'backend-engineer', '--task', 'change').trim();
E('task', 'claim', 'change', '--actor', 'backend-engineer');
if (process.env.ECCODE_TEST_CRASH_ITEM === id) process.exit(1);
fs.appendFileSync('src/value.txt', `${id}\n`);
if (id === 'c1') fs.writeFileSync('src/extra.txt', 'left by c1\n');
E('evidence', 'run', '--actor', 'backend-engineer', '--task', 'change', '--label', 'verify', '--', command);
E('handoff', 'draft', '--task', 'change', '--actor', 'backend-engineer', '--out', '.eccode/drafts/handoff-change.json');
const h = JSON.parse(fs.readFileSync('.eccode/drafts/handoff-change.json', 'utf8'));
h.context = `Scripted chain agent, item ${id}.`;
h.completedWork = 'Appended the item id to src/value.txt; the planned check passes.';
fs.writeFileSync('.eccode/drafts/handoff-change.json', JSON.stringify(h));
E('task', 'complete', 'change', '--actor', 'backend-engineer', '--handoff', '.eccode/drafts/handoff-change.json');
E('gate', 'submit', 'phase:change', '--actor', 'backend-engineer');
E('run', 'end', run, '--actor', 'orchestrator', '--tokens', '100');
const review = (gate, actor, extra = []) => {
  const ev = JSON.parse(E('evidence', 'run', '--actor', actor, '--gate', gate, '--label', 'review', '--json', '--', command));
  fs.mkdirSync('.eccode/reviews/drafts', { recursive: true });
  const file = `.eccode/reviews/drafts/${gate.replace(':', '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ decision: 'approve', summary: 'The change and its check pass under the reviewer run.', criteria: [{ id: 'C1', description: 'the change works and its verification command passes', met: true, evidence: [`ev:${ev.id}`, ...extra] }], findings: [] }));
  E('gate', 'review', gate, '--actor', actor, '--file', file);
};
review('phase:change', 'technical-reviewer');
E('gate', 'start', 'verification', '--actor', 'orchestrator');
fs.writeFileSync('.eccode/artifacts/verification.md', `# Verification\nItem ${id}: the planned check passes.\n`);
E('gate', 'submit', 'verification', '--actor', 'delivery-lead', '--artifact', '.eccode/artifacts/verification.md');
review('verification', 'security-reviewer', ['artifact:.eccode/artifacts/verification.md']);
E('deliver', '--actor', 'delivery-lead');
process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: Number(process.env.ECCODE_TEST_COST || 0.2), num_turns: 9, modelUsage: { a: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 } } }) + '\n');
