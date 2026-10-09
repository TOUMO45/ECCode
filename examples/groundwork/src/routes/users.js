import { requests } from '../api/contract-schemas.js';
import { ApiError } from '../http/envelope.js';
import { isUniqueViolation } from '../auth/users.js';

export default function register(router, ctx) {
  router.get('/api/users', { action: 'user.list' }, async (rc) => ({
    body: { users: ctx.users.listByTeam(rc.user.teamId) },
  }));

  router.post('/api/users', { action: 'user.create', body: requests.createUser }, async (rc) => {
    const { username, displayName, password, role } = rc.body;
    const actor = { id: rc.user.id, name: rc.user.username };
    const base = { teamId: rc.user.teamId, actor, action: 'user.create', targetType: 'user', ip: rc.ip, requestId: rc.requestId };
    let user;
    try {
      if (ctx.users.findByUsername(username)) throw new ApiError('USERNAME_TAKEN');
      user = await ctx.users.create({ teamId: rc.user.teamId, username, displayName: displayName.trim() || username, role, password });
    } catch (err) {
      if (err instanceof ApiError || isUniqueViolation(err)) {
        ctx.audit.record({ ...base, outcome: 'fail', detail: { reason: 'username_taken' } });
        throw err instanceof ApiError ? err : new ApiError('USERNAME_TAKEN');
      }
      throw err;
    }
    ctx.audit.record({ ...base, targetId: user.id, detail: { username: user.username, role: user.role } });
    return { status: 201, body: { user } };
  });
}
