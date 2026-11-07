'use strict';
// Forging helpers shared by the audit tests: the estimate the approved plan really carries, and a seal committed
// straight through the frozen store (the legitimate record, however it was written).
const fs = require('fs');
const path = require('path');
const bundle = require('../../../lib/greenfield/bundle');

const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);

/** The estimate the approved plan really carries, as the engine would have registered it. */
function trueEstimate(ctx) {
  const st = ctx.store.state();
  const hashes = bundle.approvedHashes(st);
  const estPath = Object.keys(hashes).find((p) => p.endsWith('estimates.json'));
  const doc = JSON.parse(fs.readFileSync(path.join(ctx.dir, estPath), 'utf8'));
  return { st, hashes, data: { id: 'est-forged', planSubmissionId: st.gates.plan.approvedSubmission, sha256: hashes[estPath], label: doc.label, basis: doc.basis, groups: doc.groups } };
}

function forgeSeal(ctx, over = {}, estOver = {}) {
  const { st, hashes, data } = trueEstimate(ctx);
  const e = F(ctx, 'gf.estimate.registered', 'gf-engine', { ...data, ...estOver });
  F(ctx, 'gf.g1.sealed', 'gf-engine', { contractsHash: bundle.contractsHashOf(hashes), hashes, planSubmissionId: st.gates.plan.approvedSubmission, estimateSeq: e.event.seq, ...over });
}

module.exports = { trueEstimate, forgeSeal, F };
