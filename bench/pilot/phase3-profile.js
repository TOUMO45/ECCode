'use strict';
// Cost and time breakdown of an ECCode engine run (Phase 3, Part F). Reads the
// `record/` directory a bench run saved under its transcript (--transcripts):
// the event log plus the agent's own cost line. It attributes wall-clock to
// phases (design, plan, implement, each check run, each review round, behavior
// diff, guards) from the command-evidence durations and the gate/review
// timestamps, and names the top sinks.
//   node bench/pilot/phase3-profile.js <transcripts dir> [<transcripts dir> ...]
const fs = require('fs');
const path = require('path');

function records(dir) {
  const out = [];
  for (const sandbox of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const rec = path.join(dir, sandbox, 'record', 'events.jsonl');
    if (fs.existsSync(rec)) out.push({ sandbox, events: fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) });
  }
  return out;
}

// A command-evidence label -> the phase it belongs to.
function phaseOf(label) {
  const l = String(label || '').toLowerCase();
  if (/baseline|repro/.test(l)) return 'lab: reproduce/baseline';
  if (/hypothesis|trace|localize|sbfl|bisect/.test(l)) return 'lab: hypotheses';
  if (/mutat/.test(l)) return 'mutation';
  if (/fix.?verify|regression/.test(l)) return 'fix verify';
  if (/behavior|probe|corpus|candidate/.test(l)) return 'behavior diff';
  if (/migration|guard|perf|race|security|openapi|schema/.test(l)) return 'production guards';
  return 'other checks (verification, stack)';
}

function profile(rec) {
  const ev = rec.events;
  const cmds = ev.filter((e) => e.type === 'evidence.recorded' && e.data && e.data.kind === 'command');
  const byPhase = {};
  for (const c of cmds) {
    const p = phaseOf(c.data.label);
    byPhase[p] = byPhase[p] || { ms: 0, runs: 0 };
    byPhase[p].ms += c.data.durationMs || 0;
    byPhase[p].runs += 1;
  }
  // Review rounds: review.recorded and review.rejected.
  const reviews = ev.filter((e) => e.type === 'review.recorded' || e.type === 'review.rejected').length;
  const rejects = ev.filter((e) => e.type === 'review.rejected').length;
  const t0 = ev[0] && Date.parse(ev[0].ts);
  const tN = ev.length && Date.parse(ev[ev.length - 1].ts);
  const spanMin = t0 && tN ? (tN - t0) / 60000 : null;
  const checkMs = cmds.reduce((s, c) => s + (c.data.durationMs || 0), 0);
  return { sandbox: rec.sandbox, events: ev.length, reviewRounds: reviews, reviewRejects: rejects, checkRuns: cmds.length, checkMinutes: Math.round(checkMs / 600) / 100, recordSpanMinutes: spanMin ? Math.round(spanMin * 10) / 10 : null, byPhase };
}

function aggregate(profiles) {
  const phase = {};
  for (const p of profiles) for (const [k, v] of Object.entries(p.byPhase)) {
    phase[k] = phase[k] || { ms: 0, runs: 0 };
    phase[k].ms += v.ms; phase[k].runs += v.runs;
  }
  const rows = Object.entries(phase).map(([k, v]) => ({ phase: k, minutes: Math.round(v.ms / 600) / 100, runs: v.runs })).sort((a, b) => b.minutes - a.minutes);
  const totalCheckMin = rows.reduce((s, r) => s + r.minutes, 0);
  return { runs: profiles.length, phases: rows, totalCheckMinutes: Math.round(totalCheckMin * 10) / 10, topSinks: rows.slice(0, 3) };
}

if (require.main === module) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { process.stderr.write('usage: phase3-profile.js <transcripts dir> [...]\n'); process.exit(2); }
  const profiles = dirs.flatMap(records).map(profile);
  const agg = aggregate(profiles);
  process.stdout.write(`${agg.runs} engine run(s); ${agg.totalCheckMinutes} min in recorded checks total.\nPhase breakdown (summed over runs):\n`);
  for (const r of agg.phases) process.stdout.write(`  ${r.minutes.toString().padStart(7)} min  ${r.runs.toString().padStart(3)} runs  ${r.phase}\n`);
  process.stdout.write(`Top 3 sinks: ${agg.topSinks.map((r) => `${r.phase} (${r.minutes} min)`).join('; ')}\n`);
  for (const p of profiles) process.stdout.write(`  run ${p.sandbox.slice(-6)}: span ${p.recordSpanMinutes} min, ${p.checkRuns} checks ${p.checkMinutes} min, ${p.reviewRounds} review(s) (${p.reviewRejects} rejected)\n`);
}

module.exports = { records, profile, aggregate, phaseOf };
