import { getServices } from '../services/index.js';

export default function register(router, ctx) {
  router.get('/api/providers', { action: 'provider.list' }, async () => ({ body: await getServices(ctx).providers.list() }));
}
