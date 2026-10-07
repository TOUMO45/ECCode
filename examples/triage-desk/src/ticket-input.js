'use strict';
// Pure request-body validation for POST /api/triage (spec C3 validation table, C5 messages, C6.4, DES-5).
// The first row of the C3 table (empty body / JSON.parse throws → invalid_json) is decided by http-server.js,
// which parses the body; this function receives the parsed value and applies the remaining rows in order.

const MAX_TICKET_CHARS = 8000;

const FAILURES = Object.freeze({
  invalid_request: 'Request body must be a JSON object with a string "ticket".',
  ticket_empty: 'Ticket text is empty.',
  ticket_too_long: 'Ticket text exceeds 8000 characters.',
});

function fail(code) {
  return { ok: false, status: 400, code, message: FAILURES[code] };
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} parsedBody the value produced by JSON.parse of the request body
 * @returns {{ok:true, ticket:string} | {ok:false, status:400, code:string, message:string}} ticket is trimmed
 */
function validateTicketInput(parsedBody) {
  if (!isPlainObject(parsedBody)) return fail('invalid_request');
  if (!Object.prototype.hasOwnProperty.call(parsedBody, 'ticket')) return fail('invalid_request');
  const ticket = parsedBody.ticket;
  if (typeof ticket !== 'string') return fail('invalid_request');
  const trimmed = ticket.trim();
  if (trimmed.length === 0) return fail('ticket_empty');
  if (trimmed.length > MAX_TICKET_CHARS) return fail('ticket_too_long');
  return { ok: true, ticket: trimmed };
}

module.exports = { validateTicketInput };
