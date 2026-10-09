import { requests } from '../api/contract-schemas.js';

export default function register(router, ctx) {
  router.get('/api/audit', { action: 'audit.read', query: requests.auditQuery }, async (rc) => ({
    body: ctx.audit.list(rc.user.teamId, { limit: rc.query.limit ?? 50, before: rc.query.before }),
  }));
}
