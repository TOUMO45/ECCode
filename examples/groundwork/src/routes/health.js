import { schemaVersion } from '../db/migrate.js';

export default function register(router, ctx) {
  router.get('/api/health', { auth: 'none' }, async () => ({
    body: { status: 'ok', version: ctx.version, schemaVersion: schemaVersion(ctx.db) },
  }));
}
