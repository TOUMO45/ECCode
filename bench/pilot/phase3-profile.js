'use strict';
// Cost and time breakdown of ECCode engine runs (Phase 3, Part F; the time
// profile of the narrowed runs). Two sources:
//   - transcript directories a bench run saved with --transcripts, each with a
//     `record/events.jsonl` (the run's event log);
//   - run records (one JSON per line, `--records <runs.jsonl>`), whose
//     `profile` field the bench writes for every engine run since 2026-11-01,
//     so a profile survives the transcripts and the machine.
// The profiler itself is lib/profile.js: wall-clock minutes per phase (design,
// plan, lab, implement, review, guards, orchestrator between dispatches), the
// executed checks binned by what they were for (lab: reproduce/baseline, lab:
// hypotheses, fix verify, mutation, scoped checks, full claim run, reviewer
// re-run, behavior diff, production guards), agent time with no command
// running per phase, and the top three sinks.
//   node bench/pilot/phase3-profile.js <transcripts dir> [<transcripts dir> ...]
//   node bench/pilot/phase3-profile.js --records <runs.jsonl> [...]
const fs = require('fs');
const path = require('path');
const prof = require('../../lib/profile');

function records(dir) {
  const out = [];
  for (const sandbox of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const rec = path.join(dir, sandbox, 'record', 'events.jsonl');
    if (fs.existsSync(rec)) out.push({ sandbox, events: prof.readEvents(rec) });
  }
  return out;
}

/** The profiles the run records of a --save file carry (engine runs only). */
function fromRecords(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => !r.type && r.profile).map((r) => ({ sandbox: (r.transcripts && r.transcripts.dir) || `${r.task}-${r.variant}`, profile: r.profile }));
}

// Kept for the Part F report's first profile: a command-evidence label -> its phase.
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
  return { sandbox: rec.sandbox, profile: prof.profile(rec.events) };
}

function aggregate(profiles) {
  return prof.aggregate(profiles.map((p) => p.profile));
}

function print(profiles) {
  const agg = aggregate(profiles);
  process.stdout.write(`${agg.runs} engine run(s); ${agg.spanMinutes} min of record span, ${agg.checkMinutes} min in executed checks; ${agg.reviews} review(s), ${agg.rejections} rejected.\n`);
  process.stdout.write(`${prof.table(agg)}\n`);
  process.stdout.write(`Top 3 sinks: ${agg.topSinks.map((s) => `${s.sink} ${s.minutes} min${s.runs ? ` over ${s.runs} runs` : ''}`).join('; ')}\n`);
  for (const p of profiles) {
    const q = p.profile;
    if (!q) continue;
    const top = Object.entries(q.wall).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ');
    process.stdout.write(`  run ${p.sandbox.slice(-6)}: span ${q.spanMinutes} min, checks ${q.checkMinutes} min, ${q.dispatches} dispatch(es), ${q.reviews} review(s) (${q.rejections} rejected), ${q.delivered ? 'delivered' : 'not delivered'}; top phases: ${top}\n`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) { process.stderr.write('usage: phase3-profile.js <transcripts dir> [...] | --records <runs.jsonl> [...]\n'); process.exit(2); }
  const profiles = args[0] === '--records' ? args.slice(1).flatMap(fromRecords) : args.flatMap(records).map(profile);
  print(profiles);
}

module.exports = { records, fromRecords, profile, aggregate, phaseOf };
