#!/usr/bin/env node
'use strict';
// Replays a saved run for labelling. A result line keeps only the last lines
// of a check's output, too little to judge a failure, so this exports the
// item's source tree, applies the run's saved patch, runs the task's setup,
// places the hidden tests and runs the target check, keeping all of its
// output. With --split, a target written as "<backend> && (<frontend>)" runs
// as its two parts.
// <n> counts the task's runs in <runs.jsonl> from 1. Pass one process's file
// (<scratch>/stage1/w2.jsonl) and it is the n of a label key <process>:<task>:<n>.
// usage: node proof-replay.js <suite dir> <runs.jsonl> <task id> <n> <out dir> [--split]
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const bench = require('../../../lib/bench');
const { commandEnv } = require('../../../lib/util');

/** The target command's parts: a backend and a parenthesised frontend joined by && become two. */
function parts(command, split) {
  const k = command.indexOf(' && (');
  return split && k > 0 ? [command.slice(0, k), command.slice(k + 4)] : [command];
}

function main(suite, runsFile, taskId, n, out, flag) {
  const task = bench.listTasks(path.resolve(suite)).find((t) => t.id === taskId);
  const run = fs.readFileSync(runsFile, 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse).filter((r) => r.task === taskId)[Number(n) - 1];
  const dir = path.join(out, 'tree');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  bench.exportSource({ repo: task.source.repo, commit: task.source.commit }, dir);
  fs.writeFileSync(path.join(out, 'run.patch'), run.patch);
  execSync('git init -q . && git add -A && git -c user.email=x@x -c user.name=x -c commit.gpgsign=false commit -qm base', { cwd: dir });
  const ap = spawnSync('git', ['apply', '--whitespace=nowarn', path.join(out, 'run.patch')], { cwd: dir, encoding: 'utf8' });
  if (ap.status !== 0) throw new Error(`the patch does not apply: ${ap.stderr}`);
  const setup = bench.runSetup(task, dir);
  if (setup && !setup.ok) throw new Error(`setup failed: ${setup.tail}`);
  bench.placeHidden(task, dir);
  const env = commandEnv(bench.taskEnv(task));
  const target = task.hiddenChecks.find((c) => c.id === 'target');
  parts(target.command, flag === '--split').forEach((cmd, i, all) => {
    const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', timeout: target.timeoutMs || 600000, maxBuffer: 64 * 1024 * 1024, env });
    const file = path.join(out, `target${all.length > 1 ? `-${i + 1}` : ''}.txt`);
    fs.writeFileSync(file, `${r.stdout || ''}${r.stderr || ''}`);
    process.stdout.write(`target${all.length > 1 ? ` part ${i + 1}` : ''}: ${r.status === 0 ? 'passes' : 'FAILS'} (${file})\n`);
  });
}

module.exports = { parts };

if (require.main === module) main(...process.argv.slice(2));
