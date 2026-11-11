#!/usr/bin/env node
'use strict';
// S4 plan P-4 (bare-arm side): count human interventions from a Claude Code session transcript, and compare the
// count with the operator's own log (continuation criterion C5: automatic count = manual log).
//
//   node tools/count-transcript-interventions.js <session.jsonl> [--log <operator-log.jsonl>]   -> JSON on stdout
//
// Rules (plan 6.1 and addendum 3 section 3):
// - the first typed prompt is the master prompt and is not counted;
// - each later typed prompt is one intervention. The operator may send only two texts (plan 6.1 decision table):
//   the fixed clarification answer and the fixed unblock line. Any other text is a `correction` and a deviation;
// - a restart leaves no typed prompt, so it is taken from the operator log;
// - arm a has no approver: M4-A3 equals M4-6.1, and a ceiling stop counts as none (interpretation I-2, confirmed
//   by the owner on 2026-11-11).
// Tool results, subagent traffic, meta records and harness notices are not typed prompts.
const fs = require('fs');
const crypto = require('crypto');

const KINDS = ['approval', 'clarification-answer', 'correction', 'restart', 'unblock'];
const FIXED = {
  'I have no further information. Use your best judgement and continue.': 'clarification-answer',
  'Continue until the product is complete.': 'unblock',
};
const HARNESS = ['<task-notification', '<system-reminder', 'Stop hook feedback', 'Caveat:', '<local-command', '[Request interrupted',
  '<command-stdout', '<command-name', 'This session is being continued from a previous conversation', 'Your response above was'];

function typedText(rec) {
  if (!rec || rec.type !== 'user' || rec.isMeta || rec.isSidechain || rec.toolUseResult !== undefined) return null;
  const content = rec.message && rec.message.content;
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return null;
    text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  } else return null;
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) return null;
  if (rec.origin && rec.origin.kind) return rec.origin.kind === 'human' ? text : null;
  return HARNESS.some((p) => text.startsWith(p)) ? null : text;
}

function readJsonl(file) {
  const out = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { records: out, bad };
}

/** Count from transcript records, and operator-log entries ({type, at, note}) when given. */
function count(records, operatorLog) {
  const counted = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const items = [];
  const deviations = [];
  const prompts = records.map((rec) => ({ rec, text: typedText(rec) })).filter((p) => p.text !== null);
  const first = prompts[0];
  for (const p of prompts.slice(1)) {
    const kind = FIXED[p.text] || 'correction';
    counted[kind] += 1;
    items.push({ at: p.rec.timestamp || null, kind, source: 'transcript' });
    if (kind === 'correction') {
      deviations.push({ at: p.rec.timestamp || null, reason: 'a text outside the operator decision table was sent to the arm',
        sha256: crypto.createHash('sha256').update(p.text).digest('hex'), length: p.text.length });
    }
  }
  const fromTranscript = { ...counted };
  let agreement = null;
  if (operatorLog) {
    const logged = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const e of operatorLog) {
      if (!e || !KINDS.includes(e.type)) { deviations.push({ at: (e && e.at) || null, reason: `operator log entry with unknown type ${JSON.stringify(e && e.type)}` }); continue; }
      logged[e.type] += 1;
    }
    // what a transcript can show must match the log; what it cannot show (restart, approval) is taken from the log
    const comparable = ['clarification-answer', 'unblock', 'correction'];
    const differences = comparable.filter((k) => logged[k] !== fromTranscript[k]).map((k) => ({ kind: k, transcript: fromTranscript[k], operatorLog: logged[k] }));
    for (const k of ['restart', 'approval']) {
      counted[k] += logged[k];
      for (let i = 0; i < logged[k]; i += 1) items.push({ at: null, kind: k, source: 'operator-log' });
    }
    agreement = { agrees: differences.length === 0, differences, operatorLog: logged };
  }
  const total = Object.values(counted).reduce((a, b) => a + b, 0);
  return {
    masterPrompt: first ? { sha256: crypto.createHash('sha256').update(first.text).digest('hex'), bytes: Buffer.byteLength(first.text) } : null,
    typedPrompts: prompts.length, counted, total,
    methods: { 'M4-A3': total, 'M4-6.1': total }, // arm a: no approver, so the two methods are equal (I-2)
    agreement, deviations, items,
  };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--log');
  const logAt = argv.indexOf('--log');
  if (!file) { process.stderr.write('usage: count-transcript-interventions.js <session.jsonl> [--log <operator-log.jsonl>]\n'); return 1; }
  const t = readJsonl(file);
  const log = logAt >= 0 ? readJsonl(argv[logAt + 1]).records : undefined;
  const out = count(t.records, log);
  process.stdout.write(`${JSON.stringify({ file, records: t.records.length, unparsedLines: t.bad, ...out }, null, 2)}\n`);
  return out.agreement && !out.agreement.agrees ? 2 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { count, typedText, FIXED, KINDS };
