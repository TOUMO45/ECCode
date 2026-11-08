'use strict';
// P0 of S2.4 (the owner's decision of 2026-11-08): a READ-ONLY reader of the harness's own usage record. Claude Code
// writes each session's transcript to ~/.claude/projects/<slug>/<sessionId>.jsonl, where every assistant message carries
// `message.usage` (input, cache creation, cache read and output tokens) and `message.model`, and a `cost-state` line
// carries the harness's running totals (`totalCostUSD`, `modelUsage` per model). Subagent transcripts, when the harness
// writes them beside the session's file, are read the same way and reported per file. The reader changes nothing and
// enforces nothing (GF-COST-1 is S4a); it gives the figures the accounting protocol (design 18.6) asked the harness for.
//
// Reliability, as measured on 2026-11-08 (docs/build/gf-s2-4-evidence.md): the per-message usage is present on every
// assistant line, repeated on the several lines a streamed message produces (deduplicated here by message id); the
// cost-state line is written by the harness at its own cadence (one line seen in a 680-line transcript), so its
// totals can lag the messages; a transcript that is not there, or that holds no assistant line, is `unmeasurable`.
const fs = require('fs');
const os = require('os');
const path = require('path');

const UNMEASURABLE = 'unmeasurable';

/** The directory the harness uses for a project's transcripts: the project path with every separator turned into `-`. */
function transcriptDir(root, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', path.resolve(root).replace(/[\\/]/g, '-'));
}

const num = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** Sum the usage of one transcript file. Returns null when the file cannot be read. */
function readTranscript(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const seen = new Set();
  const perModel = {};
  let messages = 0;
  let costState = null;
  let first = null;
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // a torn or foreign line is skipped, not counted
    if (o && o.type === 'cost-state') { costState = o; continue; }
    if (!o || o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    const id = o.message.id || o.uuid;
    if (!id || seen.has(id)) continue; // a streamed message is written on several lines with the same usage
    seen.add(id);
    const u = o.message.usage;
    const model = o.message.model || 'unknown';
    const m = perModel[model] || (perModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
    m.input += num(u.input_tokens); m.output += num(u.output_tokens);
    m.cacheRead += num(u.cache_read_input_tokens); m.cacheWrite += num(u.cache_creation_input_tokens);
    m.messages += 1; messages += 1;
    if (o.timestamp) { first = first || o.timestamp; last = o.timestamp; }
  }
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of Object.values(perModel)) for (const k of Object.keys(total)) total[k] += m[k];
  const allProcessed = total.input + total.output + total.cacheRead + total.cacheWrite;
  return {
    file,
    messages,
    allProcessed: messages ? allProcessed : UNMEASURABLE,
    ...total,
    perModel,
    costUSD: costState && typeof costState.totalCostUSD === 'number' ? costState.totalCostUSD : UNMEASURABLE,
    costState: costState ? { totalCostUSD: costState.totalCostUSD, totalDuration: costState.totalDuration, startTime: costState.startTime, modelUsage: costState.modelUsage || {} } : null,
    first,
    last,
  };
}

/** Subagent transcripts the harness keeps beside a session's file (several layouts have existed; each is tried). */
function agentFiles(dir, sessionId) {
  const out = [];
  const candidates = [path.join(dir, sessionId, 'subagents'), path.join(dir, sessionId)];
  for (const d of candidates) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) if (n.endsWith('.jsonl') && n !== `${sessionId}.jsonl`) out.push(path.join(d, n));
  }
  return out.sort();
}

/**
 * The usage of one session: its own transcript plus every subagent transcript found beside it, each summed on its own
 * and all together. A figure the harness did not write is `unmeasurable`, never a blank or an estimate.
 */
function sessionUsage(root, sessionId, { home } = {}) {
  const dir = transcriptDir(root, home);
  const main = readTranscript(path.join(dir, `${sessionId}.jsonl`));
  const agents = agentFiles(dir, sessionId).map(readTranscript).filter(Boolean);
  const parts = [main, ...agents].filter(Boolean);
  const sum = (k) => parts.reduce((a, p) => a + (typeof p[k] === 'number' ? p[k] : 0), 0);
  const measured = parts.some((p) => p.messages > 0);
  return {
    unit: 'all-processed-tokens',
    source: `${dir}/${sessionId}.jsonl${agents.length ? ` plus ${agents.length} subagent transcript(s)` : ''}`,
    sessionId,
    session: main,
    agents,
    allProcessed: measured ? sum('input') + sum('output') + sum('cacheRead') + sum('cacheWrite') : UNMEASURABLE,
    output: measured ? sum('output') : UNMEASURABLE,
    costUSD: main && typeof main.costUSD === 'number' ? main.costUSD : UNMEASURABLE,
  };
}

/** The sessions of a project, newest first, by the transcript files that exist. */
function listSessions(root, { home } = {}) {
  const dir = transcriptDir(root, home);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => ({ sessionId: n.slice(0, -6), file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
}

/**
 * The difference of two snapshots under the accounting protocol (18.6): a number only when both are numbers and the
 * end is not below the start; a stale end (identical to the start while messages were added) is `unmeasurable`.
 */
function difference(start, end) {
  if (!start || !end || typeof start.allProcessed !== 'number' || typeof end.allProcessed !== 'number') return UNMEASURABLE;
  if (end.allProcessed < start.allProcessed) return UNMEASURABLE; // a counter reset
  return end.allProcessed - start.allProcessed;
}

module.exports = { UNMEASURABLE, transcriptDir, readTranscript, sessionUsage, listSessions, difference };
