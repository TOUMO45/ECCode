'use strict';
// One audit_log row per successful write.

function recordAudit(db, req, { action, entity, entityId }) {
  const actor = String(req.headers['x-acme-actor'] || '').trim() || 'anonymous';
  db.insert('audit_log', { actor, action, entity, entity_id: entityId, at: new Date().toISOString() });
}

module.exports = { recordAudit };
