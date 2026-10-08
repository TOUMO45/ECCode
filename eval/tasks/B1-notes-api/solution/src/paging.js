'use strict';
const { HttpError } = require('../vendor/acme-kit/http');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** ?limit (1..100, default 50) and ?offset (>= 0, default 0); invalid values are a 422. */
function parsePaging(query) {
  const fields = [];
  const limit = query.has('limit') ? query.get('limit') : String(DEFAULT_LIMIT);
  const offset = query.has('offset') ? query.get('offset') : '0';
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_LIMIT) fields.push('limit');
  if (!/^\d+$/.test(offset)) fields.push('offset');
  if (fields.length) throw new HttpError(422, 'validation_failed', 'Invalid paging parameters', { fields });
  return { limit: Number(limit), offset: Number(offset) };
}

/** Collection envelope: one page of `all` plus the number of matching records. */
function page(all, { limit, offset }) {
  return { items: all.slice(offset, offset + limit), total: all.length };
}

module.exports = { parsePaging, page };
