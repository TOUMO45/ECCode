'use strict';
// Compare unreviewedChanges and per-task file sets between a lib root and a project record.
// usage: node probe-compare.js <libRoot> <projectRoot>
const path = require('path');
const [libRoot, projectRoot] = process.argv.slice(2).map((p) => path.resolve(p));
const { Store } = require(path.join(libRoot, 'lib/store.js'));
const { unreviewedChanges } = require(path.join(libRoot, 'lib/delivery.js'));
const tasks = require(path.join(libRoot, 'lib/tasks.js'));
const store = new Store(projectRoot);
const state = store.state();
const events = store.readEvents();
const out = { project: projectRoot, events: events.length };
try {
  out.unreviewed = unreviewedChanges(state, projectRoot);
} catch (e) {
  out.unreviewedError = `${e.code || ''} ${e.message}`;
}
const completions = {};
for (const ev of events) {
  if (ev.type === 'plan.imported') for (const k of Object.keys(completions)) delete completions[k];
  if (ev.type === 'task.completed') completions[ev.data.task] = (completions[ev.data.task] || 0) + 1;
}
out.multiCompletion = Object.entries(completions).filter(([, n]) => n > 1);
if (tasks.filesChangedByTask) {
  const byTask = tasks.filesChangedByTask(events);
  out.unionDiffers = {};
  for (const t of Object.values(state.tasks || {})) {
    const snap = new Set(t.filesChanged || []);
    const union = byTask.get(t.id) || new Set();
    const extra = [...union].filter((f) => !snap.has(f));
    if (extra.length) out.unionDiffers[t.id] = extra;
  }
}
console.log(JSON.stringify(out, null, 1));
