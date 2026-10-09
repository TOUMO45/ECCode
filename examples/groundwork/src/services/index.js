// Lazily builds the domain services once per app context.
import { createProviderRegistry } from './providers.js';
import { createIncidentService } from './incidents.js';
import { createDraftService } from './drafts.js';

const cache = new WeakMap();

export function getServices(ctx) {
  let s = cache.get(ctx);
  if (!s) {
    const providers = createProviderRegistry({ config: ctx.config, providers: ctx.providers, log: ctx.log });
    const incidents = createIncidentService({ db: ctx.db, audit: ctx.audit, clock: ctx.clock });
    const drafts = createDraftService({
      db: ctx.db, audit: ctx.audit, clock: ctx.clock, users: ctx.users, providers, log: ctx.log, config: ctx.config,
    });
    s = { providers, incidents, drafts };
    cache.set(ctx, s);
  }
  return s;
}
