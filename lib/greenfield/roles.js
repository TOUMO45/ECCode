'use strict';
// Which roles are reviewers in a project's configuration: the roles that may apply a contract or ownership
// amendment and, in the closure rule, record an independent review.
const reviewersOf = (config) => [...new Set([...config.roles.design.reviewers, ...config.roles.verification.reviewers, ...config.roles.phase.reviewers])];

module.exports = { reviewersOf };
