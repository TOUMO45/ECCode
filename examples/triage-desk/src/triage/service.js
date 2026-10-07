'use strict';
// createTriageService(deps) — R12 orchestration of one analysis (spec C6.4, D1.4, C3).
// Every collaborator is injected (provider, detectInjection, fallbackAnalyse, redact, now); this module requires no
// concrete detector, fallback, provider or redaction module. It does not log: AnalysisMeta carries only lengths,
// counts, status codes, token usage and fixed detail codes, and http-server.js writes the D1.6 log line from it.
const { performance } = require('node:perf_hooks');
const { FALLBACK_REASONS } = require('./schema.js');

// Reasons a provider may report. 'no_api_key' is the service's own reason, never a provider's.
const LIVE_REASONS = new Set(FALLBACK_REASONS.filter((r) => r !== 'no_api_key'));
const PROVIDER_THREW = Object.freeze({ ok: false, reason: 'model_error', upstreamStatus: null, usage: null, detail: 'provider_threw' });

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError('createTriageService: ' + name + ' must be a function');
}

/** True when `live` is a LiveResult per C6.4 that the service can act on. */
function isLiveResult(live) {
  if (live === null || typeof live !== 'object') return false;
  if (live.ok === true) return live.triage !== null && typeof live.triage === 'object';
  return live.ok === false && LIVE_REASONS.has(live.reason);
}

function buildResponse(triage, source, fallbackReason, injectionSuspected, model) {
  // Exactly the 8 C3 keys, in order. Only the four Triage fields are copied from the collaborator's object.
  return {
    category: triage.category,
    urgency: triage.urgency,
    summary: triage.summary,
    suggestedReply: triage.suggestedReply,
    source,
    fallbackReason,
    injectionSuspected,
    model,
  };
}

/**
 * @param {{provider: {model:string, analyse:(redactedTicket:string)=>Promise<object>}|null,
 *          detectInjection: Function, fallbackAnalyse: Function, redact: Function, now?: ()=>number}} deps
 * @returns {{mode:'live'|'fallback', model:string|null, analyse:(ticket:string)=>Promise<{response:object, meta:object}>}}
 */
function createTriageService(deps) {
  if (deps === null || typeof deps !== 'object') throw new TypeError('createTriageService: deps object required');
  const { provider, detectInjection, fallbackAnalyse, redact } = deps;
  const now = deps.now === undefined ? () => performance.now() : deps.now;
  requireFunction(detectInjection, 'detectInjection');
  requireFunction(fallbackAnalyse, 'fallbackAnalyse');
  requireFunction(redact, 'redact');
  requireFunction(now, 'now');
  if (provider !== null) {
    // undefined is refused on purpose: fallback mode must be chosen explicitly with provider: null.
    if (provider === undefined || typeof provider !== 'object') throw new TypeError('createTriageService: provider must be an object or null');
    requireFunction(provider.analyse, 'provider.analyse');
    if (typeof provider.model !== 'string' || provider.model.length === 0) throw new TypeError('createTriageService: provider.model must be a non-empty string');
  }
  const mode = provider === null ? 'fallback' : 'live';
  const model = provider === null ? null : provider.model;

  async function analyse(ticket) {
    if (typeof ticket !== 'string') throw new TypeError('analyse: ticket must be a string');
    const started = now();
    // R12 step 1: the detector always sees the ORIGINAL (validated, trimmed) text. A throw here is a bug: propagate.
    const detection = detectInjection(ticket);
    const injectionSuspected = detection.suspected === true;

    // R12 step 2: no provider → deterministic fallback; nothing is redacted and nothing leaves the process.
    if (provider === null) {
      const triage = fallbackAnalyse(ticket, detection);
      return {
        response: buildResponse(triage, 'fallback', 'no_api_key', injectionSuspected, null),
        meta: { latencyMs: now() - started, ticketLength: ticket.length, redactions: null, upstreamStatus: null, usage: null, detail: null },
      };
    }

    // R12 step 3: only redacted text may reach the provider. A redact throw propagates before any egress.
    const { text, counts } = redact(ticket);
    const redactions = { email: counts.email, card: counts.card, phone: counts.phone };

    // R12 step 4: the provider contract says analyse never rejects; anything thrown or malformed is model_error.
    let live;
    try {
      live = await provider.analyse(text);
      if (!isLiveResult(live)) live = PROVIDER_THREW;
    } catch {
      // The error object (and its message, which may quote content) is deliberately discarded.
      live = PROVIDER_THREW;
    }
    const upstreamStatus = Number.isInteger(live.upstreamStatus) ? live.upstreamStatus : null;
    const usage = live.usage === undefined ? null : live.usage;

    // R12 step 5: success → model output; failure → fallback on the ORIGINAL text with the provider's reason.
    if (live.ok === true) {
      return {
        response: buildResponse(live.triage, 'model', null, injectionSuspected, model),
        meta: { latencyMs: now() - started, ticketLength: ticket.length, redactions, upstreamStatus, usage, detail: null },
      };
    }
    const triage = fallbackAnalyse(ticket, detection);
    return {
      response: buildResponse(triage, 'fallback', live.reason, injectionSuspected, null),
      meta: {
        latencyMs: now() - started, ticketLength: ticket.length, redactions, upstreamStatus, usage,
        detail: typeof live.detail === 'string' ? live.detail : null,
      },
    };
  }

  return { mode, model, analyse };
}

module.exports = { createTriageService };
