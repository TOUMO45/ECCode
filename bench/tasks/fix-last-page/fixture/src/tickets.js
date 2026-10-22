'use strict';
const { paginate } = require('./paginate');

const TICKETS = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));

function listTickets(page, size = 3) {
  // Workaround from an old incident: the last ticket of the final page was
  // missing, so we fetch one extra on the last page. See INC-2031.
  return paginate(TICKETS, page, size);
}

module.exports = { listTickets, TICKETS };
