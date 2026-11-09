'use strict';
// `gf init`: the frozen project init on the greenfield track, the project configuration the layer needs (the
// three group roles may author phase work, the security reviewer may review the design gate, four groups may be
// active at once), and the gf.project.initialized event that turns the layer on for this record.
const { init } = require('../project');
const { Store } = require('../store');
const { configPath } = require('../config');
const { readJson, writeJson } = require('../util');
const C = require('./constants');
const profiles = require('./profiles');
const events = require('./events');
const { ruleError } = require('./errors');

const union = (a, b) => [...new Set([...a, ...b])];

function initProject(root, { name, idea, stackProfile = C.STACK_PROFILES[0], actor = 'orchestrator' } = {}) {
  if (!profiles.supported().includes(stackProfile)) {
    throw ruleError([{ rule: 'GF-INIT-1', message: `stack profile ${stackProfile} is not supported (supported: ${profiles.supported().join(', ')}); other stacks can be built but cannot reach DONE` }]);
  }
  if (new Store(root).isInitialized()) {
    throw ruleError([{ rule: 'GF-INIT-1', message: 'an ECCode project already exists here; Greenfield-Senior starts a project from one idea and cannot adopt an existing one in v1' }]);
  }
  // S4-PREREQ D-1: a scaffolded profile writes its engine-owned files first; a clash refuses and creates nothing.
  if (profiles.get(stackProfile)) {
    const s = profiles.writeScaffold(root, stackProfile);
    if (s.problems.length) throw ruleError(s.problems);
  }
  const store = init(root, { name, idea, actor, track: 'greenfield' });
  const file = configPath(store.root);
  const cfg = readJson(file, {});
  cfg.roles.phase.authors = union(cfg.roles.phase.authors, C.NEW_ROLES);
  cfg.roles.design.reviewers = union(cfg.roles.design.reviewers, ['security-reviewer']);
  cfg.limits.maxConcurrency = Math.max(cfg.limits.maxConcurrency, 4);
  cfg.gf = { enabled: true, schemaVersion: 1, stackProfile };
  writeJson(file, cfg);
  events.commit(store, 'gf.project.initialized', actor, { stackProfile, schemaVersion: 1, groups: C.GROUPS });
  return store;
}

module.exports = { initProject };
