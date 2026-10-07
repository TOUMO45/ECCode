'use strict';
// Stub of createTriageService: records the deps it was composed with, follows the C6.4 fallback order.
function createTriageService(deps) {
  globalThis.__tdskEvalStubDeps = deps;
  return {
    mode: deps.provider === null ? 'fallback' : 'live', model: null,
    async analyse(ticket) {
      const detection = deps.detectInjection(ticket);
      const triage = deps.fallbackAnalyse(ticket, detection);
      return {
        response: { ...triage, source: 'fallback', fallbackReason: 'no_api_key', injectionSuspected: detection.suspected, model: null },
        meta: { latencyMs: 0, ticketLength: ticket.length, redactions: null, upstreamStatus: null, usage: null, detail: null },
      };
    },
  };
}
module.exports = { createTriageService };
