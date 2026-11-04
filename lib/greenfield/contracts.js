'use strict';
// The contract files of a sealed project: which hash each is expected to have now. The seal records the hashes
// of G1; every recorded amendment moves one file's expected hash to its new value (rule GF-FRZ-5 checks the
// chain; GF-FRZ-2 compares the expected hash with the bytes on disk).
const fs = require('fs');
const path = require('path');
const { sha256, newId } = require('../util');
const C = require('./constants');
const events = require('./events');
const snapshots = require('./snapshots');
const wrap = require('./wrap');
const openapi = require('./openapi');
const contractsStage = require('./stages/contracts');
const { project } = require('./projection');
const { ruleError } = require('./errors');

/** { 'contracts/openapi.json': sha256, ... } as of the last recorded amendment. */
function currentHashes(gf) {
  const cur = {};
  if (!gf.seal) return cur;
  for (const [p, h] of Object.entries(gf.seal.hashes)) if (p.startsWith('contracts/')) cur[p] = h;
  for (const am of gf.amendments) if (Object.prototype.hasOwnProperty.call(cur, am.contract)) cur[am.contract] = am.toSha;
  return cur;
}

/** The bytes' hash of a project file, or null when it is missing. */
function fileHash(root, rel) {
  try { return sha256(fs.readFileSync(path.join(root, rel))); } catch { return null; }
}

/** GF-FRZ-2: contract files whose bytes differ from the sealed (or last amended) hash. */
function drift(root, gf) {
  const out = [];
  for (const [p, expected] of Object.entries(currentHashes(gf))) {
    const actual = fileHash(root, p);
    if (actual === null) out.push({ rule: 'GF-FRZ-2', message: `${p} is missing; it was sealed at ${expected.slice(0, 12)}` });
    else if (actual !== expected) out.push({ rule: 'GF-FRZ-2', message: `${p} differs from its sealed (or last amended) hash: expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}; a contract changes only by a recorded amendment` });
  }
  return out;
}

const KEY = { 'contracts/openapi.json': 'openapi', 'contracts/db-schema.json': 'dbSchema', 'contracts/migrations-plan.json': 'migrationsPlan', 'contracts/access-matrix.json': 'accessMatrix', 'contracts/fixtures.json': 'fixtures', 'contracts/events.json': 'events' };

const reviewersOf = (config) => [...new Set([...config.roles.design.reviewers, ...config.roles.verification.reviewers, ...config.roles.phase.reviewers])];

function liveDoc(root, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '')); } catch { return undefined; }
}

/** File-level validity of a contract document (the cross-file consistency of an amended bundle is a slice-integration check, L-GF-14). */
function fileProblems(root, rel, doc) {
  const docs = { [KEY[rel]]: doc };
  if (rel === 'contracts/access-matrix.json' || rel === 'contracts/fixtures.json') docs.openapi = liveDoc(root, 'contracts/openapi.json');
  if (rel === 'contracts/access-matrix.json' && docs.openapi === undefined) delete docs.openapi;
  if (rel === 'contracts/fixtures.json') { const m = liveDoc(root, 'contracts/access-matrix.json'); if (m !== undefined) docs.accessMatrix = m; if (docs.openapi === undefined) delete docs.openapi; }
  if (rel === 'contracts/migrations-plan.json') { const d = liveDoc(root, 'contracts/db-schema.json'); if (d !== undefined) docs.dbSchema = d; }
  return contractsStage.validate(docs, {});
}

function requireSealed(store) {
  if (!wrap.isEnabled(store)) throw ruleError([{ rule: 'GF-INIT-1', message: 'this record is not a Greenfield-Senior project (start one with eccode-gf init)' }]);
  const gf = project(store.readEvents());
  if (!gf.seal) throw ruleError([{ rule: 'GF-FRZ-5', message: 'no contract amendment before G1 is sealed: until then a contract is edited and resubmitted through the gates' }]);
  return gf;
}

/** A group member asks for a contract change, citing the amendment-request message they sent to the api group. */
function requestAmendment(store, config, actor, input = {}) {
  const gf = requireSealed(store);
  const { contract, reason, message, proposed } = input;
  const P = [];
  if (!Object.keys(gf.seal.hashes).filter((p) => p.startsWith('contracts/')).includes(contract)) P.push({ rule: 'GF-FRZ-5', message: `${contract} is not one of the sealed contract files` });
  const msg = gf.messages.find((m) => m.id === message);
  if (!msg) P.push({ rule: 'GF-MSG-1', message: `message ${message} is not a recorded message` });
  else {
    if (msg.kind !== 'amendment-request') P.push({ rule: 'GF-MSG-2', message: `message ${message} is a ${msg.kind}, not an amendment-request to the api group` });
    if (msg.from !== C.groupOf(actor)) P.push({ rule: 'GF-MSG-1', message: `message ${message} was sent by the ${msg.from} group, not by ${actor}'s group` });
    if (gf.requests.some((r) => r.message === message)) P.push({ rule: 'GF-FRZ-5', message: `message ${message} already carries a request` });
  }
  const data = { id: newId('req'), contract, reason, message, proposed };
  for (const e of events.validate('gf.contract.amendment.requested', data)) P.push({ rule: 'GF-FRZ-5', message: e });
  if (P.length) throw ruleError(P);
  return events.commit(store, 'gf.contract.amendment.requested', actor, data).event.data;
}

/** A reviewer records that the contract file now has new, valid bytes, with a reason. The chain moves from the old hash to the new. */
function applyAmendment(store, config, actor, input = {}) {
  const gf = requireSealed(store);
  const { request: requestId, reason } = input;
  const P = [];
  const F = (message) => P.push({ rule: 'GF-FRZ-5', message });
  if (!reviewersOf(config).includes(actor)) F(`${actor} is not a reviewer and may not apply an amendment (reviewers: ${reviewersOf(config).join(', ')})`);
  const req = gf.requests.find((r) => r.id === requestId);
  if (!req) F(`request ${requestId} was never recorded`);
  else if (gf.amendments.some((a) => a.request === req.id)) F(`request ${req.id} was already applied`);
  if (typeof reason !== 'string' || reason.trim().length < 30) F('an amendment needs a reason of at least 30 characters');
  if (P.length) throw ruleError(P);

  const fromSha = currentHashes(gf)[req.contract];
  const toSha = fileHash(store.root, req.contract);
  if (toSha === null) F(`${req.contract} is missing`);
  else if (toSha === fromSha) F(`${req.contract} has not changed since its last recorded hash; the api group edits the file first`);
  const doc = liveDoc(store.root, req.contract);
  if (toSha !== null && doc === undefined) F(`${req.contract} is not valid JSON`);
  if (P.length) throw ruleError(P);
  const invalid = fileProblems(store.root, req.contract, doc);
  if (invalid.length) throw ruleError([{ rule: 'GF-FRZ-5', message: `the amended ${req.contract} is not valid, so it cannot be recorded` }, ...invalid]);

  let classification = 'breaking';
  let affectedOps = [];
  if (req.contract === 'contracts/openapi.json') {
    const old = snapshots.read(store.root, fromSha);
    if (old) {
      let before;
      try { before = JSON.parse(old.toString('utf8').replace(/^\uFEFF/, '')); } catch { before = null; }
      if (before) { const d = openapi.diff(before, doc); classification = openapi.classify(d); affectedOps = [...d.added, ...d.removed, ...d.changed].sort(); }
    }
  }
  snapshots.write(store.root, req.contract, toSha);
  const data = { id: newId('am'), request: req.id, contract: req.contract, fromSha, toSha, reason: reason.trim(), classification, affectedOps, invalidates: [] };
  return events.commit(store, 'gf.contract.amended', actor, data, () => {
    const again = project(store.readEvents());
    if (again.amendments.some((a) => a.request === req.id)) throw ruleError([{ rule: 'GF-FRZ-5', message: `request ${req.id} was applied meanwhile` }]);
    if (currentHashes(again)[req.contract] !== fromSha) throw ruleError([{ rule: 'GF-FRZ-5', message: `${req.contract} was amended meanwhile; apply against its new hash` }]);
    if (fileHash(store.root, req.contract) !== toSha) throw ruleError([{ rule: 'GF-FRZ-5', message: `${req.contract} changed while the amendment was being recorded` }]);
  }).event.data;
}

/** GF-FRZ-5 over the log: requests and amendments are well-formed, in order, by the right actors, and the hash chain is unbroken. */
function chainProblems(gf, config) {
  const out = [];
  const F = (message, seq) => out.push({ rule: 'GF-FRZ-5', message, seq });
  const reviewers = reviewersOf(config);
  const sealSeq = gf.seal ? gf.seal.seq : Infinity;
  for (const r of gf.requests) {
    if (r.seq < sealSeq) F(`request ${r.id} was recorded before G1 was sealed`, r.seq);
    const msg = gf.messages.find((m) => m.id === r.message);
    if (!msg || msg.kind !== 'amendment-request') out.push({ rule: 'GF-MSG-2', message: `request ${r.id} cites message ${r.message}, which is not a recorded amendment-request`, seq: r.seq });
    else if (C.groupOf(r.actor) !== msg.from) out.push({ rule: 'GF-MSG-1', message: `request ${r.id} cites a message from the ${msg.from} group but was recorded by ${r.actor}`, seq: r.seq });
    if (gf.seal && !Object.prototype.hasOwnProperty.call(gf.seal.hashes, r.contract)) F(`request ${r.id} names ${r.contract}, which is not a sealed contract`, r.seq);
  }
  const cur = gf.seal ? { ...gf.seal.hashes } : {};
  const used = new Set();
  for (const a of gf.amendments) {
    if (a.seq < sealSeq) F(`amendment ${a.id} was recorded before G1 was sealed`, a.seq);
    if (!reviewers.includes(a.actor)) F(`amendment ${a.id} was applied by ${a.actor}, who is not a reviewer`, a.seq);
    const req = gf.requests.find((r) => r.id === a.request);
    if (!req) F(`amendment ${a.id} cites request ${a.request}, which was never recorded`, a.seq);
    else {
      if (req.contract !== a.contract) F(`amendment ${a.id} changes ${a.contract} but request ${req.id} asked for ${req.contract}`, a.seq);
      if (used.has(req.id)) F(`amendment ${a.id}: request ${req.id} was already applied`, a.seq);
      used.add(req.id);
    }
    if (!Object.prototype.hasOwnProperty.call(cur, a.contract)) F(`amendment ${a.id} names ${a.contract}, which is not a sealed contract`, a.seq);
    else if (a.fromSha !== cur[a.contract]) F(`amendment ${a.id}: fromSha is not the current hash of ${a.contract} (the hash chain is broken)`, a.seq);
    if (a.toSha === a.fromSha) F(`amendment ${a.id} records no change`, a.seq);
    cur[a.contract] = a.toSha;
  }
  return out;
}

/** GF-FRZ-2: every sealed and amended contract has an intact snapshot. */
function snapshotProblems(root, gf) {
  const out = [];
  const want = new Map();
  if (gf.seal) for (const [p, h] of Object.entries(gf.seal.hashes)) if (p.startsWith('contracts/')) want.set(h, p);
  for (const a of gf.amendments) want.set(a.toSha, a.contract);
  for (const [h, p] of want) if (!snapshots.read(root, h)) out.push({ rule: 'GF-FRZ-2', message: `the snapshot of ${p} at ${h.slice(0, 12)} is missing or was edited (.eccode/contracts/${h}.json)` });
  return out;
}

/** GF-FRZ-5: a contract that was amended and still has its recorded bytes must still be a valid document. */
function amendedProblems(root, gf) {
  const out = [];
  if (!gf.seal) return out;
  for (const [p, expected] of Object.entries(currentHashes(gf))) {
    if (expected === gf.seal.hashes[p] || fileHash(root, p) !== expected) continue;
    const doc = liveDoc(root, p);
    const problems = doc === undefined ? [{ message: 'it is not valid JSON' }] : fileProblems(root, p, doc);
    if (problems.length) out.push({ rule: 'GF-FRZ-5', message: `the amended ${p} no longer validates: ${problems.slice(0, 3).map((x) => x.message).join('; ')}` });
  }
  return out;
}

module.exports = { currentHashes, fileHash, drift, requestAmendment, applyAmendment, chainProblems, snapshotProblems, amendedProblems, fileProblems, reviewersOf };
