'use strict';
const { HttpError } = require('../vendor/acme-kit/http');

/** Username set by the API gateway. */
function currentUser(req) {
  const username = String(req.headers['x-acme-user'] || '').trim();
  if (!username) throw new HttpError(401, 'unauthorized', 'Missing X-Acme-User header');
  return username;
}

module.exports = { currentUser };
