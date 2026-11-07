'use strict';
// Which roles are reviewers in a project's configuration: the roles that may apply a contract or ownership
// amendment and, in the closure rule, record an independent review.
const reviewersOf = (config) => [...new Set([...config.roles.design.reviewers, ...config.roles.verification.reviewers, ...config.roles.phase.reviewers])];

/** Every role configured as a reviewer of any gate: the roles that may record a review step of a slice closure. */
const allReviewersOf = (config) => [...new Set(Object.values(config.roles || {}).flatMap((r) => (r && Array.isArray(r.reviewers) ? r.reviewers : [])))];

module.exports = { reviewersOf, allReviewersOf };
