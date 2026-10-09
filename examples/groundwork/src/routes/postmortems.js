import { ApiError } from '../http/envelope.js';
import { getServices } from '../services/index.js';

export default function register(router, ctx) {
  const { drafts } = getServices(ctx);

  router.get('/api/postmortems', { action: 'postmortem.read' }, async (rc) => ({
    body: { postmortems: drafts.listPublished(rc.user.teamId) },
  }));

  router.get('/api/postmortems/:draftId', { action: 'postmortem.read' }, async (rc) => {
    const postmortem = drafts.getPublished(rc.params.draftId, rc.user.teamId);
    if (!postmortem) throw new ApiError('NOT_FOUND');
    return { body: { postmortem } };
  });
}
