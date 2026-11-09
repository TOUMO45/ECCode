'use strict';
// S3 metering wrapper over lib/greenfield/usage.js (the reader does the summing; this adds only arithmetic and the
// owner's Patch-2 figures). usage: node snap2.js <label> [outfile]
//   - all-processed tokens (the registered cap unit), DELTA from the S3.1 start probe (00-probe-pre-venv.json)
//   - IEQ = input + 0.1*cache_read + 1.25*cache_write + 5*output  ("ratio estimate": published pricing RATIOS, not money)
//   - latest assistant message cache-read (clean-context test: must be <= 250,000)
//   - step delta vs the previous snapshot in the chain (snaps/index.json)
const fs = require('fs');
const path = require('path');
const usage = require('/home/user/ECCode/lib/greenfield/usage.js');

const SESSION = 'e8a4d473-3ba2-5f70-9aa2-c7d0de786fa3';
const ROOT = '/home/user/ECCode';
const SNAPS = '/tmp/claude-0/-home-user-ECCode/e8a4d473-3ba2-5f70-9aa2-c7d0de786fa3/scratchpad/snaps';
const START_FILE = path.join(SNAPS, '00-start.json');
const CAP = 8_000_000, PAUSE = 6_000_000, CLEAN_LIMIT = 250_000;

const ieq = (t) => t.input + 0.1 * t.cacheRead + 1.25 * t.cacheWrite + 5 * t.output;
const label = process.argv[2] || 'unlabelled';
const out = process.argv[3];

const u = usage.sessionUsage(ROOT, SESSION);
const parts = [u.session, ...u.agents].filter(Boolean);
const sum = (k) => parts.reduce((a, p) => a + p[k], 0);
const total = { input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output'), messages: sum('messages') };
total.allProcessed = total.input + total.cacheRead + total.cacheWrite + total.output;
total.ieq = Math.round(ieq(total) * 10) / 10;

// latest distinct assistant message in the MAIN transcript (read-only parse; the reader does not expose per-message)
let latest = null;
try {
  const seen = new Set();
  for (const line of fs.readFileSync(path.join(usage.transcriptDir(ROOT), `${SESSION}.jsonl`), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    const id = o.message.id || o.uuid; if (!id) continue;
    seen.add(id);
    latest = { id, cacheRead: o.message.usage.cache_read_input_tokens || 0, input: o.message.usage.input_tokens || 0,
      cacheWrite: o.message.usage.cache_creation_input_tokens || 0, output: o.message.usage.output_tokens || 0, timestamp: o.timestamp };
  }
} catch { latest = null; }

let start; try { start = JSON.parse(fs.readFileSync(START_FILE, 'utf8')).total; } catch { start = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, messages: 0, allProcessed: 0 }; } // fresh session: zero baseline
start.ieq = Math.round(ieq(start) * 10) / 10;
const idxFile = path.join(SNAPS, 'index.json');
let chain = []; try { chain = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch { chain = []; }
const prev = chain.length ? chain[chain.length - 1] : { label: 'S4-plan session start (zero baseline)', total: start };

const d = (a, b) => ({ allProcessed: a.allProcessed - b.allProcessed, input: a.input - b.input, cacheRead: a.cacheRead - b.cacheRead,
  cacheWrite: a.cacheWrite - b.cacheWrite, output: a.output - b.output, ieq: Math.round((a.ieq - b.ieq) * 10) / 10, messages: a.messages - b.messages });
const sinceStart = d(total, start);
const snap = {
  label, takenAt: new Date().toISOString(), source: u.source, unit: 'all-processed-tokens (cap unit) + IEQ (ratio estimate)',
  total,
  mainMessages: u.session ? u.session.messages : 0,
  subagentTranscripts: u.agents.map((p) => ({ file: path.basename(p.file), messages: p.messages, allProcessed: p.allProcessed, input: p.input, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite, output: p.output })),
  sinceS4Start: sinceStart,
  capPercentUsed: Math.round((sinceStart.allProcessed / CAP) * 10000) / 100,
  pauseAt6M: sinceStart.allProcessed >= PAUSE ? 'PAUSE-NOW' : 'below',
  hardStop8M: sinceStart.allProcessed >= CAP ? 'HARD-STOP' : 'below',
  stepDeltaFrom: prev.label, stepDelta: d(total, prev.total),
  cleanContextTest: latest ? { latestMessageCacheRead: latest.cacheRead, limit: CLEAN_LIMIT, result: latest.cacheRead <= CLEAN_LIMIT ? 'PASS' : 'ABOVE-250K', messageTimestamp: latest.timestamp } : 'unmeasurable',
  dollarEstimate: 'none (no official price page fetched); IEQ is a ratio estimate only',
};
const text = JSON.stringify(snap, null, 2);
if (out) {
  fs.writeFileSync(out, text + '\n');
  chain.push({ label, file: path.basename(out), takenAt: snap.takenAt, total });
  fs.writeFileSync(idxFile, JSON.stringify(chain, null, 2) + '\n');
}
// compact console summary
const f = (n) => n.toLocaleString('en-US');
console.log(`${label} @ ${snap.takenAt}`);
console.log(`  total: all-processed ${f(total.allProcessed)} | IEQ ${f(total.ieq)} | msgs ${total.messages} (in ${f(total.input)}, cacheRead ${f(total.cacheRead)}, cacheWrite ${f(total.cacheWrite)}, out ${f(total.output)})`);
console.log(`  since S4-plan start: all-processed ${f(sinceStart.allProcessed)} (${snap.capPercentUsed}% of cap; pause@6M ${snap.pauseAt6M}; hard@8M ${snap.hardStop8M}) | IEQ ${f(sinceStart.ieq)}`);
console.log(`  step delta vs "${prev.label}": all-processed ${f(snap.stepDelta.allProcessed)} | IEQ ${f(snap.stepDelta.ieq)} | msgs ${snap.stepDelta.messages}`);
console.log(`  subagent transcripts: ${snap.subagentTranscripts.length}`);
console.log(`  clean-context: ${JSON.stringify(snap.cleanContextTest)}`);
