'use strict';
// Ticket list helpers used by the sync pipeline.

function byPriority(tickets) {
  return [...tickets].sort((a, b) => b.priority - a.priority);
}

module.exports = { byPriority };
