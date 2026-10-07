'use strict';
// TriageDesk browser script (spec §Frontend / Accessibility, C2, C3, C5, C6.6, D1.5).
// Untrusted text (ticket, model output, server bodies) is only ever written with textContent or
// textarea .value. No HTML is ever parsed from data (RISK-8, AC11).
// The pure helpers below are exported under Node for unit tests; the DOM wiring runs only in a browser.

const FALLBACK_REASON_TEXT = {
  no_api_key: 'no API key configured',
  model_error: 'the AI service returned an error',
  timeout: 'the AI service did not respond in time',
  refusal: 'the AI declined to analyse this ticket',
  truncated: 'the AI response was cut off',
  invalid_output: 'the AI response failed the format and safety checks',
};

/** D1.5 wording for a fallbackReason code. Unknown codes get a neutral text. */
function fallbackReasonText(code) {
  return Object.prototype.hasOwnProperty.call(FALLBACK_REASON_TEXT, code) ? FALLBACK_REASON_TEXT[code] : 'unknown reason';
}

/** R5/AC5: visible source label. Anything that is not source "model" is labelled "not AI-generated". */
function sourceLabel(resp) {
  if (resp && resp.source === 'model') return 'AI suggestion (model: ' + String(resp.model) + ')';
  const code = resp && typeof resp.fallbackReason === 'string' ? resp.fallbackReason : 'unknown';
  return 'Deterministic fallback — not AI-generated (reason: ' + code + ' — ' + fallbackReasonText(code) + ')';
}

/** §Frontend error table. status 0 means the request never reached the server (network error). */
function errorMessage(status, code) {
  if (status === 0) return 'Could not reach the TriageDesk server. Check that it is running and try again.';
  if (status === 400 && code === 'ticket_empty') return 'Paste a ticket before analysing.';
  if ((status === 400 && code === 'ticket_too_long') || status === 413) {
    return 'The ticket is too long. Shorten it to 8,000 characters and try again.';
  }
  if (status === 400 || status === 415) return 'The request was not accepted. Reload the page and try again.';
  if (status === 403) {
    return "Request blocked by the server's host/origin check. Open the app at the address the server printed (http://127.0.0.1:<port>).";
  }
  return 'Something went wrong on the server. Try again.';
}

/** Header badge text from a GET /api/health body, or null when the health check failed. */
function modeBadgeText(health) {
  if (health && health.mode === 'live') return 'Live: AI model ' + String(health.model);
  if (health && health.mode === 'fallback') return 'Fallback mode: deterministic rules, no AI';
  return 'Mode unknown (health check failed)';
}

if (typeof module === 'object' && module.exports) {
  module.exports = { sourceLabel, fallbackReasonText, errorMessage, modeBadgeText };
}

if (typeof document !== 'undefined') {
  (function wire() {
    const MAX_CHARS = 8000;
    const $ = (id) => document.getElementById(id);
    const form = $('triage-form');
    const ticket = $('ticket');
    const count = $('ticket-count');
    const analyseButton = $('analyse');
    const status = $('status');
    const badge = $('mode-badge');
    const liveNotice = $('live-notice');
    const result = $('result');
    const label = $('source-label');
    const warning = $('injection-warning');
    const category = $('result-category');
    const urgency = $('result-urgency');
    const summary = $('result-summary');
    const reply = $('reply');
    const copyButton = $('copy');
    const resetButton = $('reset');

    // The only client state (§Frontend): nothing is stored.
    const state = { busy: false, original: '', health: null };

    function announce(text) {
      status.textContent = text;
    }

    function setBusy(busy) {
      state.busy = busy;
      analyseButton.disabled = busy;
      if (busy) form.setAttribute('aria-busy', 'true');
      else form.removeAttribute('aria-busy');
    }

    function updateCount() {
      count.textContent = ticket.value.length + ' / ' + MAX_CHARS + ' characters';
    }

    async function readJson(res) {
      try {
        return await res.json();
      } catch (_) {
        return null;
      }
    }

    async function loadHealth() {
      let health = null;
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          const body = await readJson(res);
          if (body && (body.mode === 'live' || body.mode === 'fallback')) health = body;
        }
      } catch (_) {
        health = null;
      }
      state.health = health;
      badge.textContent = modeBadgeText(health);
      badge.className = 'badge ' + (health ? 'badge-' + health.mode : 'badge-unknown');
      liveNotice.hidden = !(health && health.mode === 'live');
    }

    function isValidResponse(body) {
      return Boolean(body) && typeof body === 'object' &&
        typeof body.category === 'string' && typeof body.urgency === 'string' &&
        typeof body.summary === 'string' && typeof body.suggestedReply === 'string' &&
        (body.source === 'model' || body.source === 'fallback') && typeof body.injectionSuspected === 'boolean';
    }

    function showResult(body) {
      const text = sourceLabel(body);
      label.textContent = text;
      label.className = 'source-label ' + (body.source === 'model' ? 'source-model' : 'source-fallback');
      category.textContent = body.category;
      urgency.textContent = body.urgency;
      summary.textContent = body.summary;
      state.original = body.suggestedReply;
      reply.value = body.suggestedReply;
      warning.hidden = body.injectionSuspected !== true;
      result.hidden = false;
      announce('Analysis complete: category ' + body.category + ', urgency ' + body.urgency + '. ' + text + '.');
    }

    function showError(message) {
      result.hidden = true;
      announce(message);
    }

    async function analyse() {
      if (state.busy) return;
      const value = ticket.value;
      if (value.trim().length === 0) {
        announce(errorMessage(400, 'ticket_empty'));
        ticket.focus();
        return;
      }
      setBusy(true);
      announce('Analysing…');
      let res;
      try {
        res = await fetch('/api/triage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: value }),
        });
      } catch (_) {
        setBusy(false);
        showError(errorMessage(0, null));
        return;
      }
      const body = await readJson(res);
      setBusy(false);
      if (res.ok && isValidResponse(body)) {
        showResult(body);
        return;
      }
      if (res.ok) {
        // A 2xx that is not a TriageResponse is a server-side fault.
        showError(errorMessage(500, null));
        return;
      }
      const code = body && body.error && typeof body.error.code === 'string' ? body.error.code : null;
      showError(errorMessage(res.status, code));
    }

    async function copyReply() {
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no clipboard');
        await navigator.clipboard.writeText(reply.value);
        announce('Reply copied to clipboard.');
      } catch (_) {
        announce('Copy failed — select the reply text and press Ctrl+C.');
        reply.focus();
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      analyse();
    });
    ticket.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        analyse();
      }
    });
    ticket.addEventListener('input', updateCount);
    copyButton.addEventListener('click', () => {
      copyReply();
    });
    resetButton.addEventListener('click', () => {
      reply.value = state.original;
      announce('Reply reset to the original suggestion.');
    });

    updateCount();
    loadHealth();
  })();
}
