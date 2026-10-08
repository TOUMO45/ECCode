'use strict';
// Client for the corporate HR directory (backed by the users and
// site_assignments tables here). In production every lookup is a network
// round trip of about 300 ms: never call it once per request.

function lookup(db, username) {
  const [user] = db.all('users', { username: String(username) });
  if (!user) return null;
  const siteIds = db.all('site_assignments', { user_id: user.id }).map((a) => a.site_id);
  return { id: user.id, username: user.username, name: user.name, role: user.role, siteIds };
}

module.exports = { lookup };
