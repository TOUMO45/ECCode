#!/usr/bin/env node
'use strict';
// Summarise one pilot run so it can be read (and pasted) without the full transcript.
//   node tools/pilot-trace.js <run dir, e.g. results2/textkit-e-2> [--max <chars per line, default 220>]
// Prints: which prompt the arm got, tool-call counts, every subagent dispatch, every eccode command with the first
// line of its answer, every refusal, the oracle's failing checks, and the last thing the agent said.
// It prints no file contents and no environment values.
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) { process.stderr.write('usage: pilot-trace.js <run dir> [--max <n>]\n'); process.exit(1); }
const maxAt = process.argv.indexOf('--max');
const MAX = maxAt > 0 ? Number(process.argv[maxAt + 1]) : 220;
const clip = (s) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > MAX ? `${t.slice(0, MAX)}...` : t; };
const out = (s = '') => process.stdout.write(`${s}\n`);

let result = {};
try { result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch { /* no result file */ }
const lines = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim());

const counts = {};
const calls = new Map(); // tool_use id -> { name, summary, sub }
const events = [];
let lastText = '';
let messages = 0;
let subMessages = 0;

for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  const inSub = Boolean(o.parent_tool_use_id);
  const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  if (o.type === 'assistant') { if (inSub) subMessages += 1; else messages += 1; }
  for (const b of content) {
    if (b.type === 'text' && o.type === 'assistant' && !inSub && b.text.trim()) lastText = b.text;
    if (b.type === 'tool_use') {
      counts[b.name] = (counts[b.name] || 0) + 1;
      const input = b.input || {};
      let summary = '';
      if (b.name === 'Bash') summary = input.command || '';
      else if (b.name === 'Task' || b.name === 'Agent') summary = `[${input.subagent_type || '?'}] ${input.description || ''} :: ${input.prompt || ''}`;
      else if (b.name === 'Skill') summary = JSON.stringify(input);
      else summary = input.file_path || input.pattern || input.path || '';
      calls.set(b.id, { name: b.name, summary, sub: inSub });
      const interesting = b.name === 'Task' || b.name === 'Agent' || b.name === 'Skill' || (b.name === 'Bash' && /eccode/.test(summary));
      if (interesting) events.push({ id: b.id, who: inSub ? 'sub ' : 'main', name: b.name, summary });
    }
    if (b.type === 'tool_result') {
      const call = calls.get(b.tool_use_id);
      const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n');
      const ev = events.find((e) => e.id === b.tool_use_id);
      if (ev) ev.answer = text;
      if (call && !ev && /eccode: \[[A-Z_]+\]/.test(text)) events.push({ who: call.sub ? 'sub ' : 'main', name: call.name, summary: call.summary, answer: text });
    }
  }
}

out(`run: ${path.basename(path.resolve(dir))}`);
out(`score ${result.oracle ? `${result.oracle.passed}/${result.oracle.total}` : 'n/a'} | seconds ${result.wallSeconds} | timed out ${result.timedOut} | cost ${result.costUsd} | turns ${result.turns}`);
out(`messages: main ${messages}, inside subagents ${subMessages}`);
out(`prompt starts: ${clip(result.prompt || '')}`);
out(`tool calls: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);

const refusals = {};
for (const e of events) {
  const m = /eccode: \[([A-Z_]+)\]/.exec(e.answer || '');
  if (m) refusals[m[1]] = (refusals[m[1]] || 0) + 1;
}
out(`refusals: ${Object.entries(refusals).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
out('');
out('--- dispatches, skills and eccode commands, in order ---');
events.forEach((e, i) => {
  out(`${String(i + 1).padStart(3)} ${e.who} ${e.name}: ${clip(e.summary)}`);
  if (e.answer !== undefined && e.name !== 'Skill') out(`      -> ${clip(e.answer)}`);
});
out('');
out('--- oracle (last lines) ---');
for (const l of result.oracleTail || []) out(clip(l));
out('');
out('--- last message of the main agent ---');
out(String(lastText).slice(0, 1500));
