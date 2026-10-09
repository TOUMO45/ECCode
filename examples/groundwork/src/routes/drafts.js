import { requests } from '../api/contract-schemas.js';
import { ApiError } from '../http/envelope.js';
import { getServices } from '../services/index.js';

export default function register(router, ctx) {
  const { incidents, drafts } = getServices(ctx);

  router.post('/api/incidents/:id/draft', { action: 'draft.generate', body: requests.generateDraft }, async (rc) => {
    const incident = incidents.require(rc.params.id, rc.user.teamId);
    rc.extendTimeout?.(160000); // this route alone may run longer than the 30 s default
    const out = await drafts.generate({
      incident, user: rc.user, choice: rc.body.provider ?? 'auto', ip: rc.ip, requestId: rc.requestId,
    });
    return { status: 201, body: out };
  });

  router.get('/api/incidents/:id/draft', { action: 'draft.read' }, async (rc) => {
    incidents.require(rc.params.id, rc.user.teamId);
    const draft = drafts.byIncident(rc.params.id, rc.user.teamId);
    if (!draft) throw new ApiError('NOT_FOUND');
    return { body: { draft } };
  });

  router.patch('/api/drafts/:id/statements/:sid', { action: 'statement.edit', body: requests.editStatement }, async (rc) => ({
    body: { draft: drafts.edit({ draftId: rc.params.id, sid: rc.params.sid, user: rc.user, body: rc.body, ip: rc.ip, requestId: rc.requestId }) },
  }));

  router.delete('/api/drafts/:id/statements/:sid', { action: 'statement.delete', query: requests.deleteStatementQuery }, async (rc) => ({
    body: {
      draft: drafts.remove({
        draftId: rc.params.id, sid: rc.params.sid, user: rc.user, expectedVersion: rc.query.expectedVersion, ip: rc.ip, requestId: rc.requestId,
      }),
    },
  }));

  router.post('/api/drafts/:id/publish', { action: 'draft.publish', body: requests.publish }, async (rc) => ({
    body: { draft: drafts.publish({ draftId: rc.params.id, user: rc.user, expectedVersion: rc.body.expectedVersion, ip: rc.ip, requestId: rc.requestId }) },
  }));
}
