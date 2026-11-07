'use strict';
// GF-CONF-1: the guard configurations. `.eccode/behavior.json`, `guards.json` and `security.json` are engine
// configuration (the access-matrix cells become security.policy). Group roles cannot write them (the hook, see
// permissions.js); the orchestrator or the user pins their hashes, and the audit reports any change after the pin.
// The slice-open command of a later slice calls `pin`; before that the project has no pin and no opinion.
const fs = require('fs');
const path = require('path');
const { newId, sha256 } = require('../util');
const events = require('./events');
const wrap = require('./wrap');
const { project } = require('./projection');
const { ruleError } = require('./errors');

const CONFIG_FILES = ['.eccode/behavior.json', '.eccode/guards.json', '.eccode/security.json'];
const PINNERS = ['orchestrator', 'user'];
const P = (message) => ({ rule: 'GF-CONF-1', message });

function readFile(root, rel) {
  try { return fs.readFileSync(path.join(root, rel)); } catch { return null; }
}

/** Pin the config files that exist, by hash. Only the orchestrator or the user. */
function pin(store, config, actor, input = {}) {
  if (!wrap.isEnabled(store)) throw ruleError([{ rule: 'GF-INIT-1', message: 'this record is not a Greenfield-Senior project (start one with eccode-gf init)' }]);
  const { scope, reason } = input;
  const problems = [];
  if (!PINNERS.includes(actor)) problems.push(P(`${actor} may not pin the guard configuration: only the orchestrator or the user`));
  if (typeof scope !== 'string' || !scope.trim()) problems.push(P('a pin names its scope (a slice id or a label)'));
  if (typeof reason !== 'string' || reason.trim().length < 10) problems.push(P('a pin needs a reason of 10 characters or more'));
  const files = {};
  for (const rel of CONFIG_FILES) {
    const bytes = readFile(store.root, rel);
    if (bytes === null) continue;
    try { JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { problems.push(P(`${rel} is not valid JSON`)); continue; }
    files[rel] = sha256(bytes);
  }
  if (!Object.keys(files).length && !problems.length) problems.push(P(`no guard configuration to pin: none of ${CONFIG_FILES.join(', ')} exists`));
  if (problems.length) throw ruleError(problems);
  return events.commit(store, 'gf.config.pinned', actor, { id: newId('pin'), scope: scope.trim(), files, reason: reason.trim() });
}

/** The audit's GF-CONF-1 section: who pinned, and whether the files still match the latest pin. */
function auditProblems(root, gf) {
  const out = [];
  for (const p of gf.configPins) {
    if (!PINNERS.includes(p.actor)) out.push({ ...P(`pin ${p.id} was recorded by ${p.actor}, who is not the orchestrator or the user`), seq: p.seq });
    if (!Object.keys(p.files).length) out.push({ ...P(`pin ${p.id} pins no file`), seq: p.seq });
  }
  const last = gf.configPins[gf.configPins.length - 1];
  if (!last) return out;
  for (const rel of CONFIG_FILES) {
    const bytes = readFile(root, rel);
    const expected = last.files[rel];
    if (expected === undefined) { if (bytes !== null) out.push(P(`${rel} exists but is not in the pin ${last.id} (scope ${last.scope}); pin again to cover it`)); continue; }
    if (bytes === null) out.push(P(`${rel} is missing; it was pinned at ${expected.slice(0, 12)} (pin ${last.id})`));
    else if (sha256(bytes) !== expected) out.push(P(`${rel} differs from the pin ${last.id} (scope ${last.scope}): pinned ${expected.slice(0, 12)}, found ${sha256(bytes).slice(0, 12)}; a configuration change goes through a new pin by the orchestrator or the user`));
  }
  return out;
}

module.exports = { pin, auditProblems, CONFIG_FILES, PINNERS };
