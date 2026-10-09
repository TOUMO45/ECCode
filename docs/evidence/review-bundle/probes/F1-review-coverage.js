'use strict';
const REPO = require('path').resolve(__dirname, '../../../..');
// Probe F1-review-coverage: does an approving review have to cover the
// artifact's own Requirements / Acceptance Criteria, and are
// artifact:<path>#anchor anchors verified against the document?
//
// Runs against the CURRENT engine at the repository root (REPO) without modifying it.

const fs = require('fs');
const path = require('path');
const gates = require(REPO + '/lib/gates');
const { resolveRef } = require(REPO + '/lib/evidence');
const { tmpProject, write } = require(REPO + '/tests/helpers');

const BRIEF_REL = '.eccode/artifacts/architecture/brief.md';
const BOGUS_ANCHOR = `artifact:${BRIEF_REL}#this-section-does-not-exist`;

// Brief with several requirements and acceptance criteria under every heading
// that config.review.requiredSections.architecture demands.
const BRIEF = `# Brief
## Users
Support agents.
## Problem
Ticket triage is slow.
## Requirements
- R1 classify tickets
- R2 rate limit the classifier endpoint
## Acceptance Criteria
- AC1 category returned for every ticket
- AC2 429 returned above the configured rate
## Architecture
Single Node service.
## Assumptions
- A1
## Open Questions
- Q1
## Risks
- RISK1
`;

const out = { probe: 'F1-review-coverage', reproduces: false };
let ctx;
try {
  ctx = tmpProject();
  const { dir, store, config } = ctx;
  out.requiredSections = config.review.requiredSections.architecture;
  out.minEvidencePerApproval = config.review.minEvidencePerApproval;

  gates.startGate(store, config, 'architecture', 'orchestrator');
  write(dir, BRIEF_REL, BRIEF);
  const sub = gates.submit(store, config, 'architecture', 'product-architect', { artifacts: [BRIEF_REL] });
  out.submissionId = sub.event.data.submissionId;
  out.statusAfterSubmit = store.state().gates.architecture.status;

  // Step A: what does resolveRef say about the bogus anchor on its own?
  const res = resolveRef(store.state(), dir, BOGUS_ANCHOR, { allowedArtifacts: [BRIEF_REL] });
  out.resolveRefResult = res;
  out.anchorAccepted = res.ok === true;

  // Step B: a single criterion that says nothing about R1/R2/AC1/AC2 and
  // cites a section that does not exist in the brief.
  const review = {
    decision: 'approve',
    summary: 'The document has a title, so it is approved as submitted.',
    criteria: [
      { id: 'C1', description: 'The document has a title', met: true, evidence: [BOGUS_ANCHOR] },
    ],
    findings: [],
  };

  let refusal = null;
  let recorded = null;
  try {
    recorded = gates.recordReview(store, config, 'architecture', 'architecture-reviewer', review);
  } catch (err) {
    refusal = { code: err.code, message: err.message, reasons: err.details && err.details.reasons };
  }
  const state = store.state();
  const g = state.gates.architecture;
  out.refusal = refusal;
  out.reviewId = recorded ? recorded.event.data.reviewId : null;
  out.gateStatus = g.status;
  out.approvedBy = g.approvedBy || null;
  out.approvedSubmission = g.approvedSubmission || null;
  out.rejectedReviews = state.rejectedReviews.length;
  out.recordedReviewCriteria = out.reviewId ? state.reviews[out.reviewId].criteria.map((c) => ({ id: c.id, description: c.description, evidence: c.evidence })) : null;
  out.criteriaMentioningRequirementsOrAC = out.reviewId
    ? state.reviews[out.reviewId].criteria.filter((c) => /\b(R1|R2|AC1|AC2|requirement|acceptance)\b/i.test(c.description)).length
    : null;

  out.reproduces = g.status === 'approved' && out.anchorAccepted;
  out.verdict = out.reproduces
    ? 'approval recorded with one criterion ("document has a title") citing a non-existent section anchor; R1/R2/AC1/AC2 never judged'
    : 'engine refused the approval or rejected the bogus anchor';
} catch (err) {
  out.unexpectedError = { code: err.code, message: err.message, stack: err.stack };
} finally {
  if (ctx && ctx.dir) {
    try { fs.rmSync(ctx.dir, { recursive: true, force: true }); } catch {}
  }
}
console.log(JSON.stringify(out));
