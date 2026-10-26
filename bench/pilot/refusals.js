'use strict';
// Every refusal an agent met in its Claude Code transcripts, for labelling:
//   eccode  an eccode command that failed with an ECCode error code
//           ("eccode: [CODE] message"), the engine refusing a step;
//   denial  a tool call Claude Code itself refused (a permission rule, a hook,
//           or a command too complex to approve), with its stated source.
// A failing test or any other failing command is not a refusal. Each entry
// carries the command, so a reader can judge whether the refusal was right.
// CLI: node bench/pilot/refusals.js <dir>   (every *.jsonl under dir) > refusals.json
const fs = require('fs');
const path = require('path');

const CODE = /eccode: \[([A-Z_]+)\] ([^\n]*)/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
  return '';
}

/** Refusals in one transcript file's text; ids are `<session>:<line>` (1-based). */
function extractRefusals(jsonlText, session) {
  const rows = String(jsonlText).split('\n').map((l, i) => {
    try {
      return { line: i + 1, ev: JSON.parse(l) };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const commands = new Map();
  for (const { ev } of rows) {
    for (const c of (ev.message && Array.isArray(ev.message.content) ? ev.message.content : [])) {
      if (c.type === 'tool_use') commands.set(c.id, (c.input && (c.input.command || c.input.file_path)) || c.name);
    }
  }
  const out = [];
  // Claude Code also writes api-request-blob events that repeat tool results
  // already in the transcript: a refused tool call counts once, where it first appears.
  const seen = new Set();
  for (const { line, ev } of rows) {
    for (const c of (ev.message && Array.isArray(ev.message.content) ? ev.message.content : [])) {
      if (c.type !== 'tool_result' || !c.is_error) continue;
      if (c.tool_use_id && seen.has(c.tool_use_id)) continue;
      if (c.tool_use_id) seen.add(c.tool_use_id);
      const text = textOf(c.content);
      const command = commands.get(c.tool_use_id) || null;
      const m = text.match(CODE);
      if (m) out.push({ id: `${session}:${line}`, kind: 'eccode', code: m[1], message: m[2].trim(), command });
      else if (ev.toolDenialKind || (ev.permissionDecision && !['accept', 'allow'].includes(ev.permissionDecision.decision))) {
        const d = ev.permissionDecision || {};
        const code = [d.source || ev.toolDenialKind, d.reasonCode || (d.source ? d.decision || ev.toolDenialKind : null)].filter(Boolean).join(':');
        out.push({ id: `${session}:${line}`, kind: 'denial', code, message: text.split('\n')[0].slice(0, 300), command });
      }
    }
  }
  return out;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : []));
}

module.exports = { extractRefusals };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: node bench/pilot/refusals.js <transcripts dir>\n');
    process.exit(2);
  }
  const all = walk(dir).flatMap((f) => extractRefusals(fs.readFileSync(f, 'utf8'), path.relative(dir, f).replace(/\.jsonl$/, '')));
  process.stdout.write(JSON.stringify(all, null, 1) + '\n');
}
