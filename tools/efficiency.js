#!/usr/bin/env node
'use strict';
// Where a run spends its time and tokens. Reads the stream-json transcripts the pilot runners save.
//   node tools/efficiency.js <run dir> [<run dir> ...]
// A run dir is either a sessions run (s1/, s2/, s3/ each with transcript.jsonl) or a single run (transcript.jsonl).
// Prints one line per session and a total per run, then for each run the work split by kind and the largest tool
// outputs (big outputs fill the context and are paid for again on every later turn). No file contents are printed.
const fs = require('fs');
const path = require('path');

const KINDS = ['tool', 'tests', 'write', 'explore', 'shell', 'dispatch'];
// tool: commands and docs of the plugin under test (eccode, supervisor.py, skill/agent/command files)
const isToolCmd = (s) => /\beccode(\.js)?\b|supervisor\.py|\bstatus --brief\b/.test(s);
const isToolDoc = (s) => /[\\/](skills|agents|commands|references|templates)[\\/].*\.md$|eccode-plugin|supervisor-plugin|SKILL\.md/.test(s);
const isTests = (s) => /unittest|pytest|npm (run )?test|node --test|python3? -m |\btest_|\.test\./.test(s);

function kindOf(name, input) {
  if (name === 'Task' || name === 'Agent') return 'dispatch';
  if (name === 'Skill') return 'tool';
  if (name === 'Bash' || name === 'PowerShell') {
    const c = String(input.command || '');
    if (isToolCmd(c)) return 'tool';
    if (isTests(c)) return 'tests';
    return 'shell';
  }
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return isToolDoc(String(input.file_path || '')) ? 'tool' : 'write';
  if (name === 'Read' || name === 'Grep' || name === 'Glob' || name === 'LS') return isToolDoc(String(input.file_path || input.path || input.pattern || '')) ? 'tool' : 'explore';
  return 'shell';
}

function summarise(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const seen = new Set();
  const tok = { main: { in: 0, cacheW: 0, cacheR: 0, out: 0 }, sub: { in: 0, cacheW: 0, cacheR: 0, out: 0 } };
  const calls = new Map();
  const by = Object.fromEntries(KINDS.map((k) => [k, { calls: 0, chars: 0 }]));
  const big = [];
  let result = null; let mainMsgs = 0; let subMsgs = 0;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'result') result = o;
    const sub = Boolean(o.parent_tool_use_id);
    const msg = o.message || {};
    if (o.type === 'assistant' && msg.id && !seen.has(msg.id)) {
      seen.add(msg.id);
      if (sub) subMsgs += 1; else mainMsgs += 1;
      const u = msg.usage || {};
      const t = tok[sub ? 'sub' : 'main'];
      t.in += u.input_tokens || 0; t.cacheW += u.cache_creation_input_tokens || 0; t.cacheR += u.cache_read_input_tokens || 0; t.out += u.output_tokens || 0;
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type === 'tool_use') {
        const k = kindOf(b.name, b.input || {});
        by[k].calls += 1;
        const input = b.input || {};
        calls.set(b.id, { k, name: b.name, what: String(input.command || input.file_path || input.pattern || input.description || '').replace(/\s+/g, ' ').slice(0, 90), sub });
      }
      if (b.type === 'tool_result') {
        const c = calls.get(b.tool_use_id);
        const text = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '');
        if (c) { by[c.k].chars += text.length; big.push({ chars: text.length, ...c }); }
      }
    }
  }
  return { tok, by, big, result, mainMsgs, subMsgs };
}

const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const totalIn = (t) => t.in + t.cacheW + t.cacheR;

function line(label, s) {
  const r = s.result || {};
  const secs = r.duration_ms ? Math.round(r.duration_ms / 1000) : '?';
  const api = r.duration_api_ms ? Math.round(r.duration_api_ms / 1000) : '?';
  const models = r.modelUsage ? Object.keys(r.modelUsage).map((m) => m.replace(/^claude-/, '')).join('+') : '?';
  return `${label.padEnd(16)} ${String(secs).padStart(5)}s (model ${String(api).padStart(4)}s)  turns ${String(r.num_turns ?? '?').padStart(3)}  msgs ${mainMsgs(s)}  in ${fmtK(totalIn(s.tok.main) + totalIn(s.tok.sub)).padStart(6)} (cached ${pct(s.tok)})  out ${fmtK(s.tok.main.out + s.tok.sub.out).padStart(5)}  in-subagents ${fmtK(totalIn(s.tok.sub) + s.tok.sub.out).padStart(6)}  cost ${r.total_cost_usd == null ? 'n/a' : r.total_cost_usd.toFixed(2)}  models ${models}`;
}
const mainMsgs = (s) => `${s.mainMsgs}+${s.subMsgs}`.padStart(7);
const pct = (t) => { const all = totalIn(t.main) + totalIn(t.sub); return all ? `${Math.round(((t.main.cacheR + t.sub.cacheR) / all) * 100)}%` : '-'; };

function merge(list) {
  const m = { tok: { main: { in: 0, cacheW: 0, cacheR: 0, out: 0 }, sub: { in: 0, cacheW: 0, cacheR: 0, out: 0 } }, by: Object.fromEntries(KINDS.map((k) => [k, { calls: 0, chars: 0 }])), big: [], result: { duration_ms: 0, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0, modelUsage: {} }, mainMsgs: 0, subMsgs: 0 };
  for (const s of list) {
    for (const w of ['main', 'sub']) for (const f of ['in', 'cacheW', 'cacheR', 'out']) m.tok[w][f] += s.tok[w][f];
    for (const k of KINDS) { m.by[k].calls += s.by[k].calls; m.by[k].chars += s.by[k].chars; }
    m.big.push(...s.big); m.mainMsgs += s.mainMsgs; m.subMsgs += s.subMsgs;
    const r = s.result || {};
    m.result.duration_ms += r.duration_ms || 0; m.result.duration_api_ms += r.duration_api_ms || 0; m.result.num_turns += r.num_turns || 0;
    m.result.total_cost_usd = r.total_cost_usd == null || m.result.total_cost_usd == null ? null : m.result.total_cost_usd + r.total_cost_usd;
    Object.assign(m.result.modelUsage, r.modelUsage || {});
  }
  return m;
}

const dirs = process.argv.slice(2);
if (!dirs.length) { process.stderr.write('usage: efficiency.js <run dir> [<run dir> ...]\n'); process.exit(1); }
const runs = [];
for (const d of dirs) {
  const sess = ['s1', 's2', 's3'].filter((s) => fs.existsSync(path.join(d, s, 'transcript.jsonl')));
  const parts = sess.length ? sess.map((s) => ({ label: s, s: summarise(path.join(d, s, 'transcript.jsonl')) }))
    : fs.existsSync(path.join(d, 'transcript.jsonl')) ? [{ label: 'run', s: summarise(path.join(d, 'transcript.jsonl')) }] : [];
  if (!parts.length) { process.stdout.write(`${d}: no transcript\n`); continue; }
  runs.push({ name: path.basename(path.resolve(d)), parts, total: merge(parts.map((p) => p.s)) });
}
process.stdout.write('time = wall seconds (model = seconds waiting for the model); msgs = main+subagent; in = input tokens incl. cache\n\n');
for (const r of runs) {
  if (r.parts.length > 1) for (const p of r.parts) process.stdout.write(`${line(`${r.name.slice(-12)} ${p.label}`, p.s)}\n`);
  process.stdout.write(`${line(`${r.name.slice(-12)} ALL`, r.total)}\n`);
}
process.stdout.write('\nwork by kind: calls / chars of output fed back to the model\n');
process.stdout.write(`${'run'.padEnd(16)} ${KINDS.map((k) => k.padStart(15)).join('')}\n`);
for (const r of runs) process.stdout.write(`${r.name.slice(-16).padEnd(16)} ${KINDS.map((k) => `${r.total.by[k].calls}/${fmtK(r.total.by[k].chars)}`.padStart(15)).join('')}\n`);
for (const r of runs) {
  process.stdout.write(`\nlargest outputs in ${r.name}:\n`);
  for (const b of r.total.big.sort((a, c) => c.chars - a.chars).slice(0, 6)) process.stdout.write(`  ${fmtK(b.chars).padStart(5)}  ${b.sub ? 'sub ' : 'main'} ${b.k.padEnd(8)} ${b.name}: ${b.what}\n`);
}
