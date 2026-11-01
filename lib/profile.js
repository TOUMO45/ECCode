'use strict';
// Time profile of an engine run from its record (the event log): minutes per
// phase, so a run's cost can be attributed to what the engine asked for
// (Phase 3, Part F follow-up: the time profile of the narrowed runs).
//
// Two layers, both from the record alone (no transcript needed):
//   1. wall-clock phases: the interval between consecutive events is given to
//      the activity under way (design, plan, lab, implement, review, guards,
//      delivery, orchestrator between dispatches), from the gate, task, run
//      and Lab events;
//   2. command time: every executed check (evidence.recorded) is also binned
//      by what it was for (lab: reproduce/baseline, lab: hypotheses, fix
//      verify, mutation, scoped checks, full claim run, reviewer re-run,
//      behavior diff, guards) and subtracted from its wall-clock phase, so
//      what remains per phase is agent time with no command running.
// A record is a sequence of what the engine saw, so a profile is exact about
// commands and approximate about what the agent did between them.
const fs = require('fs');
const path = require('path');

const REVIEWERS = new Set(['technical-reviewer', 'security-reviewer', 'architecture-reviewer']);
const normCmd = (c) => String(c || '').trim().replace(/\s+/g, ' ');

/** The events of a record directory or file. */
function readEvents(where) {
  const file = fs.existsSync(where) && fs.statSync(where).isDirectory() ? path.join(where, 'events.jsonl') : where;
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Which command bucket an executed check belongs to. */
function commandKind(e, pinned) {
  const d = e.data || {};
  const label = String(d.label || '').toLowerCase();
  const actor = e.actor;
  if (d.repro || d.purpose === 'reproduction' || /^repro\b|baseline/.test(label)) return 'lab: reproduce / baseline';
  if (/^hypothesis|^trace|^localize|sbfl|bisect/.test(label) || d.hypothesis) return 'lab: hypotheses';
  if (d.fixVerify || /^fix-verify/.test(label)) return 'fix verify';
  if (/^mutat/.test(label)) return 'mutation';
  if (/^behavior/.test(label) || d.purpose === 'behavior') return 'behavior diff';
  if (/^(migration|api|perf|race|security|guard)\b/.test(label)) return 'production guards';
  if (REVIEWERS.has(actor) || d.gate) return 'reviewer re-run';
  const cmd = normCmd(d.command);
  const task = d.task && pinned[d.task];
  if (task && cmd === normCmd(task)) return 'full claim run';
  return 'scoped checks';
}

/** The pinned verification command per task, from the plan and every rescope. */
function pinnedCommands(events) {
  const out = {};
  for (const e of events) {
    if (e.type === 'plan.imported') for (const t of e.data.tasks || []) if (t.verification && t.verification.command) out[t.id] = t.verification.command;
    if (e.type === 'task.rescoped' && e.data.command) out[e.data.task] = e.data.command;
  }
  return out;
}

/**
 * The wall-clock activity after each event (a small state machine over the
 * gate, run, task and Lab events).
 */
function activityAfter(e, st) {
  const d = e.data || {};
  switch (e.type) {
    case 'project.initialized':
    case 'work.started':
      return 'plan';
    case 'gate.started':
      if (d.gate === 'architecture' || d.gate === 'design') return 'design';
      if (d.gate === 'plan') return 'plan';
      if (d.gate === 'verification') return 'verification';
      return 'orchestrator between dispatches';
    case 'gate.submitted':
      if (d.gate === 'architecture' || d.gate === 'design') return 'design review';
      if (d.gate === 'plan') return 'plan review';
      return 'review';
    case 'run.started':
      if (REVIEWERS.has(d.agent)) return st.current.endsWith('review') ? st.current : 'review';
      if (d.gate === 'plan') return 'plan';
      if (d.gate === 'architecture' || d.gate === 'design') return 'design';
      if (d.agent === 'delivery-lead' && d.gate === 'verification') return 'verification';
      return d.task ? 'implement' : st.current;
    // A claimed task is implementation until the Lab starts (a reproduction or a
    // hypothesis) and again once the root cause is declared; a task that never
    // opens the Lab (a tests-only task) is implementation throughout.
    case 'task.claimed':
      st.task = d.task;
      return 'implement';
    case 'repro.recorded':
    case 'hypothesis.opened':
    case 'hypothesis.closed':
    case 'localization.result':
      return 'lab';
    case 'rootcause.declared':
      if (st.task) st.labDone.add(st.task);
      return 'implement';
    case 'task.completed':
    case 'task.failed':
    case 'run.ended':
      return 'orchestrator between dispatches';
    case 'review.recorded':
    case 'review.rejected':
      return 'orchestrator between dispatches';
    case 'guard.routing':
    case 'migration.analysis':
    case 'migration.rollback.proof':
    case 'api.diff':
    case 'perf.result':
    case 'race.result':
    case 'security.matrix.result':
    case 'security.idor.result':
    case 'security.authflow.result':
    case 'security.input.result':
      return 'guards and delivery';
    case 'behavior.routing':
    case 'behavior.diff.result':
      return 'behavior diff';
    case 'delivery.completed':
      return 'done';
    default:
      return st.current;
  }
}

/**
 * The profile of one record: {spanMinutes, wall: {phase: minutes}, commands:
 * {kind: {minutes, runs}}, agent: {phase: minutes} (wall minus the commands
 * that ran in it), reviews, rejections, dispatches, checks}.
 */
function profile(events) {
  if (!events || !events.length) return null;
  const pinned = pinnedCommands(events);
  const st = { current: 'plan', task: null, labDone: new Set() };
  const wall = {};
  const commandsIn = {};
  const commands = {};
  const add = (map, k, ms, runs = 0) => {
    map[k] = map[k] || { ms: 0, runs: 0 };
    map[k].ms += ms;
    map[k].runs += runs;
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const next = events[i + 1];
    if (e.type === 'evidence.recorded' && e.data && e.data.kind === 'command') {
      const kind = commandKind(e, pinned);
      const ms = e.data.durationMs || 0;
      add(commands, kind, ms, 1);
      add(commandsIn, st.current, ms);
    }
    st.current = activityAfter(e, st);
    if (next) add(wall, st.current, Math.max(0, Date.parse(next.ts) - Date.parse(e.ts)));
  }
  const min = (ms) => Math.round(ms / 600) / 100;
  const out = {
    spanMinutes: min(Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts)),
    events: events.length,
    wall: {},
    agent: {},
    commands: {},
    checkMinutes: 0,
    reviews: events.filter((e) => e.type === 'review.recorded' || e.type === 'review.rejected').length,
    rejections: events.filter((e) => e.type === 'review.rejected').length,
    dispatches: events.filter((e) => e.type === 'run.started').length,
    tasks: events.filter((e) => e.type === 'task.claimed').length,
    delivered: events.some((e) => e.type === 'delivery.completed'),
  };
  for (const [k, v] of Object.entries(wall)) {
    out.wall[k] = min(v.ms);
    out.agent[k] = min(Math.max(0, v.ms - ((commandsIn[k] && commandsIn[k].ms) || 0)));
  }
  for (const [k, v] of Object.entries(commands)) {
    out.commands[k] = { minutes: min(v.ms), runs: v.runs };
    out.checkMinutes += v.ms;
  }
  out.checkMinutes = min(out.checkMinutes);
  return out;
}

/** Sum profiles: minutes per wall phase, per command kind, and the top sinks over everything. */
function aggregate(profiles) {
  const ps = profiles.filter(Boolean);
  const wall = {};
  const agent = {};
  const commands = {};
  for (const p of ps) {
    for (const [k, v] of Object.entries(p.wall)) wall[k] = (wall[k] || 0) + v;
    for (const [k, v] of Object.entries(p.agent)) agent[k] = (agent[k] || 0) + v;
    for (const [k, v] of Object.entries(p.commands)) {
      commands[k] = commands[k] || { minutes: 0, runs: 0 };
      commands[k].minutes += v.minutes;
      commands[k].runs += v.runs;
    }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const sinks = [
    ...Object.entries(commands).map(([k, v]) => ({ sink: `${k} (commands)`, minutes: r2(v.minutes), runs: v.runs })),
    ...Object.entries(agent).map(([k, v]) => ({ sink: `${k} (agent time, no command running)`, minutes: r2(v) })),
  ].sort((a, b) => b.minutes - a.minutes);
  return {
    runs: ps.length,
    spanMinutes: r2(ps.reduce((s, p) => s + p.spanMinutes, 0)),
    checkMinutes: r2(ps.reduce((s, p) => s + p.checkMinutes, 0)),
    wall: Object.fromEntries(Object.entries(wall).map(([k, v]) => [k, r2(v)]).sort((a, b) => b[1] - a[1])),
    agent: Object.fromEntries(Object.entries(agent).map(([k, v]) => [k, r2(v)]).sort((a, b) => b[1] - a[1])),
    commands: Object.fromEntries(Object.entries(commands).map(([k, v]) => [k, { minutes: r2(v.minutes), runs: v.runs }]).sort((a, b) => b[1].minutes - a[1].minutes)),
    topSinks: sinks.slice(0, 3),
    reviews: ps.reduce((s, p) => s + p.reviews, 0),
    rejections: ps.reduce((s, p) => s + p.rejections, 0),
  };
}

/** A Markdown table of an aggregate (minutes per phase: wall, of which commands, of which agent time). */
function table(agg) {
  const lines = ['| Phase | Wall-clock min | Agent time (no command) min |', '|---|---|---|'];
  for (const [k, v] of Object.entries(agg.wall)) lines.push(`| ${k} | ${v} | ${agg.agent[k] === undefined ? '—' : agg.agent[k]} |`);
  lines.push('', '| Commands | Minutes | Runs |', '|---|---|---|');
  for (const [k, v] of Object.entries(agg.commands)) lines.push(`| ${k} | ${v.minutes} | ${v.runs} |`);
  return lines.join('\n');
}

module.exports = { readEvents, profile, aggregate, table, commandKind, pinnedCommands, activityAfter };
