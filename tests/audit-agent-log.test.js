'use strict';
// The integrity analysis of the independent seeding agent's tool log (protocol amendment 4, owner decision 2 of
// 2026-11-02): which of its tool calls touched the repository under measurement, the key file, or neither.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const audit = require('../bench/pilot/hb2/audit-agent-log');

const SEAL = 'node /home/user/ECCode/bench/pilot/hb2/seal.js --plain /root/.cache/eccode/hb2-seeding-scratch/seeds.json --key-file /root/.cache/eccode/hb2-seeds.key --out-dir /home/user/ECCode/bench/suites/phase2-seeds-2 --mealie /root/.cache/eccode/mealie-seed --sealed-by "x"';

function log(calls, results = []) {
  const lines = [{ type: 'user', timestamp: '2026-11-02T19:33:00Z', message: { role: 'user', content: 'brief' } }];
  calls.forEach(([name, input], i) => lines.push({ type: 'assistant', timestamp: `2026-11-02T19:34:${String(i).padStart(2, '0')}Z`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input }] } }));
  results.forEach((r, i) => lines.push({ type: 'user', timestamp: '2026-11-02T20:00:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: r }] } }));
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

test('allowed work is not flagged: Mealie reads and edits, scratch writes, the one sealing command', () => {
  const r = audit.analyze(log([
    ['Read', { file_path: '/root/.cache/eccode/mealie-seed/mealie/routes/app/app_about.py' }],
    ['Grep', { pattern: 'def ', path: '/root/.cache/eccode/mealie-seed/mealie' }],
    ['Glob', { pattern: '**/*.py', path: '/root/.cache/eccode/mealie-seed/mealie' }],
    ['Write', { file_path: '/root/.cache/eccode/hb2-seeding-scratch/seeds.json', content: '{}' }],
    ['Bash', { command: 'cd /root/.cache/eccode/mealie-seed && git status --porcelain' }],
    ['Bash', { command: 'cd /root/.cache/eccode/mealie-seed && NLTK_DATA=/root/.cache/eccode/nltk_data UV_FROZEN=1 uv run pytest tests/unit_tests/test_x.py -q' }],
    ['Bash', { command: 'git -C /root/.cache/eccode/mealie-seed diff > /root/.cache/eccode/hb2-seeding-scratch/a.patch' }],
    ['Bash', { command: SEAL }],
  ]), { key: null });
  assert.strictEqual(r.toolCalls, 8);
  assert.deepStrictEqual(r.hard, []);
  assert.deepStrictEqual(r.review, []);
  assert.strictEqual(r.sealCommands, 1);
  assert.strictEqual(r.independent, true);
});

test('explicit access to the repository under measurement is flagged hard, with its category', () => {
  const r = audit.analyze(log([
    ['Read', { file_path: '/home/user/ECCode/lib/behavior.js' }],
    ['Read', { file_path: '/home/user/ECCode/scripts/behavior/probe_runner.py' }],
    ['Read', { file_path: '/home/user/ECCode/bench/pilot/phase2-hb/config.js' }],
    ['Read', { file_path: '/home/user/ECCode/tests/behavior.test.js' }],
    ['Read', { file_path: '/home/user/ECCode/docs/behavior-diff.md' }],
    ['Grep', { pattern: 'probe', path: '/home/user/ECCode' }],
    ['Bash', { command: 'cat /home/user/ECCode/lib/compat.js' }],
    ['Bash', { command: 'ls /home/user/ECCode/bench' }],
    ['Edit', { file_path: '/home/user/ECCode/lib/behavior.js', old_string: 'a', new_string: 'b' }],
  ]));
  assert.strictEqual(r.hard.length, 9);
  assert.deepStrictEqual(r.categories, { detector: 3, probe: 1, config: 1, tests: 1, other: 3 });
  assert.strictEqual(r.independent, false);
});

test('the default working directory is the repository: a path-less Grep or Glob and a Bash command without cd are flagged for review', () => {
  const r = audit.analyze(log([
    ['Grep', { pattern: 'probe' }],
    ['Glob', { pattern: '**/*.js' }],
    ['Read', { file_path: 'lib/behavior.js' }],
    ['Bash', { command: 'ls' }],
    ['Bash', { command: 'git log --oneline | head' }],
    ['Bash', { command: 'cat package.json' }],
  ]));
  assert.strictEqual(r.hard.length, 0);
  assert.strictEqual(r.review.length, 6);
  assert.strictEqual(r.independent, false, 'an unresolved implicit access is not independence');
});

test('the key file: read in any way but by the sealing command is flagged hard, and a key value in the log is a leak', () => {
  const key = 'ab'.repeat(32);
  const r1 = audit.analyze(log([['Bash', { command: 'cat /root/.cache/eccode/hb2-seeds.key' }], ['Read', { file_path: '/root/.cache/eccode/hb2-seeds.key' }]]), { key });
  assert.strictEqual(r1.hard.length, 2);
  assert.strictEqual(r1.keyInLog, 0);
  const r2 = audit.analyze(log([['Bash', { command: 'echo hi' }]], [`the key is ${key}`]), { key });
  assert.strictEqual(r2.keyInLog, 1);
  assert.strictEqual(r2.independent, false);
});

test('it reports the window and the count per tool and never the content of a result', () => {
  const r = audit.analyze(log([['Read', { file_path: '/root/.cache/eccode/mealie-seed/a.py' }], ['Bash', { command: 'cd /root/.cache/eccode/mealie-seed && ls' }], ['Bash', { command: 'cd /root/.cache/eccode/mealie-seed && ls' }]], ['SECRET-RESULT-TEXT']));
  assert.deepStrictEqual(r.byTool, { Read: 1, Bash: 2 });
  assert.ok(r.firstAt && r.lastAt);
  assert.ok(!JSON.stringify(r).includes('SECRET-RESULT-TEXT'));
});

test('tool names are matched without case, and every tool that runs a shell command is classified like Bash (Monitor too)', () => {
  const r = audit.analyze(log([
    ['bash', { command: 'cat /home/user/ECCode/lib/behavior.js' }],
    ['Monitor', { command: 'grep -r probe /home/user/ECCode/scripts', description: 'watch', timeout_ms: 1000 }],
    ['Monitor', { command: 'until ls /root/.cache/eccode/hb2-seeding-scratch; do sleep 1; done', description: 'wait' }],
    ['monitor', { command: 'tail -f log.txt', description: 'implicit' }],
    ['TaskStop', { task_id: 'x' }],
    ['ToolSearch', { query: 'x', max_results: 1 }],
  ]));
  assert.strictEqual(r.hard.length, 2);
  assert.strictEqual(r.review.length, 1);
  assert.strictEqual(r.toolCalls, 6);
});

test('a command made only of commands that cannot touch a file is inert; anything that can read or write one still needs a working directory', () => {
  const inert = ['sleep 240; echo tick', 'sleep 5 && echo done', 'echo hello', 'date', 'sleep 3; sleep 4; printf "x\\n"'];
  const notInert = ['sleep 5; cat package.json', 'echo hi > out.txt', 'echo $(cat package.json)', 'echo `ls`', 'sleep 1 | tee x', 'echo a; ls', 'true && git status'];
  for (const command of inert) assert.strictEqual(audit.analyze(log([['Monitor', { command }]])).review.length, 0, command);
  for (const command of notInert) assert.strictEqual(audit.analyze(log([['Monitor', { command }]])).review.length, 1, command);
  // An inert command that names the repository is still a hard hit.
  assert.strictEqual(audit.analyze(log([['Bash', { command: 'echo /home/user/ECCode/lib' }]])).hard.length, 1);
});

test('H-B3: the H-B3 sealing command, scratch directory and key file are recognised like the H-B2 ones', () => {
  const SEAL3 = 'node /home/user/ECCode/bench/pilot/hb3/seal.js --plain /root/.cache/eccode/hb3-seeding-scratch/seeds.json --key-file /root/.cache/eccode/hb3-seeds.key --out-dir /home/user/ECCode/bench/suites/phase2-seeds-3 --mealie /root/.cache/eccode/mealie-seed --sealed-by "x"';
  const ok = audit.analyze(log([
    ['Write', { file_path: '/root/.cache/eccode/hb3-seeding-scratch/seeds.json', content: '{}' }],
    ['Bash', { command: 'cd /root/.cache/eccode/hb3-seeding-scratch && ls' }],
    ['Bash', { command: `${SEAL3} 2>&1 | tail -5` }],
  ]));
  assert.deepStrictEqual(ok.hard, []);
  assert.deepStrictEqual(ok.review, []);
  assert.strictEqual(ok.sealCommands, 1);
  assert.strictEqual(ok.independent, true);
  // The key files of both sets are off limits other than through the command.
  for (const f of ['/root/.cache/eccode/hb3-seeds.key', '/root/.cache/eccode/hb2-seeds.key']) {
    const r = audit.analyze(log([['Bash', { command: `cat ${f}` }], ['Read', { file_path: f }], ['Grep', { pattern: 'a', path: f }]]));
    assert.strictEqual(r.hard.length, 3, f);
    assert.ok(r.hard.every((h) => h.category === 'key'));
  }
  // Another file of the repository run in the same call as the sealing command is not hidden by it.
  const sneaky = audit.analyze(log([['Bash', { command: `${SEAL3} && cat /home/user/ECCode/lib/behavior.js` }], ['Bash', { command: `cd /tmp && ${SEAL3}; cat /home/user/ECCode/scripts/behavior/probe_runner.py` }]]));
  assert.deepStrictEqual(sneaky.hard.map((h) => h.category), ['detector', 'probe']);
  // And the repository's other tools are not the sealing command.
  const other = audit.analyze(log([['Bash', { command: 'node /home/user/ECCode/bench/pilot/hb3/freeze.js' }], ['Bash', { command: 'node /home/user/ECCode/bench/pilot/hb3/seal.js_x --plain a' }]]));
  assert.strictEqual(other.hard.length, 2);
  assert.strictEqual(other.sealCommands, 0);
});
