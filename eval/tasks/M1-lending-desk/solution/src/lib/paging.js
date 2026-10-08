'use strict';

/** Parse ?limit (default 50, 1..100) and ?offset (default 0). `fields` lists the invalid parameters. */
function parsePage(query) {
  const fields = [];
  let limit = 50;
  let offset = 0;
  const l = query.get('limit');
  if (l !== null) {
    if (/^\d+$/.test(l) && Number(l) >= 1 && Number(l) <= 100) limit = Number(l);
    else fields.push('limit');
  }
  const o = query.get('offset');
  if (o !== null) {
    if (/^\d+$/.test(o)) offset = Number(o);
    else fields.push('offset');
  }
  return { limit, offset, fields };
}

module.exports = { parsePage };
