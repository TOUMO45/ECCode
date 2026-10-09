'use strict';
// Public engine API (package.json "main"). Everything the CLI does goes through
// these modules, so a harness or a test can drive a project record in-process:
//
//   const eccode = require('eccode');
//   const store = eccode.init(dir, { name, idea });
//   eccode.gates.startGate(store, eccode.loadConfig(dir), 'architecture', 'orchestrator');
//
// The CLI (bin/eccode.js) is the supported interface for agents; this module is
// for tooling that embeds the engine. Modules are exported whole, so their
// documented functions are reachable as eccode.<module>.<function>.

const { version } = require('../package.json');
const { Store, GENESIS } = require('./store');
const { openProject, init, PROFILES } = require('./project');
const { loadConfig, DEFAULT_CONFIG, learningEnabled } = require('./config');
const { EccodeError } = require('./util');
const { Memory, LAYERS } = require('./memory/records');

module.exports = {
  version,
  EccodeError,
  // Record
  Store,
  GENESIS,
  openProject,
  init,
  PROFILES,
  // Workflow
  gates: require('./gates'),
  tasks: require('./tasks'),
  evidence: require('./evidence'),
  runs: require('./runs'),
  delivery: require('./delivery'),
  reconcile: require('./reconcile'),
  rework: require('./rework'),
  lessons: require('./lessons'),
  status: require('./status'),
  // Memory and self-improvement
  Memory,
  LAYERS,
  improve: require('./memory/improve'),
  metrics: require('./memory/metrics'),
  // Configuration and installation
  loadConfig,
  DEFAULT_CONFIG,
  learningEnabled,
  install: require('./install'),
};
