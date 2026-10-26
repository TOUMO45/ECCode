#!/usr/bin/env node
'use strict';
// Parts B and C of the Mealie pilot: the pre-registered criteria (protocol
// bench/protocols/2026-10-24-mealie-pilot.md, "Outcomes and criteria")
// computed from the saved runs (b1..b4, c1, c2 .jsonl), the copies of the
// engine records and transcripts kept next to them, and the refusal labels.
// usage: node analyse.js --runs <dir> [--labels bench/pilot/mealie/labels] [--greenfield planner|pantry]
//                        [--title "<report title>"] [--out report.md] [--json out.json]
// --greenfield names the Part C suite the runs used (its tasks <name>-c1..c3):
// the pilot's planner by default, the rerun's pantry.
const fs = require('fs');
const path = require('path');
const bench = require('../../lib/bench');
const { extractRefusals } = require('./refusals');

const PROCESSES = ['b1', 'b2', 'b3', 'b4', 'c1', 'c2'];
const ENGINE = ['b1', 'b2', 'b4', 'c1'];

/** The gates approved during the first work item of a record, in the order of their first approval. */
function gateOrder(events) {
  const order = [];
  for (const ev of events) {
    if (ev.type === 'work.started') break;
    const d = ev.data || {};
    if (ev.type === 'review.recorded' && d.review && d.review.decision === 'approve' && !order.includes(d.gate)) order.push(d.gate);
  }
  return order;
}

/** Architecture, design, plan, one or more phases, verification — nothing else, in that order. */
function gatesInOrder(order) {
  return /^architecture,design,plan,(phase:[^,]+,)+verification$/.test(order.join(','));
}

/** Migration files a patch adds, modifies or deletes (any path with a migration(s) directory). */
function migrationChange(patch) {
  const out = { added: [], modified: [], deleted: [] };
  for (const block of String(patch || '').split(/^diff --git /m).slice(1)) {
    const m = block.match(/^a\/(\S+) b\/(\S+)/);
    if (!m) continue;
    const file = m[2];
    if (!/(^|\/)migrations?\//i.test(file)) continue;
    if (/^new file mode/m.test(block)) out.added.push(file);
    else if (/^deleted file mode/m.test(block)) out.deleted.push(file);
    else out.modified.push(file);
  }
  return out;
}

const deliveredClean = (r) => Boolean(r.engine && r.engine.delivered && r.engine.auditOk);
const auditFailure = (r) => Boolean(r.engine && r.engine.initialized && !r.engine.auditOk);
const passedAll = (r) => r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal;

/** Share of engine records delivered with a clean audit. */
function deliveredShare(records) {
  return records.length ? records.filter(deliveredClean).length / records.length : null;
}

/** Text of every tool result in a transcript (JSONL), joined. */
function toolResultText(jsonl) {
  const out = [];
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const c of content) {
      if (c.type !== 'tool_result') continue;
      if (typeof c.content === 'string') out.push(c.content);
      else if (Array.isArray(c.content)) for (const p of c.content) if (p && typeof p.text === 'string') out.push(p.text);
    }
  }
  return out.join('\n');
}

/**
 * Whether a lesson recorded in one item was surfaced in a later one: items are
 * [{lessons: <ids or titles the record lists after the item>, toolText}], in
 * chain order. A lesson is recorded in the first item whose list holds it.
 */
function lessonsSurfaced(items) {
  const seenAt = new Map();
  items.forEach((it, i) => {
    for (const l of it.lessons || []) if (!seenAt.has(l)) seenAt.set(l, i);
  });
  const hits = [];
  for (const [lesson, i] of seenAt) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].toolText && items[j].toolText.includes(lesson)) {
        hits.push({ lesson, recordedIn: i, surfacedIn: j });
        break;
      }
    }
  }
  return { recorded: seenAt.size, surfaced: hits };
}

function median(xs) {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function readRuns(dir) {
  const out = {};
  for (const p of PROCESSES) {
    const f = path.join(dir, `${p}.jsonl`);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    out[p] = { records: bench.loadRuns(text), summaries: lines.filter((l) => l.type === 'chain-summary'), stopped: lines.filter((l) => l.type === 'stopped') };
  }
  return out;
}

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

/** The transcripts and record copy of one record, from its transcripts dir. */
function runFiles(runsDir, proc, r) {
  const t = (r.chain && r.chain.transcripts) || r.transcripts;
  if (!t) return { dir: null, sessions: [], record: null };
  const dir = path.join(runsDir, `tr-${proc}`, t.dir);
  const files = walk(dir);
  const sessions = files.filter((f) => f.endsWith('.jsonl') && !f.includes(`${path.sep}record${path.sep}`));
  const events = path.join(dir, 'record', 'events.jsonl');
  return { dir, sessions, record: fs.existsSync(events) ? path.join(dir, 'record') : null };
}

function readEvents(recordDir) {
  if (!recordDir) return [];
  return fs.readFileSync(path.join(recordDir, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/**
 * Amendment (2026-10-24, during the batch, before any label or figure): every
 * benchmark session inherited the operator's Claude Code session id, so the
 * items of a chain (one sandbox) appended to one transcript file and item k's
 * copy held the lines of items 1..k. An item counts only the lines it added:
 * the leading lines an earlier item's copy of the same file already held.
 */
function ownOffset(text, prevText) {
  if (!prevText || !String(text).startsWith(prevText)) return 0;
  const n = (prevText.match(/\n/g) || []).length;
  return prevText.endsWith('\n') ? n : n + 1;
}

/** The lines of one session file that an earlier item of the same chain already held. */
function sessionOffset(runsDir, proc, r, dir, file, text) {
  if (!r.chain || !r.chain.transcripts || !(r.chain.index > 0)) return 0;
  const own = `-${r.chain.index + 1}-${r.task}`;
  if (!r.chain.transcripts.dir.endsWith(own)) return 0;
  const base = r.chain.transcripts.dir.slice(0, -own.length);
  const root = path.join(runsDir, `tr-${proc}`);
  const names = fs.existsSync(root) ? fs.readdirSync(root) : [];
  for (let j = r.chain.index; j >= 1; j--) {
    const prevDir = names.find((n) => n.startsWith(`${base}-${j}-`));
    const prev = prevDir && path.join(root, prevDir, path.relative(dir, file));
    if (prev && fs.existsSync(prev)) {
      const off = ownOffset(text, fs.readFileSync(prev, 'utf8'));
      if (off) return off;
    }
  }
  return 0;
}

/** Every refusal in the engine-variant transcripts, with a stable id: <proc>/<transcript dir>/<file>:<line>. */
function allRefusals(runsDir, runs) {
  const out = [];
  for (const proc of ENGINE) {
    for (const r of (runs[proc] && runs[proc].records) || []) {
      const { dir, sessions } = runFiles(runsDir, proc, r);
      for (const s of sessions) {
        const session = `${proc}/${path.relative(path.join(runsDir, `tr-${proc}`), s).split(path.sep).join('/')}`;
        const text = fs.readFileSync(s, 'utf8');
        const off = sessionOffset(runsDir, proc, r, dir, s, text);
        for (const x of extractRefusals(text, session)) {
          if (Number(x.id.slice(x.id.lastIndexOf(':') + 1)) > off) out.push({ ...x, proc, task: r.task, dir: dir && path.basename(dir) });
        }
      }
    }
  }
  return out;
}

/** The tool-result text of one item's own transcript lines. */
function itemToolText(runsDir, proc, r) {
  const { dir, sessions } = runFiles(runsDir, proc, r);
  return sessions.map((s) => {
    const text = fs.readFileSync(s, 'utf8');
    return toolResultText(text.split('\n').slice(sessionOffset(runsDir, proc, r, dir, s, text)).join('\n'));
  }).join('\n');
}

function criteria(runsDir, runs, labels, { greenfield = 'planner' } = {}) {
  const rows = [];
  const add = (id, capability, measure, criterion, result, met, note = '') => rows.push({ id, capability, measure, criterion, result, met, note });
  const recs = (p) => (runs[p] && runs[p].records) || [];

  // Tracks (B): per chain, and no audit failure in any engine run.
  for (const p of ['b1', 'b2']) {
    const share = deliveredShare(recs(p));
    add(`tracks-${p}`, 'Tracks (B)', `chain ${p}: items delivered with a clean audit`, '≥ 80%', share === null ? null : `${recs(p).filter(deliveredClean).length}/${recs(p).length}`, share === null ? null : share >= 0.8);
  }
  const failures = ENGINE.flatMap((p) => recs(p).filter(auditFailure).map((r) => `${p}:${r.task}`));
  add('tracks-audit', 'Tracks (B)', 'engine runs whose record fails its audit', '0', String(failures.length), failures.length === 0, failures.join(', '));

  // Friction (B, C).
  const refusals = allRefusals(runsDir, runs);
  const refLabels = labels.refusals || {};
  const unlabelled = refusals.filter((x) => !refLabels[x.id]);
  const engineRuns = ENGINE.reduce((n, p) => n + recs(p).length, 0);
  const falseOnes = refusals.filter((x) => refLabels[x.id] && refLabels[x.id].label === 'false');
  add('friction', 'Friction (B, C)', 'false refusals per engine item run', '≤ 1', unlabelled.length || !engineRuns ? null : (falseOnes.length / engineRuns).toFixed(3), unlabelled.length || !engineRuns ? null : falseOnes.length / engineRuns <= 1, `${refusals.length} refusals in ${engineRuns} runs; ${unlabelled.length} unlabelled; ${falseOnes.length} false`);

  // Long-lived record (B), per chain.
  for (const p of ['b1', 'b2']) {
    const s = runs[p] && runs[p].summaries[0];
    const items = recs(p).map((r) => {
      const f = runFiles(runsDir, p, r);
      return { lessons: lessonIds(f.record, s), toolText: itemToolText(runsDir, p, r) };
    });
    const surfaced = lessonsSurfaced(items);
    const lat = s && s.latencyMs;
    const ok = s ? s.auditOk === true && lat && ['status', 'metrics', 'audit'].every((k) => lat[k] <= 2000) && surfaced.surfaced.length > 0 : null;
    add(`record-${p}`, 'Long-lived record (B)', `chain ${p}: audit, latency of status/metrics/audit, a lesson surfaced later`, 'clean; each ≤ 2 s; ≥ 1', s ? `audit ${s.auditOk ? 'clean' : 'FAILED'}; ${lat ? `${lat.status}/${lat.metrics}/${lat.audit} ms` : 'no latency'}; ${surfaced.recorded} lessons, ${surfaced.surfaced.length} surfaced later` : null, ok);
  }

  // MCP (B).
  add('mcp', 'MCP (B)', 'the quick item with no shell, delivered with a clean audit', '≥ 1 of 2', runs.b4 ? `${recs('b4').filter(deliveredClean).length} of ${recs('b4').length}` : null, runs.b4 ? recs('b4').filter(deliveredClean).length >= 1 : null);

  // Greenfield (C), per engine chain.
  for (const k of [1, 2]) {
    const chain = recs('c1').filter((r) => r.chainRun === k);
    if (!chain.length) {
      add(`greenfield-${k}`, 'Greenfield (C)', `engine chain ${k}`, 'gates in order; c1–c3 delivered; c3 adds a migration, edits none', null, null);
      continue;
    }
    const c1 = chain.find((r) => r.task === `${greenfield}-c1`);
    const c3 = chain.find((r) => r.task === `${greenfield}-c3`);
    const order = c1 ? gateOrder(readEvents(runFiles(runsDir, 'c1', c1).record)) : [];
    const mig = c3 ? migrationChange(c3.patch) : null;
    const delivered = ['c1', 'c2', 'c3'].map((c) => chain.find((r) => r.task === `${greenfield}-${c}`)).filter((r) => r && deliveredClean(r)).length;
    const migOk = Boolean(mig && mig.added.length && !mig.modified.length && !mig.deleted.length && !c3.patchTruncated);
    add(`greenfield-${k}`, 'Greenfield (C)', `engine chain ${k}`, 'gates in order; c1–c3 delivered; c3 adds a migration, edits none', `gates ${order.join(' → ') || 'none'}; ${delivered}/3 delivered; c3 migrations +${mig ? mig.added.length : 0} ~${mig ? mig.modified.length : 0} -${mig ? mig.deleted.length : 0}${c3 && c3.patchTruncated ? ' (patch truncated)' : ''}`, gatesInOrder(order) && delivered === 3 && migOk);
  }

  // Correctness (B, C): every hidden check passed, engine against bare, stratified by item.
  for (const [label, eng, bare] of [['Mealie', ['b1', 'b2'], ['b3']], [greenfield, ['c1'], ['c2']]]) {
    const rowsT = [...eng.flatMap((p) => recs(p).map((r) => ({ stratum: r.task, variant: 'with', lines: passedAll(r) ? 1 : 0 }))), ...bare.flatMap((p) => recs(p).map((r) => ({ stratum: r.task, variant: 'without', lines: passedAll(r) ? 1 : 0 })))];
    const t = bench.stratifiedTest(rowsT);
    const share = (ps) => {
      const rs = ps.flatMap(recs);
      return rs.length ? `${rs.filter(passedAll).length}/${rs.length}` : '—';
    };
    add(`correctness-${label}`, 'Correctness (B, C)', `${label}: runs passing every hidden check, engine vs bare`, 'reported (no criterion)', `engine ${share(eng)}, bare ${share(bare)}${t ? `; Δ ${t.delta.toFixed(3)}, p ${t.p.toFixed(4)} (${t.strata} items)` : ''}`, null);
  }

  // Cost (B, C): median cost per item, engine over bare, per track.
  const costRows = [];
  for (const [eng, bare] of [[['b1', 'b2'], ['b3']], [['c1'], ['c2']]]) {
    const byTrack = {};
    for (const r of eng.flatMap(recs)) {
      const track = (r.engine && r.engine.track) || '?';
      byTrack[track] = byTrack[track] || { e: [], tasks: new Set() };
      byTrack[track].e.push(r.usage && r.usage.costUsd);
      byTrack[track].tasks.add(r.task);
    }
    for (const [track, v] of Object.entries(byTrack)) {
      const b = bare.flatMap(recs).filter((r) => v.tasks.has(r.task)).map((r) => r.usage && r.usage.costUsd);
      const me = median(v.e);
      const mb = median(b);
      costRows.push(`${track}: $${me === null ? '—' : me.toFixed(2)} vs $${mb === null ? '—' : mb.toFixed(2)}${me && mb ? ` (×${(me / mb).toFixed(1)})` : ''}`);
    }
  }
  add('cost', 'Cost (B, C)', 'median cost per item, engine vs bare, per track', 'reported (no criterion)', costRows.join('; ') || null, null);

  const stops = PROCESSES.flatMap((p) => ((runs[p] && runs[p].stopped) || []).map((s) => `${p}: ${s.reason} at $${s.spentUsd}`));
  return { rows, refusals, stops };
}

/** Lesson ids or titles the record lists, from the chain summary's final list, as found in this record copy. */
function lessonIds(recordDir, summary) {
  if (!recordDir || !summary || !Array.isArray(summary.lessons)) return [];
  const text = walk(recordDir).filter((f) => /\.(json|jsonl|md)$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  return summary.lessons.filter((l) => text.includes(l));
}

function markdown({ rows, stops }, title = 'Mealie pilot, Parts B and C') {
  const lines = [`# ${title}`, '', '| Capability | Measure | Criterion | Result | Met |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.capability} | ${r.measure} | ${r.criterion} | ${r.result === null ? '—' : r.result}${r.note ? ` (${r.note})` : ''} | ${r.met === null ? '—' : r.met ? 'met' : 'missed'} |`);
  if (stops.length) lines.push('', `Stopped processes: ${stops.join('; ')}.`);
  return `${lines.join('\n')}\n`;
}

module.exports = { gateOrder, gatesInOrder, migrationChange, deliveredShare, toolResultText, lessonsSurfaced, criteria, readRuns, markdown, allRefusals, itemToolText, ownOffset };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const runsDir = opt('runs', null);
  if (!runsDir) {
    process.stderr.write('usage: analyse.js --runs <dir> [--labels dir] [--greenfield planner|pantry] [--title text] [--out file.md] [--json file.json]\n');
    process.exit(2);
  }
  const labelsDir = opt('labels', path.join(__dirname, 'mealie', 'labels'));
  const refusalsFile = path.join(labelsDir, 'refusals.json');
  const labels = { refusals: fs.existsSync(refusalsFile) ? JSON.parse(fs.readFileSync(refusalsFile, 'utf8')) : {} };
  const result = criteria(runsDir, readRuns(runsDir), labels, { greenfield: opt('greenfield', 'planner') });
  const md = markdown(result, opt('title', undefined));
  if (opt('out', null)) fs.writeFileSync(opt('out', null), md);
  if (opt('json', null)) fs.writeFileSync(opt('json', null), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(md);
}
