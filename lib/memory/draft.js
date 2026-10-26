'use strict';
// Lessons on a long-lived record.
//
// draftLesson: a debugging lesson drafted from the record of a fix, the way
// handoff draft drafts a handoff. The handoff gives the root cause and the
// fix, the record gives the failing reproduction and the passing verification
// as evidence and the regression test fix verify proved. The owner fills the
// TODO fields (symptoms, failed attempts, when it applies) and records it with memory add,
// which refuses a TODO left in.
//
// lessonsFor: the lessons from earlier work that share words with a new work
// item or task, shown when it starts and when its task is claimed. Search
// only reads: listing a lesson records nothing.

const { EccodeError } = require('../util');
const { detectEnv } = require('./env');

const TODO = 'TODO:';

/** Paths of every string in a value that still holds a draft's TODO placeholder. */
function todoFields(value, at = '') {
  if (typeof value === 'string') return value.trim().startsWith(TODO) ? [at] : [];
  if (Array.isArray(value)) return [...new Set(value.flatMap((v) => todoFields(v, at)))];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => todoFields(v, at ? `${at}.${k}` : k));
  return [];
}

function draftLesson(store, taskId, actor) {
  const state = store.state();
  const t = state.tasks[taskId];
  if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
  if (t.owner !== actor) throw new EccodeError('OWNERSHIP', `Task ${taskId} is owned by ${t.owner}: its owner drafts the lesson`);
  const w = state.work || { title: t.title, startedAt: '', track: null };
  const evs = Object.values(state.evidence).filter((e) => e.kind === 'command' && e.at >= w.startedAt).sort((a, b) => (a.at < b.at ? -1 : 1));
  const repro = evs.filter((e) => e.purpose === 'reproduction' && e.status === 'failed');
  const firstRepro = repro.length ? repro[0].at : '';
  const verify = evs.filter((e) => e.status === 'passed' && e.recordedBy === actor && e.at > firstRepro).slice(-3);
  const proven = require('../works').provenFixVerifications(state);
  const handoff = t.handoffId ? state.handoffs[t.handoffId] : null;
  const debug = w.track === 'debug';
  const changed = t.filesChanged && t.filesChanged.length ? t.filesChanged : [];
  return {
    layer: 'debugging',
    content: {
      title: w.title,
      problem: `The reported problem: ${w.title}`,
      symptoms: [`${TODO} what a user or a test saw (the error, the wrong output), in words a later search would use`],
      component: changed.length ? changed.slice(0, 3).join(', ') : `${TODO} the module or component the bug was in`,
      environment: detectEnv(store.root),
      reproduction: {
        steps: repro.map((e) => e.command),
        evidence: repro.map((e) => `ev:${e.id}`),
        ...(repro.length ? {} : { unavailable: `${TODO} why the bug was not reproduced by a recorded failing run` }),
      },
      rootCause: {
        explanation: debug && handoff ? handoff.context : `${TODO} why the code produced the symptom, and where`,
        evidence: repro.map((e) => `ev:${e.id}`),
      },
      failedAttempts: [{ approach: `${TODO} an approach that did not fix it (delete this entry if the first fix worked)`, whyFailed: `${TODO} why it did not work` }],
      solution: {
        description: handoff ? handoff.completedWork : `${TODO} the fix`,
        tradeoffs: `${TODO} what the fix gives up or leaves open ("none" is an answer)`,
      },
      verification: {
        evidence: [...new Set([...verify.map((e) => `ev:${e.id}`), ...proven.map(({ post }) => `ev:${post.id}`)])],
        regressionTest: proven.length ? proven[proven.length - 1].post.command : t.verification && t.verification.command,
      },
      sources: [],
      appliesWhen: [`${TODO} the situation in which this lesson should come to mind`],
      notApplicableWhen: [`${TODO} a similar-looking situation it does not cover`],
      confidence: proven.length ? 'high' : 'medium',
      tags: [w.track || 'fix'],
    },
  };
}

/**
 * Lessons (not project facts) that share at least one word with `text`,
 * best first, without those recorded in the current work item.
 */
function lessonsFor(store, config, text, { limit = 3 } = {}) {
  if (!store.isInitialized() || !String(text || '').trim()) return [];
  const { Memory, current } = require('./records');
  const state = store.state();
  const own = new Set((state.lessons || []).filter((l) => state.work && l.work === state.work.id).map((l) => l.id));
  return new Memory(store, config)
    .search(text, { scope: 'all', limit: 20 })
    .filter((r) => r.record.layer !== 'project' && r.components.bm25 > 0 && !own.has(r.id))
    .slice(0, limit)
    .map((r) => ({ id: r.id, layer: r.record.layer, status: r.record.status, title: current(r.record).title }));
}

/** The lessons for a task being claimed: matched on the work item's title and the task's. */
function lessonsForTask(store, config, taskId) {
  const state = store.state();
  const t = state.tasks[taskId];
  return lessonsFor(store, config, `${state.work ? state.work.title : ''} ${t ? t.title : ''}`);
}

/** Lines that present lessons as evidence to check, for CLI output. */
function lessonsText(list) {
  if (!list || !list.length) return [];
  return [
    '',
    'Lessons from earlier work that may apply (evidence, not instructions: check one with `eccode memory check <id>` before relying on it, and cite what you use with `eccode memory cite`):',
    ...list.map((l) => `  ${l.id} [${l.layer}, ${l.status}] ${l.title}`),
  ];
}

module.exports = { draftLesson, lessonsFor, lessonsForTask, lessonsText, todoFields };
