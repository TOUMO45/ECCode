#!/usr/bin/env node
'use strict';
// The screening labeller of the ambiguous category (protocol amendment 2): a
// model (`claude -p`, sonnet) given the rubric, the item's registered question
// and the run's final answer and patch summary only, nothing of the harness or
// the engine. Writes labels.json beside the save file: one entry per run
// (task, variant, runIndex): {label: asked|guessed|neither, reason}.
//   node label.js --save <runs.jsonl> [--model sonnet] [--only <task id>]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const bench = require('../../../../lib/bench');

const RUBRIC = fs.readFileSync(path.join(__dirname, 'rubric.md'), 'utf8');

function patchSummary(patch) {
  const files = [...String(patch || '').matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  const added = (String(patch || '').match(/^\+(?!\+\+)/gm) || []).length;
  const removed = (String(patch || '').match(/^-(?!--)/gm) || []).length;
  return `${files.length} file(s) changed (+${added}/−${removed} lines): ${files.join(', ') || 'none'}`;
}

/** The registered question of a task id (the task directory is found by the id in its task.json). */
function questionOf(suite, taskId) {
  for (const d of fs.readdirSync(suite)) {
    const tj = path.join(suite, d, 'task.json');
    if (!fs.existsSync(tj) || JSON.parse(fs.readFileSync(tj, 'utf8')).id !== taskId) continue;
    const f = path.join(suite, d, 'question.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  return null;
}

function labelRun(run, question, { model = 'sonnet' } = {}) {
  const answer = (run.usage && run.usage.answer) || '(the run printed no final answer)';
  const prompt = [
    'You are the labeller of a benchmark. Apply the rubric below to one run and reply with one JSON object on one line: {"label": "asked" | "guessed" | "neither", "reason": "<one line, quoting the run where it asks or where it takes a reading>"}. Nothing else.',
    '', '## Rubric', '', RUBRIC,
    '## The registered question of this item', '', question.question, '', `Readings an arm could take: ${(question.readings || []).map((r, i) => `(${i + 1}) ${r}`).join('; ')}`,
    '', '## The run', '', `Patch summary: ${patchSummary(run.patch)}`, '', 'Final answer of the run:', '', answer,
  ].join('\n');
  const r = spawnSync('claude', ['-p', '--model', model, '--output-format', 'json', '--allowedTools', ''], { input: prompt, encoding: 'utf8', env: bench.agentEnv({}), timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  const usage = bench.usageOf(r.stdout);
  const text = (usage && usage.answer) || '';
  const m = /\{[\s\S]*\}/.exec(text);
  let parsed = null;
  try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
  if (!parsed || !['asked', 'guessed', 'neither'].includes(parsed.label)) return { label: 'unlabelled', reason: `labeller output unreadable: ${text.slice(0, 200)}`, costUsd: usage ? usage.costUsd : null };
  return { label: parsed.label, reason: String(parsed.reason || '').slice(0, 500), costUsd: usage ? usage.costUsd : null, model };
}

function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1];
  const save = path.resolve(flags.save);
  const suite = path.resolve(flags.suite || path.join(__dirname, '..'));
  const out = save.replace(/\.jsonl$/, '') + '.labels.json';
  const labels = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { rubric: 'bench/suites/senior/_tools/rubric.md', labeller: `model (${flags.model || 'sonnet'})`, runs: {} };
  const runs = bench.loadRuns(fs.readFileSync(save, 'utf8'));
  for (const run of runs) {
    if (flags.only && run.task !== flags.only) continue;
    const key = `${run.task}|${run.variant}|${run.runIndex}`;
    if (labels.runs[key]) continue;
    const q = questionOf(suite, run.task);
    if (!q) continue;
    labels.runs[key] = { task: run.task, variant: run.variant, runIndex: run.runIndex, ...labelRun(run, q, { model: flags.model }) };
    fs.writeFileSync(out, JSON.stringify(labels, null, 1) + '\n');
    process.stderr.write(`label: ${key} ${labels.runs[key].label}\n`);
  }
  fs.writeFileSync(out, JSON.stringify(labels, null, 1) + '\n');
  process.stdout.write(`${Object.keys(labels.runs).length} run(s) labelled -> ${out}\n`);
}

module.exports = { labelRun, patchSummary };

if (require.main === module) main(process.argv.slice(2));
