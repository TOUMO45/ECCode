// Registers every route module on the router. Each module exports
// register(router, deps), where deps = { db, clock, config, log, ai, payments, publicUrl }.
// Every router.add call must declare its access policy next to the route.
import { register as health } from './health.js';
import { register as appConfig } from './config.js';
import { register as auth } from './auth.js';
import { register as requests } from './requests.js';
import { register as plans } from './plans.js';
import { register as orders } from './orders.js';
import { register as paypal } from './paypal.js';
import { register as supplier } from './supplier.js';
import { register as admin } from './admin.js';
import { register as webhooks } from './webhooks.js';

export function registerRoutes(router, deps) {
  for (const register of [health, appConfig, auth, requests, plans, orders, paypal, supplier, admin, webhooks]) {
    register(router, deps);
  }
}
