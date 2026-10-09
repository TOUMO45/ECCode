import { notesSchemaFor } from '../api/contract-schemas.js';
import { getServices } from '../services/index.js';

export default function register(router, ctx) {
  const { incidents } = getServices(ctx);

  router.get('/api/incidents/:id/notes', { action: 'notes.read' }, async (rc) => ({
    body: { lines: incidents.notes(rc.params.id, rc.user.teamId) },
  }));

  router.put('/api/incidents/:id/notes', { action: 'notes.replace', body: notesSchemaFor }, async (rc) => ({
    body: incidents.replaceNotes({ id: rc.params.id, user: rc.user, body: rc.body, ip: rc.ip, requestId: rc.requestId }),
  }));
}
