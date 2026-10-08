'use strict';

/** Append one row to audit_log for a successful write. */
function record(db, req, now, action, entity, entityId) {
  db.insert('audit_log', {
    actor: req.headers['x-acme-actor'] || 'anonymous',
    action,
    entity,
    entity_id: entityId,
    at: now().toISOString(),
  });
}

module.exports = { record };
