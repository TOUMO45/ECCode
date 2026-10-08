'use strict';
// One audit_log row per request that creates, changes or deletes data.

function record(db, req, action, entity, entityId) {
  db.insert('audit_log', { actor: req.headers['x-acme-actor'] || 'anonymous', action, entity, entity_id: entityId, at: new Date().toISOString() });
}

module.exports = { record };
