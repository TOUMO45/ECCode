// e1: the shared PaymentProvider contract suite (test/unit/payments/provider-contract.js, task e0) run against BOTH adapters:
//   1. the DB-backed fake (src/payments/fake.js) over a real SQLite file;
//   2. the Sandbox REST adapter (src/payments/sandbox.js) over the loopback double test/helpers/paypal-stub.js.
// Everything here is a SIMULATION; nothing contacts PayPal. A fault a harness cannot inject makes supports() false and the scenario
// is SKIPPED with its reason (never passed): for the fake those are the OAuth faults (it has no token) and the wire block (it has
// no HTTP wire). The Sandbox harness skips nothing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secret, loadConfig } from '../../../src/config.js';
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';
import { getOrCreateMeta } from '../../../src/db/meta.js';
import { isoFromMs } from '../../../src/clock.js';
import { approveFakeOrder, createFakeProvider, parseFakeFault } from '../../../src/payments/fake.js';
import { startApprovalListener } from '../../../src/payments/listener.js';
import { createSandboxProvider } from '../../../src/payments/sandbox.js';
import { parseFaultName, startPaypalStub } from '../../helpers/paypal-stub.js';
import { MERCHANT, runProviderContract } from './provider-contract.js';

const APP_ORIGIN = 'http://localhost:3000';

export async function createFakeHarness({ log, clock }) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-fake-contract-'));
  const config = loadConfig({
    PORT: '0', RS_DB_PATH: join(dir, 'app.db'), RS_PAYMENT_PROVIDER: 'fake', RS_TEST_OFFLINE: '1', RS_TEST_HOOKS: '1',
    RS_MODEL_PROVIDER: 'fake', RS_FAKE_APPROVAL_PORT: '0',
  });
  const db = openDb(config.dbPath);
  migrate(db, { clock });
  const listener = await startApprovalListener({ db, clock, config, log, appOrigin: APP_ORIGIN });
  const provider = createFakeProvider({ db, clock, log, testHooks: config.testHooks, approvalOrigin: () => listener.origin });
  const secret = getOrCreateMeta(db, 'fake_webhook_secret'); // the SEC-5 key the fake verifies against
  return {
    provider,
    expectations: { id: 'fake', simulated: true, sandbox: false },
    approve: async (orderId) => {
      const { result } = approveFakeOrder(db, orderId);
      if (result !== 'approved' && result !== 'already_approved') throw new Error(`the fake approval step answered ${result}`);
    },
    supports: (fault) => parseFakeFault(fault) !== null,
    inject: (fault, { count = 1 } = {}) => {
      db.prepare('INSERT OR REPLACE INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, ?)')
        .run(`fake_paypal:${fault}`, '', count, isoFromMs(clock.now()));
    },
    clear: () => { db.prepare('DELETE FROM fault_flags').run(); },
    webhookSecret: secret,
    sensitive: () => [secret],
    wire: null,
    close: async () => {
      await listener.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function createSandboxHarness({ timeoutMs, log, clock }) {
  const stub = await startPaypalStub({ clock, appOrigin: APP_ORIGIN });
  const m = stub.merchants[MERCHANT];
  const provider = createSandboxProvider({
    baseUrl: stub.baseUrl,
    merchants: { [MERCHANT]: { clientId: new Secret(m.clientId), clientSecret: new Secret(m.clientSecret), webhookId: new Secret(m.webhookId) } },
    timeoutMs,
    testOffline: true,
    log,
  });
  return {
    provider,
    expectations: { id: 'paypal-sandbox', simulated: false, sandbox: true },
    approve: async (orderId) => stub.approve(orderId),
    supports: (fault) => { try { parseFaultName(fault); return true; } catch { return false; } },
    inject: (fault, { count = 1 } = {}) => stub.fault(fault, { count }),
    clear: () => stub.clearFaults(),
    webhookSecret: stub.webhookSecret,
    sensitive: () => [...stub.issuedTokens(), m.clientId, m.clientSecret, m.webhookId],
    wire: { calls: (kind) => stub.callsOf(kind), clear: () => stub.clearCalls() },
    close: () => stub.close(),
  };
}

runProviderContract({ name: 'fake (DB-backed, src/payments/fake.js)', createAdapter: createFakeHarness });
runProviderContract({ name: 'paypal-sandbox (src/payments/sandbox.js over paypal-stub)', createAdapter: createSandboxHarness });
