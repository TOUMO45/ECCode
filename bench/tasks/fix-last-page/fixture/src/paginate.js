'use strict';
// Shared pagination for every listing endpoint. Pages are 1-based.

function paginate(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size - 1);
}

function pageCount(total, size) {
  return Math.ceil(total / size);
}

module.exports = { paginate, pageCount };
