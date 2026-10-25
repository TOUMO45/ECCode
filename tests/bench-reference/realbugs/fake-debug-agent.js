'use strict';
// A scripted stand-in for an agent that follows .claude/commands/eccode/debug.md
// in a bench sandbox, using the INSTALLED toolkit: debug, claim, a regression
// test recorded failing, the fix, evidence, fix verify, a mutation run, a drafted
// handoff, a lesson drafted from the record, one review, delivery by the orchestrator. It ends with a result line
// shaped like `claude -p --output-format json`.
// Usage (cwd = sandbox): node fake-debug-agent.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.env.BENCH_FLAG !== 'on') throw new Error('the task environment did not reach the agent');
const cli = path.join(process.cwd(), '.claude', 'eccode', 'bin', 'eccode.js');
const E = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
const prompt = fs.readFileSync('PROMPT.md', 'utf8');
if (!/debug track/.test(prompt) || !/The bug:/.test(prompt)) throw new Error('not a debug-track prompt');
const command = 'npm test';

E('debug', 'Ten items get no bulk discount', '--actor', 'orchestrator', '--command', command);
const run = E('run', 'start', '--actor', 'orchestrator', '--for', 'backend-engineer', '--task', 'fix').trim();
E('task', 'claim', 'fix', '--actor', 'backend-engineer');
fs.appendFileSync('tests/price.test.js', "test('bulk from 10', () => assert.strictEqual(price(10), 90));\n");
E('evidence', 'run', '--actor', 'backend-engineer', '--task', 'fix', '--purpose', 'reproduction', '--label', 'repro', '--', command);
fs.writeFileSync('src/price.js', fs.readFileSync('src/price.js', 'utf8').replace('n > 10', 'n >= 10'));
E('evidence', 'run', '--actor', 'backend-engineer', '--task', 'fix', '--label', 'verify', '--', command);
E('fix', 'verify', '--actor', 'backend-engineer', '--task', 'fix');
E('mutate', '--actor', 'backend-engineer', '--task', 'fix', '--test', command, '--record');
E('handoff', 'draft', '--task', 'fix', '--actor', 'backend-engineer', '--out', '.eccode/drafts/handoff-fix.json');
const h = JSON.parse(fs.readFileSync('.eccode/drafts/handoff-fix.json', 'utf8'));
h.context = 'Root cause: the bulk boundary compared with > instead of >=.';
h.completedWork = 'The boundary is >= 10; the regression test is proven by fix verify and kills the boundary mutant.';
fs.writeFileSync('.eccode/drafts/handoff-fix.json', JSON.stringify(h));
E('task', 'complete', 'fix', '--actor', 'backend-engineer', '--handoff', '.eccode/drafts/handoff-fix.json');
E('memory', 'draft', '--task', 'fix', '--actor', 'backend-engineer', '--out', '.eccode/drafts/lesson-fix.json');
const lesson = JSON.parse(fs.readFileSync('.eccode/drafts/lesson-fix.json', 'utf8'));
Object.assign(lesson.content, { symptoms: ['an order of 10 items is charged full price'], appliesWhen: ['a discount starts at a quantity'], notApplicableWhen: ['flat pricing'] });
lesson.content.solution.tradeoffs = 'none';
fs.writeFileSync('.eccode/drafts/lesson-fix.json', JSON.stringify(lesson));
E('memory', 'add', '--file', '.eccode/drafts/lesson-fix.json', '--actor', 'backend-engineer');
E('gate', 'submit', 'phase:fix', '--actor', 'backend-engineer');
E('run', 'end', run, '--actor', 'orchestrator', '--tokens', '777');
const ev = JSON.parse(E('evidence', 'run', '--actor', 'technical-reviewer', '--gate', 'phase:fix', '--label', 'review', '--json', '--', command));
const criteria = JSON.parse(fs.readFileSync('.eccode/state.json', 'utf8')).tasks.fix.acceptanceCriteria.map((description, i) => ({ id: `C${i + 1}`, description, met: true, evidence: [`ev:${ev.id}`] }));
fs.mkdirSync('.eccode/reviews/drafts', { recursive: true });
fs.writeFileSync('.eccode/reviews/drafts/phase-fix.json', JSON.stringify({ decision: 'approve', summary: 'Root cause fixed; the regression test is proven and kills the mutant.', criteria, findings: [] }));
E('gate', 'review', 'phase:fix', '--actor', 'technical-reviewer', '--file', '.eccode/reviews/drafts/phase-fix.json');
E('deliver', '--actor', 'orchestrator');
process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 0.2, num_turns: 9, modelUsage: { a: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 } }, subagent_stats: { spawned: 2 } }) + '\n');
