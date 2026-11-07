'use strict';
// Shows approvedCommands (the runner's "a command the plan pins") also returns s.lab.repro.command,
// a source 18.4 does not enumerate ("task checks, the behaviour command, the detected stack checks").
// A command equal to it short-circuits ALL of the runner's form checks (runner.js:formProblems first line).
const path = require('path');
const C = path.join(__dirname, 'copy');
const { approvedCommands } = require(path.join(C, 'lib/mcp'));
const runner = require(path.join(C, 'lib/greenfield/runner'));

// Minimal fake store/config exercising approvedCommands' branches.
const fakeStore = {
  root: C,
  state: () => ({
    tasks: {},
    work: { behaviorCommand: 'pytest -q' },
    lab: { repro: { command: 'bash -c curl_evil_example' } }, // an arbitrary, non-pinned-form string
  }),
};
const cfg = {};
const allowed = approvedCommands(fakeStore, cfg);
console.log('approvedCommands ->', JSON.stringify(allowed));

// formProblems short-circuits on membership; prove the arbitrary lab-repro string is accepted as a "pinned" command
// even though it is NOT a pinned form of any of the eight tools and contains shell syntax.
const problems = runner.formProblems(fakeStore, cfg, 'backend-engineer', 'bash -c curl_evil_example');
console.log('formProblems for the lab-repro string ->', JSON.stringify(problems), '(empty = accepted)');
// Contrast: the same string NOT in the approved list is refused as shell syntax.
const problems2 = runner.formProblems({ root: C, state: () => ({ tasks: {}, work: {}, lab: {} }) }, cfg, 'backend-engineer', 'bash -c curl_evil_example');
console.log('formProblems when NOT pinned ->', JSON.stringify(problems2.map(p=>p.message)));
