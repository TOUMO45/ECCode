'use strict';
// ?limit (default 50, 1..100) and ?offset (default 0) for collection endpoints.

const INT = /^\d+$/;

function parsePage(query) {
  const fields = [];
  let limit = 50;
  let offset = 0;
  const l = query.get('limit');
  const o = query.get('offset');
  if (l !== null) {
    if (INT.test(l) && Number(l) >= 1 && Number(l) <= 100) limit = Number(l);
    else fields.push('limit');
  }
  if (o !== null) {
    if (INT.test(o)) offset = Number(o);
    else fields.push('offset');
  }
  return { limit, offset, fields };
}

function page(all, { limit, offset }) {
  return { items: all.slice(offset, offset + limit), total: all.length };
}

module.exports = { parsePage, page };
