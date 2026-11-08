'use strict';
// Names the greenfield layer shares: groups and their roles, stages, the supported stack profile, contract
// files and the event types. Nothing here is behaviour; rules and validators import it.

/** A group is an ownership domain with a lead role first; sub-agents act under the group's role id (L-GF-3). */
const GROUPS = {
  api: ['integration-engineer'],
  backend: ['backend-engineer'],
  db: ['database-engineer'],
  security: ['security-engineer'],
  frontend: ['frontend-engineer'],
  test: ['test-engineer'],
  delivery: ['delivery-lead', 'devops-engineer'],
};

/** Roles the layer adds to the engine's twelve. */
const NEW_ROLES = ['integration-engineer', 'database-engineer', 'security-engineer'];

/** v1 supports one stack; another can be built but cannot reach DONE (L-GF-2). */
const STACK_PROFILES = ['python-fastapi-sqlalchemy-sqlite'];

/** The stages each existing gate carries. */
const GATE_STAGES = { architecture: ['prd', 'architecture'], design: ['contracts', 'threat'], plan: ['breakdown', 'estimates'] };
const STAGES = Object.values(GATE_STAGES).flat();

/** Contract files, relative to the project root; they are sealed by hash at the end of G1. */
const CONTRACT_FILES = [
  'contracts/openapi.json',
  'contracts/db-schema.json',
  'contracts/migrations-plan.json',
  'contracts/access-matrix.json',
  'contracts/fixtures.json',
];
const OPTIONAL_CONTRACT_FILES = ['contracts/events.json'];

const MESSAGE_KINDS = ['question', 'answer', 'amendment-request', 'blocker', 'decision', 'handoff'];
const ESTIMATE_LABEL = 'agent-estimate-uncalibrated';
const MAX_MESSAGE_BYTES = 4096;
/** Who may record a revised estimate beside the registered original. */
const ESTIMATE_REVISERS = ['orchestrator', 'delivery-lead'];
/** The reviewers the design gate must name: the threat model is reviewed by the security reviewer too. */
const DESIGN_REVIEWERS = ['technical-reviewer', 'security-reviewer'];

const EVENT_TYPES = [
  'gf.project.initialized',
  'gf.artifact.registered',
  'gf.estimate.registered',
  'gf.estimate.revised',
  'gf.g1.sealed',
  'gf.message',
  'gf.contract.amendment.requested',
  'gf.contract.amended',
  'gf.ownership.amended',
  'gf.config.pinned',
  'gf.dispatch.recorded',
  'gf.review.recorded',
  'gf.finding.resolved',
  'gf.battery.recorded',
  'gf.slice.closed',
  'gf.slice.accepted',
];

/** GF-CLOSE-6's caveat, written by the engine into every owner acceptance (S2.1). */
const ACCEPT_CAVEAT = 'L-GF-17: the record cannot bind --actor user to a person. This acceptance is asserted by whoever ran the owner CLI as the user; the hook denies that to every subagent and asks the person before the main session runs it.';

/** The group of a role: a group name, 'orchestrator', or null for roles outside every group (authors of documents, reviewers). */
function groupOf(role) {
  if (role === 'orchestrator') return 'orchestrator';
  for (const [name, roles] of Object.entries(GROUPS)) if (roles.includes(role)) return name;
  return null;
}

module.exports = { GROUPS, NEW_ROLES, STACK_PROFILES, GATE_STAGES, STAGES, CONTRACT_FILES, OPTIONAL_CONTRACT_FILES, MESSAGE_KINDS, ESTIMATE_LABEL, MAX_MESSAGE_BYTES, ESTIMATE_REVISERS, DESIGN_REVIEWERS, EVENT_TYPES, ACCEPT_CAVEAT, groupOf };
