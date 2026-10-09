import { requests } from '../api/contract-schemas.js';
import { ApiError } from '../http/envelope.js';
import { getServices } from '../services/index.js';

export default function register(router, ctx) {
  const { incidents } = getServices(ctx);

  router.get('/api/incidents', { action: 'incident.list' }, async (rc) => ({
    body: { incidents: incidents.list(rc.user.teamId) },
  }));

  router.post('/api/incidents', { action: 'incident.create', body: requests.createIncident }, async (rc) => {
    const { title, startedAt } = rc.body;
    if (title.trim() === '') {
      throw new ApiError('VALIDATION_FAILED', { details: { fields: [{ path: 'title', message: 'must not be blank' }] } });
    }
    if (Number.isNaN(Date.parse(startedAt))) {
      throw new ApiError('VALIDATION_FAILED', { details: { fields: [{ path: 'startedAt', message: 'must be an ISO 8601 date-time' }] } });
    }
    const incident = incidents.create({ user: rc.user, body: rc.body, ip: rc.ip, requestId: rc.requestId });
    return { status: 201, body: { incident } };
  });

  router.get('/api/incidents/:id', { action: 'incident.get' }, async (rc) => ({
    body: { incident: incidents.require(rc.params.id, rc.user.teamId) },
  }));
}
