'use strict';
// Stub of src/ticket-input.js for runner execution-path tests (synthetic fixture).
function validateTicketInput(body) {
  const t = typeof body.ticket === 'string' ? body.ticket.trim() : '';
  if (!t) return { ok: false, status: 400, code: 'ticket_empty', message: 'empty' };
  return { ok: true, ticket: t };
}
module.exports = { validateTicketInput };
