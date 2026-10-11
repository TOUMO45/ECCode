// PaymentProvider contract suite (Testing Strategy, contract tests (b); plan task e0-paypal-stub-contract).
//
// SIMULATION NOTICE. Every check runs against a fake or against src/payments/sandbox.js talking to the loopback
// double test/helpers/paypal-stub.js. Nothing here contacts PayPal or proves how the real Sandbox behaves; the issue
// names, link rels and status sets are the spec's guesses ("verify on Sandbox"), confirmed only by the opt-in live suite.
//
// ONE suite, consumed by e1's test/unit/payments/provider-contract.test.js, which calls it once per adapter:
//
//   import { runProviderContract } from './provider-contract.js';
//   runProviderContract({ name: 'fake', createAdapter: createFakeHarness });
//   runProviderContract({ name: 'paypal-sandbox (paypal-stub)', createAdapter: createSandboxHarness });
//
// runProviderContract({ name, createAdapter, timeoutMs = 400 }) registers a node:test `describe`. The suite calls
// `createAdapter(ctx)` once for the shared harness, and again (a fresh, empty-cache adapter) for the OAuth tests.
//
// ---- FACTORY CONTRACT ---------------------------------------------------------------------------------------------
//
// createAdapter(ctx) -> Promise<Harness>
//
//   ctx = {
//     merchantKey: 'DEFAULT',        // the merchant key the suite passes in every provider call
//     timeoutMs: number,             // the adapter's per-call bound (RS_PAYPAL_TIMEOUT_MS equivalent). Small (500) so the
//                                    // timeout cases finish quickly. Fake adapters may ignore it.
//     log: Logger,                   // createLogger() from src/log.js ({debug,info,warn,error,child}); its sink is captured
//                                    // by the suite. The adapter must log only through it (or not at all).
//     clock: { now() },              // the TIME SOURCE OF THE SIMULATED PROVIDER SIDE (fixed at 2026-10-20T06:00:00Z).
//                                    // Authorization expiry (29 days) is computed from it. Pass it to the stub / the fake.
//   }
//
//   Harness = {
//     provider,                      // a PaymentProvider (spec "Internal module contracts"): id, simulated, sandbox and the
//                                    // ten methods. Called ONLY with the argument shapes of the spec.
//     expectations: { id: 'fake' | 'paypal-sandbox', simulated: boolean, sandbox: boolean },
//     approve(orderId): Promise<void>,   // the buyer approves the order (CREATED -> APPROVED): stub.approve(id) for the
//                                    // Sandbox harness, the fake approval step for the fake. The order id is the Outcome's
//                                    // `orderId` from createOrder.
//     supports(fault): boolean,      // can this harness inject `fault`? (vocabulary below). An unsupported fault turns the
//                                    // test that needs it into a SKIPPED test with the reason; it is never a pass.
//     inject(fault, { count = 1 } = {}): void,   // arm a fault for the next `count` matching calls
//     clear(): void,                 // disarm every fault (the suite calls it after each test)
//     webhookSecret: string,         // the secret the harness's verifier checks signatures against (webhook-signer.js)
//     sensitive(): string[],         // strings that must never reach a log line or an Outcome: issued access tokens, the
//                                    // client id/secret, webhook ids. May be empty for an adapter without credentials.
//                                    // The suite adds the fake payer data, the stub's body marker and the return URL marker.
//     wire: null | { calls(kind): Record[], clear(): void },   // Sandbox harness only: the loopback double's recorded
//                                    // requests of a kind, in the record shape of paypal-stub.js (headers, rawBody, body,
//                                    // requestId, webhookEventRaw). null for the fake: the wire block is then SKIPPED.
//     close(): Promise<void> | void, // release servers, databases, timers
//   }
//
// Fault vocabulary (the admin fault names of the spec + the transport faults of the Outcome classes), <kind> being one of
// create_order get_order authorize get_authorization capture get_capture void refund get_refund verify_webhook token:
//   http_<NNN>:<kind>  lost_response:<kind>  timeout:<kind>  bad_body:<kind>
//   authorize_denied authorize_pending capture_declined capture_pending refund_pending refund_failed void_fail auth_expire
// A fault with count 1 affects exactly the next call of that kind; transport faults other than lost_response and bad_body
// leave no effect behind, lost_response and bad_body leave the effect applied (and stored for replay by requestId).
//
// ---- WHAT IS ASSERTED ---------------------------------------------------------------------------------------------
//   - identity: id, simulated, sandbox, the ten methods;
//   - every method's ok value shape (spec Outcome types) and its definitive rejections (unknown ids, wrong state,
//     AUTHORIZATION_ALREADY_CAPTURED, CAPTURE_FULLY_REFUNDED);
//   - replay: the same requestId returns the same resource and applies nothing twice (createOrder, authorize, capture, void,
//     refund); a lost or timed-out answer retried with the same requestId converges on exactly one effect;
//   - each Outcome kind for each method: rejected (4xx), retryable (429), unknown (5xx, timeout, network, bad_body);
//   - the status variants (DENIED, PENDING, DECLINED, FAILED, EXPIRED, 29-day expiry);
//   - verifyWebhook: signed ok, tampered body, wrong secret, missing headers, byte-exact non-canonical bodies;
//   - OAuth failures and timeouts become Outcomes (fresh adapter);
//   - wire mapping (when harness.wire): PayPal-Request-Id, one cached token, amount strings without floating point,
//     body fields of every mutating row, the raw webhook bytes spliced unchanged;
//   - logging: no log line, no stdout/stderr output and no Outcome contains a body, a token, a credential or payer data,
//     and every log line is JSON with a requestId.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../../src/log.js';
import { fixedClock } from '../../../src/clock.js';
import { BODY_MARKER, STUB_START_MS } from '../../helpers/paypal-stub.js';
import { PAYER_MARKERS, buildEvent, signEvent, tamperBody } from '../../helpers/webhook-signer.js';

export const MERCHANT = 'DEFAULT';
export const RETURN_URL_MARKER = 'RETURN-URL-MARKER-5b2e';
export const RETURN_URL = `http://localhost:3000/api/paypal/return/${RETURN_URL_MARKER}`;
export const CANCEL_URL = 'http://localhost:3000/api/paypal/cancel';
export const OUTCOME_KINDS = Object.freeze(['ok', 'rejected', 'retryable', 'unknown']);
export const UNKNOWN_REASONS = Object.freeze(['timeout', 'network', 'http_5xx', 'bad_body']);
export const PROVIDER_METHODS = Object.freeze([
  'createOrder', 'getOrder', 'authorizeOrder', 'getAuthorization', 'captureAuthorization', 'getCapture',
  'voidAuthorization', 'refundCapture', 'getRefund', 'verifyWebhook',
]);
const DAY_MS = 24 * 60 * 60 * 1000;

// Strings found in `texts` (an array of strings) from `markers`; empty strings are ignored. Exported so the stub's own
// tests can prove that a planted leak is caught.
export function findLeaks(texts, markers) {
  const found = [];
  for (const marker of markers) {
    if (typeof marker !== 'string' || marker === '') continue;
    const where = texts.findIndex((t) => t.includes(marker));
    if (where >= 0) found.push({ marker, index: where });
  }
  return found;
}

export function assertOutcome(outcome, label = 'outcome') {
  assert.ok(outcome !== null && typeof outcome === 'object', `${label}: an Outcome object`);
  assert.ok(OUTCOME_KINDS.includes(outcome.kind), `${label}: kind ${String(outcome.kind)} is one of ${OUTCOME_KINDS.join(', ')}`);
  if (outcome.kind === 'ok') {
    assert.ok(Number.isInteger(outcome.httpStatus) && outcome.httpStatus >= 200 && outcome.httpStatus < 300, `${label}: ok has a 2xx httpStatus`);
    assert.ok(outcome.value !== null && typeof outcome.value === 'object', `${label}: ok has a value object`);
  } else if (outcome.kind === 'rejected' || outcome.kind === 'retryable') {
    assert.ok(Number.isInteger(outcome.httpStatus), `${label}: ${outcome.kind} has an integer httpStatus`);
    assert.ok(typeof outcome.issue === 'string' && outcome.issue !== '', `${label}: ${outcome.kind} has a non-empty issue`);
  } else {
    assert.ok(UNKNOWN_REASONS.includes(outcome.reason), `${label}: unknown reason ${String(outcome.reason)} is one of ${UNKNOWN_REASONS.join(', ')}`);
  }
}

function outputCapture() {
  const chunks = [];
  const originals = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write;
    originals.push([stream, original]);
    stream.write = function capturingWrite(chunk, ...rest) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return original.call(stream, chunk, ...rest);
    };
  }
  return {
    chunks,
    stop() { for (const [stream, original] of originals) stream.write = original; },
  };
}

export function runProviderContract({ name, createAdapter, timeoutMs = 500 }) {
  if (typeof createAdapter !== 'function') throw new TypeError('createAdapter must be a function');

  describe(`PaymentProvider contract: ${name}`, () => {
    const clock = fixedClock(STUB_START_MS);
    const logLines = [];
    const log = createLogger({ write: (line) => logLines.push(line), clock, requestId: 'contract-suite' });
    const outcomes = []; // every Outcome the suite saw, for the leak check
    const extraHarnesses = [];
    let h;
    let seq = 1000;

    const ctx = () => ({ merchantKey: MERCHANT, timeoutMs, log, clock });
    const rid = (kind) => `so:${seq += 1}:${kind}:1`;

    before(async () => {
      h = await createAdapter(ctx());
    });
    afterEach(() => {
      h?.clear();
    });
    after(async () => {
      for (const extra of extraHarnesses) await extra.close();
      await h?.close();
    });

    const p = () => h.provider;
    const seen = (outcome) => { outcomes.push(outcome); return outcome; };
    const need = (t, fault) => {
      if (h.supports(fault)) return true;
      t.skip(`harness "${name}" cannot inject ${fault}`);
      return false;
    };
    function ok(outcome, what) {
      assertOutcome(outcome, what);
      assert.equal(outcome.kind, 'ok', `${what} should be ok, got kind ${outcome.kind} (${outcome.issue ?? outcome.reason ?? ''})`);
      return outcome.value;
    }

    // ---- world builders (every one goes through the provider under test) ---------------------------------------------
    async function createOrder(amountCents = 1250, requestId = rid('create_order')) {
      const referenceId = `so-${seq}`;
      return seen(await p().createOrder({
        merchantKey: MERCHANT, requestId, amountCents, currency: 'USD', referenceId, returnUrl: RETURN_URL, cancelUrl: CANCEL_URL,
      }));
    }
    const newOrder = async (amountCents) => ok(await createOrder(amountCents), 'createOrder').orderId;
    async function approvedOrder(amountCents) {
      const orderId = await newOrder(amountCents);
      await h.approve(orderId);
      return orderId;
    }
    const authorize = async (orderId, requestId = rid('authorize')) =>
      seen(await p().authorizeOrder({ merchantKey: MERCHANT, requestId, orderId }));
    async function authorized(amountCents = 1250) {
      const orderId = await approvedOrder(amountCents);
      const value = ok(await authorize(orderId), 'authorizeOrder');
      return { orderId, authorizationId: value.authorizationId, amountCents };
    }
    const capture = async (world, requestId = rid('capture'), amountCents = world.amountCents) =>
      seen(await p().captureAuthorization({
        merchantKey: MERCHANT, requestId, authorizationId: world.authorizationId, amountCents, currency: 'USD', invoiceId: `rs-so-${seq}-cap`,
      }));
    async function captured(amountCents = 1250) {
      const world = await authorized(amountCents);
      const value = ok(await capture(world), 'captureAuthorization');
      return { ...world, captureId: value.captureId };
    }
    const refund = async (world, requestId = rid('refund'), amountCents = world.amountCents) =>
      seen(await p().refundCapture({ merchantKey: MERCHANT, requestId, captureId: world.captureId, amountCents, currency: 'USD' }));
    async function refunded(amountCents = 1250) {
      const world = await captured(amountCents);
      const value = ok(await refund(world), 'refundCapture');
      return { ...world, refundId: value.refundId };
    }
    const voidAuth = async (world, requestId = rid('void')) =>
      seen(await p().voidAuthorization({ merchantKey: MERCHANT, requestId, authorizationId: world.authorizationId }));
    const getOrder = async (orderId) => seen(await p().getOrder({ merchantKey: MERCHANT, orderId }));
    const getAuthorization = async (authorizationId) => seen(await p().getAuthorization({ merchantKey: MERCHANT, authorizationId }));
    const getCapture = async (captureId) => seen(await p().getCapture({ merchantKey: MERCHANT, captureId }));
    const getRefund = async (refundId) => seen(await p().getRefund({ merchantKey: MERCHANT, refundId }));

    function signedWebhook(overrides = {}) {
      const event = buildEvent({ eventType: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-WEBHOOK-1', status: 'COMPLETED' }, withPayer: true });
      return signEvent({ event, secret: h.webhookSecret, transmissionTime: new Date(clock.now()).toISOString(), ...overrides });
    }
    const verify = async ({ headers, rawBody }) => seen(await p().verifyWebhook({ merchantKey: MERCHANT, headers, rawBody }));

    // ---- identity ------------------------------------------------------------------------------------------------
    describe('identity', () => {
      test('the provider exposes id, simulated, sandbox and the ten methods', () => {
        assert.equal(p().id, h.expectations.id);
        assert.equal(p().simulated, h.expectations.simulated);
        assert.equal(p().sandbox, h.expectations.sandbox);
        assert.ok(['fake', 'paypal-sandbox'].includes(p().id));
        for (const method of PROVIDER_METHODS) assert.equal(typeof p()[method], 'function', `${method} is a function`);
      });
    });

    // ---- createOrder -------------------------------------------------------------------------------------------------
    describe('createOrder', () => {
      test('ok: orderId, an absolute approvalUrl and status CREATED', async () => {
        const value = ok(await createOrder(), 'createOrder');
        assert.equal(typeof value.orderId, 'string');
        assert.notEqual(value.orderId, '');
        assert.equal(value.status, 'CREATED');
        assert.match(value.approvalUrl, /^https?:\/\/[^\s]+$/);
        assert.doesNotThrow(() => new URL(value.approvalUrl));
      });

      test('replay: the same requestId returns the same order, a new requestId a new one', async () => {
        const requestId = rid('create_order');
        const first = ok(await createOrder(1250, requestId), 'first');
        const second = ok(await createOrder(1250, requestId), 'replay');
        assert.equal(second.orderId, first.orderId);
        assert.equal(second.approvalUrl, first.approvalUrl);
        const third = ok(await createOrder(1250), 'new requestId');
        assert.notEqual(third.orderId, first.orderId);
      });

      test('amounts are integer cents: 5, 1250 and 100000 cents all create orders', async () => {
        for (const cents of [5, 1250, 100000]) ok(await createOrder(cents), `createOrder ${cents}`);
      });
    });

    // ---- getOrder ------------------------------------------------------------------------------------------------------
    describe('getOrder', () => {
      test('ok on a new order: status and empty authorization, capture and refund lists', async () => {
        const orderId = await newOrder();
        const value = ok(await getOrder(orderId), 'getOrder');
        assert.equal(typeof value.status, 'string');
        assert.deepEqual([value.authorizations, value.captures, value.refunds], [[], [], []]);
      });

      test('after the whole flow it lists the authorization, the capture (with authorizationId) and the refund (with captureId)', async () => {
        const world = await refunded();
        const value = ok(await getOrder(world.orderId), 'getOrder');
        assert.equal(value.authorizations.length, 1);
        assert.equal(value.authorizations[0].id, world.authorizationId);
        assert.equal(typeof value.authorizations[0].status, 'string');
        assert.ok(!Number.isNaN(Date.parse(value.authorizations[0].expirationTime)), 'expirationTime is a date');
        assert.equal(value.captures.length, 1);
        assert.equal(value.captures[0].id, world.captureId);
        assert.equal(value.captures[0].authorizationId, world.authorizationId);
        assert.equal(typeof value.captures[0].status, 'string');
        assert.equal(value.refunds.length, 1);
        assert.equal(value.refunds[0].id, world.refundId);
        assert.equal(value.refunds[0].captureId, world.captureId);
        assert.equal(typeof value.refunds[0].status, 'string');
      });

      test('an unknown order id is rejected', async () => {
        const outcome = await getOrder('NO-SUCH-ORDER-0001');
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
      });
    });

    // ---- authorizeOrder ------------------------------------------------------------------------------------------------
    describe('authorizeOrder', () => {
      test('ok on an approved order: authorizationId, status CREATED, expirationTime 29 days ahead', async () => {
        const orderId = await approvedOrder();
        const value = ok(await authorize(orderId), 'authorizeOrder');
        assert.equal(typeof value.authorizationId, 'string');
        assert.equal(value.status, 'CREATED');
        const ms = Date.parse(value.expirationTime);
        assert.ok(ms >= clock.now() + 28 * DAY_MS && ms <= clock.now() + 30 * DAY_MS, `expirationTime ${value.expirationTime} is about 29 days after the simulated now`);
      });

      test('replay: the same requestId returns the same authorization and the order shows exactly one', async () => {
        const orderId = await approvedOrder();
        const requestId = rid('authorize');
        const first = ok(await authorize(orderId, requestId), 'first');
        const second = ok(await authorize(orderId, requestId), 'replay');
        assert.equal(second.authorizationId, first.authorizationId);
        assert.equal(ok(await getOrder(orderId), 'getOrder').authorizations.length, 1);
      });

      test('an order the buyer has not approved is rejected', async () => {
        const orderId = await newOrder();
        const outcome = await authorize(orderId);
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
      });

      test('a second authorize under another requestId is rejected and creates nothing', async () => {
        const orderId = await approvedOrder();
        ok(await authorize(orderId), 'first');
        const outcome = await authorize(orderId);
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
        assert.equal(ok(await getOrder(orderId), 'getOrder').authorizations.length, 1);
      });

      for (const [fault, status] of [['authorize_denied', 'DENIED'], ['authorize_pending', 'PENDING']]) {
        test(`${fault} -> ok with status ${status}`, async (t) => {
          if (!need(t, fault)) return;
          const orderId = await approvedOrder();
          h.inject(fault);
          assert.equal(ok(await authorize(orderId), 'authorizeOrder').status, status);
        });
      }
    });

    // ---- getAuthorization ----------------------------------------------------------------------------------------------
    describe('getAuthorization', () => {
      test('ok: CREATED with expirationTime, CAPTURED after a capture, VOIDED after a void', async () => {
        const a = await authorized();
        const created = ok(await getAuthorization(a.authorizationId), 'getAuthorization');
        assert.equal(created.status, 'CREATED');
        assert.ok(!Number.isNaN(Date.parse(created.expirationTime)));
        ok(await capture(a), 'capture');
        assert.equal(ok(await getAuthorization(a.authorizationId), 'after capture').status, 'CAPTURED');
        const b = await authorized();
        ok(await voidAuth(b), 'void');
        assert.equal(ok(await getAuthorization(b.authorizationId), 'after void').status, 'VOIDED');
      });

      test('an unknown authorization id is rejected', async () => {
        const outcome = await getAuthorization('NO-SUCH-AUTH-0001');
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
      });

      test('auth_expire: the authorization reads EXPIRED and can no longer be captured', async (t) => {
        if (!need(t, 'auth_expire')) return;
        const orderId = await approvedOrder();
        h.inject('auth_expire');
        const a = { orderId, ...ok(await authorize(orderId), 'authorizeOrder'), amountCents: 1250 };
        assert.equal(ok(await getAuthorization(a.authorizationId), 'getAuthorization').status, 'EXPIRED');
        const outcome = await capture(a);
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
      });
    });

    // ---- captureAuthorization ------------------------------------------------------------------------------------------
    describe('captureAuthorization', () => {
      test('ok: captureId and status COMPLETED', async () => {
        const a = await authorized();
        const value = ok(await capture(a), 'captureAuthorization');
        assert.equal(typeof value.captureId, 'string');
        assert.equal(value.status, 'COMPLETED');
      });

      test('replay: the same requestId returns the same capture, not AUTHORIZATION_ALREADY_CAPTURED', async () => {
        const a = await authorized();
        const requestId = rid('capture');
        const first = ok(await capture(a, requestId), 'first');
        const second = ok(await capture(a, requestId), 'replay');
        assert.equal(second.captureId, first.captureId);
        assert.equal(ok(await getOrder(a.orderId), 'getOrder').captures.length, 1);
      });

      test('a second capture under another requestId is rejected with AUTHORIZATION_ALREADY_CAPTURED', async () => {
        const a = await authorized();
        ok(await capture(a), 'first');
        const outcome = await capture(a);
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
        assert.equal(outcome.issue, 'AUTHORIZATION_ALREADY_CAPTURED');
      });

      test('capture_declined -> ok DECLINED and the authorization stays CREATED', async (t) => {
        if (!need(t, 'capture_declined')) return;
        const a = await authorized();
        h.inject('capture_declined');
        assert.equal(ok(await capture(a), 'captureAuthorization').status, 'DECLINED');
        assert.equal(ok(await getAuthorization(a.authorizationId), 'getAuthorization').status, 'CREATED');
      });

      test('capture_pending -> ok PENDING', async (t) => {
        if (!need(t, 'capture_pending')) return;
        const a = await authorized();
        h.inject('capture_pending');
        assert.equal(ok(await capture(a), 'captureAuthorization').status, 'PENDING');
      });

      test('an unknown authorization id is rejected', async () => {
        const outcome = await capture({ authorizationId: 'NO-SUCH-AUTH-0002', amountCents: 100 });
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
      });
    });

    // ---- getCapture ----------------------------------------------------------------------------------------------------
    describe('getCapture', () => {
      test('ok: COMPLETED; REFUNDED after a full refund', async () => {
        const c = await captured();
        assert.equal(ok(await getCapture(c.captureId), 'getCapture').status, 'COMPLETED');
        ok(await refund(c), 'refund');
        assert.equal(ok(await getCapture(c.captureId), 'after refund').status, 'REFUNDED');
      });

      test('an unknown capture id is rejected', async () => {
        const outcome = await getCapture('NO-SUCH-CAP-0001');
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
      });
    });

    // ---- voidAuthorization ---------------------------------------------------------------------------------------------
    describe('voidAuthorization', () => {
      test('ok: status VOIDED', async () => {
        const a = await authorized();
        assert.equal(ok(await voidAuth(a), 'voidAuthorization').status, 'VOIDED');
      });

      test('replay: the same requestId is ok again', async () => {
        const a = await authorized();
        const requestId = rid('void');
        ok(await voidAuth(a, requestId), 'first');
        assert.equal(ok(await voidAuth(a, requestId), 'replay').status, 'VOIDED');
      });

      test('voiding twice under another requestId, or after a capture, is rejected', async () => {
        const a = await authorized();
        ok(await voidAuth(a), 'first');
        const again = await voidAuth(a);
        assertOutcome(again);
        assert.equal(again.kind, 'rejected');
        const c = await captured();
        const afterCapture = await voidAuth(c);
        assertOutcome(afterCapture);
        assert.equal(afterCapture.kind, 'rejected');
      });

      test('void_fail -> rejected, the authorization stays CREATED', async (t) => {
        if (!need(t, 'void_fail')) return;
        const a = await authorized();
        h.inject('void_fail');
        const outcome = await voidAuth(a);
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
        assert.equal(ok(await getAuthorization(a.authorizationId), 'getAuthorization').status, 'CREATED');
      });
    });

    // ---- refundCapture / getRefund -----------------------------------------------------------------------------------
    describe('refundCapture and getRefund', () => {
      test('ok: refundId and status COMPLETED; getRefund reads it back', async () => {
        const c = await captured();
        const value = ok(await refund(c), 'refundCapture');
        assert.equal(typeof value.refundId, 'string');
        assert.equal(value.status, 'COMPLETED');
        assert.equal(ok(await getRefund(value.refundId), 'getRefund').status, 'COMPLETED');
      });

      test('replay: the same requestId returns the same refund, and the order shows one', async () => {
        const c = await captured();
        const requestId = rid('refund');
        const first = ok(await refund(c, requestId), 'first');
        const second = ok(await refund(c, requestId), 'replay');
        assert.equal(second.refundId, first.refundId);
        assert.equal(ok(await getOrder(c.orderId), 'getOrder').refunds.length, 1);
      });

      test('a second full refund under another requestId is rejected with CAPTURE_FULLY_REFUNDED', async () => {
        const c = await captured();
        ok(await refund(c), 'first');
        const outcome = await refund(c);
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'rejected');
        assert.equal(outcome.issue, 'CAPTURE_FULLY_REFUNDED');
      });

      for (const [fault, status] of [['refund_pending', 'PENDING'], ['refund_failed', 'FAILED']]) {
        test(`${fault} -> ok with status ${status}`, async (t) => {
          if (!need(t, fault)) return;
          const c = await captured();
          h.inject(fault);
          const value = ok(await refund(c), 'refundCapture');
          assert.equal(value.status, status);
          assert.equal(ok(await getRefund(value.refundId), 'getRefund').status, status);
        });
      }

      test('an unknown capture id or refund id is rejected', async () => {
        const a = await refund({ captureId: 'NO-SUCH-CAP-0002', amountCents: 100 });
        assertOutcome(a);
        assert.equal(a.kind, 'rejected');
        const b = await getRefund('NO-SUCH-REFUND-0001');
        assertOutcome(b);
        assert.equal(b.kind, 'rejected');
      });
    });

    // ---- verifyWebhook -------------------------------------------------------------------------------------------------
    describe('verifyWebhook', () => {
      test('a correctly signed event verifies', async () => {
        const outcome = await verify(signedWebhook());
        assert.equal(ok(outcome, 'verifyWebhook').verified, true);
      });

      test('the event body altered after signing does not verify', async () => {
        const signed = signedWebhook();
        const outcome = await verify({ headers: signed.headers, rawBody: tamperBody(signed.rawBody) });
        assertOutcome(outcome);
        assert.ok(!(outcome.kind === 'ok' && outcome.value.verified === true), 'a tampered body must not verify');
      });

      test('a signature made with another secret does not verify', async () => {
        const forged = signedWebhook({ secret: 'another-secret-that-is-at-least-32-bytes-long-0001' });
        const outcome = await verify(forged);
        assertOutcome(outcome);
        assert.ok(!(outcome.kind === 'ok' && outcome.value.verified === true));
      });

      test('missing signature headers do not verify', async () => {
        const signed = signedWebhook();
        const { 'paypal-transmission-sig': _sig, ...without } = signed.headers;
        const outcome = await verify({ headers: without, rawBody: signed.rawBody });
        assertOutcome(outcome);
        assert.ok(!(outcome.kind === 'ok' && outcome.value.verified === true));
      });

      test('the body is verified as bytes: odd whitespace, key order, escapes and non-ASCII verify unchanged', async () => {
        const raw = '{ "id":"WH-RAW-1",\n  "event_type" : "PAYMENT.CAPTURE.COMPLETED", "resource":{"note":"caf\\u00e9 \\/ über","id":"X","amount":{"value":"1.10"}} , "links":[ ]}';
        const signed = signEvent({ rawBody: raw, secret: h.webhookSecret, transmissionTime: new Date(clock.now()).toISOString() });
        assert.equal(ok(await verify(signed), 'verifyWebhook').verified, true);
        // The same event serialised differently is a different byte string: its old signature must not verify.
        const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw)), 'utf8');
        const outcome = await verify({ headers: signed.headers, rawBody: reserialised });
        assertOutcome(outcome);
        assert.ok(!(outcome.kind === 'ok' && outcome.value.verified === true), 'a re-serialised body must not verify');
      });
    });

    // ---- Outcome classes for every method ----------------------------------------------------------------------------
    describe('Outcome classes per method', () => {
      const methods = [
        { kind: 'create_order', mutating: true, prepare: async () => ({}), call: (w, r) => createOrder(1250, r), effects: null },
        { kind: 'get_order', prepare: async () => ({ orderId: await newOrder() }), call: (w) => getOrder(w.orderId) },
        {
          kind: 'authorize', mutating: true, prepare: async () => ({ orderId: await approvedOrder() }), call: (w, r) => authorize(w.orderId, r),
          effects: async (w) => ok(await getOrder(w.orderId), 'effects').authorizations.length,
        },
        { kind: 'get_authorization', prepare: authorized, call: (w) => getAuthorization(w.authorizationId) },
        {
          kind: 'capture', mutating: true, prepare: authorized, call: (w, r) => capture(w, r),
          effects: async (w) => ok(await getOrder(w.orderId), 'effects').captures.length,
        },
        { kind: 'get_capture', prepare: captured, call: (w) => getCapture(w.captureId) },
        {
          kind: 'void', mutating: true, prepare: authorized, call: (w, r) => voidAuth(w, r),
          effects: async (w) => (ok(await getAuthorization(w.authorizationId), 'effects').status === 'VOIDED' ? 1 : 0),
        },
        {
          kind: 'refund', mutating: true, prepare: captured, call: (w, r) => refund(w, r),
          effects: async (w) => ok(await getOrder(w.orderId), 'effects').refunds.length,
        },
        { kind: 'get_refund', prepare: refunded, call: (w) => getRefund(w.refundId) },
        { kind: 'verify_webhook', prepare: async () => ({}), call: () => verify(signedWebhook()) },
      ];
      const classes = [
        { fault: (k) => `http_422:${k}`, check: (o) => { assert.equal(o.kind, 'rejected'); assert.equal(o.httpStatus, 422); } },
        { fault: (k) => `http_429:${k}`, check: (o) => { assert.equal(o.kind, 'retryable'); assert.equal(o.httpStatus, 429); } },
        { fault: (k) => `http_503:${k}`, check: (o) => { assert.equal(o.kind, 'unknown'); assert.equal(o.reason, 'http_5xx'); } },
        { fault: (k) => `timeout:${k}`, check: (o) => { assert.equal(o.kind, 'unknown'); assert.equal(o.reason, 'timeout'); } },
        { fault: (k) => `lost_response:${k}`, check: (o) => { assert.equal(o.kind, 'unknown'); assert.equal(o.reason, 'network'); } },
        { fault: (k) => `bad_body:${k}`, check: (o) => { assert.equal(o.kind, 'unknown'); assert.equal(o.reason, 'bad_body'); } },
      ];

      for (const method of methods) {
        for (const cls of classes) {
          const fault = cls.fault(method.kind);
          test(`${fault}`, { timeout: 30000 }, async (t) => {
            if (!need(t, fault)) return;
            const world = await method.prepare();
            const requestId = rid(method.kind);
            h.inject(fault);
            const outcome = seen(await method.call(world, requestId));
            assertOutcome(outcome, fault);
            cls.check(outcome);
            if (!method.mutating || !method.effects) return;
            // The call protocol retries with the SAME requestId; whatever the first attempt did, one effect must result.
            const retry = seen(await method.call(world, requestId));
            assertOutcome(retry, `retry after ${fault}`);
            assert.equal(retry.kind, 'ok', `retry after ${fault} is ok`);
            assert.equal(await method.effects(world), 1, `exactly one effect after ${fault} and a retry`);
          });
        }
      }

      test('http_401 on a call is retryable (nothing applied)', async (t) => {
        if (!need(t, 'http_401:get_order')) return;
        const orderId = await newOrder();
        h.inject('http_401:get_order');
        const outcome = seen(await getOrder(orderId));
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'retryable');
      });
    });

    // ---- OAuth (a fresh adapter has no cached token) ---------------------------------------------------------------
    describe('OAuth failures', () => {
      async function fresh() {
        const extra = await createAdapter(ctx());
        extraHarnesses.push(extra);
        return extra;
      }

      test('timeout:token -> unknown timeout (the bound covers the token fetch)', { timeout: 30000 }, async (t) => {
        const extra = await fresh();
        if (!extra.supports('timeout:token')) return t.skip(`harness "${name}" has no OAuth to time out`);
        extra.inject('timeout:token');
        const outcome = seen(await extra.provider.getOrder({ merchantKey: MERCHANT, orderId: 'ANY-ORDER-1' }));
        assertOutcome(outcome);
        assert.equal(outcome.kind, 'unknown');
        assert.equal(outcome.reason, 'timeout');
        extra.clear();
      });

      test('http_429:token -> retryable; the next call fetches a token and works', async (t) => {
        const extra = await fresh();
        if (!extra.supports('http_429:token')) return t.skip(`harness "${name}" has no OAuth to rate-limit`);
        extra.inject('http_429:token');
        const first = seen(await extra.provider.getOrder({ merchantKey: MERCHANT, orderId: 'ANY-ORDER-2' }));
        assertOutcome(first);
        assert.equal(first.kind, 'retryable');
        const second = seen(await extra.provider.getOrder({ merchantKey: MERCHANT, orderId: 'ANY-ORDER-2' }));
        assertOutcome(second);
        assert.equal(second.kind, 'rejected', 'with a token the unknown order is a definitive 404');
        extra.clear();
      });
    });

    // ---- wire mapping (adapters with a loopback double) ----------------------------------------------------------------
    describe('wire mapping', () => {
      const skipWire = (t) => {
        if (h.wire) return false;
        t.skip(`harness "${name}" has no wire (not a REST adapter)`);
        return true;
      };
      const lastOf = (kind) => {
        const list = h.wire.calls(kind);
        assert.ok(list.length > 0, `the double recorded a ${kind} call`);
        return list[list.length - 1];
      };

      test('PayPal-Request-Id equals the requestId on every mutating call, and a resend repeats it', async (t) => {
        if (skipWire(t)) return;
        h.wire.clear();
        const requestIds = {};
        const orderRid = rid('create_order');
        const orderId = ok(await createOrder(1250, orderRid), 'createOrder').orderId;
        requestIds.create_order = orderRid;
        await h.approve(orderId);
        const authRid = rid('authorize');
        const auth = ok(await authorize(orderId, authRid), 'authorize');
        requestIds.authorize = authRid;
        const w = { orderId, authorizationId: auth.authorizationId, amountCents: 1250 };
        const capRid = rid('capture');
        const cap = ok(await capture(w, capRid), 'capture');
        requestIds.capture = capRid;
        const refRid = rid('refund');
        ok(await refund({ ...w, captureId: cap.captureId }, refRid), 'refund');
        requestIds.refund = refRid;
        const v = await authorized();
        const voidRid = rid('void');
        ok(await voidAuth(v, voidRid), 'void');
        requestIds.void = voidRid;
        for (const [kind, expected] of Object.entries(requestIds)) {
          assert.ok(h.wire.calls(kind).some((c) => c.requestId === expected), `${kind} sent PayPal-Request-Id ${expected}`);
        }
        const before = h.wire.calls('capture').length;
        await capture(w, capRid); // replayed by the double
        const calls = h.wire.calls('capture');
        assert.equal(calls.length, before + 1);
        assert.equal(calls[calls.length - 1].requestId, capRid);
        assert.equal(calls[calls.length - 1].replayed, true);
      });

      test('OAuth: one token fetch with basic auth is cached across calls; API calls carry it as Bearer', async (t) => {
        if (skipWire(t)) return;
        const extra = await createAdapter(ctx());
        extraHarnesses.push(extra);
        extra.wire.clear();
        const orderId = ok(seen(await extra.provider.createOrder({
          merchantKey: MERCHANT, requestId: rid('create_order'), amountCents: 500, currency: 'USD', referenceId: 'so-1', returnUrl: RETURN_URL, cancelUrl: CANCEL_URL,
        })), 'createOrder').orderId;
        ok(seen(await extra.provider.getOrder({ merchantKey: MERCHANT, orderId })), 'getOrder');
        ok(seen(await extra.provider.getOrder({ merchantKey: MERCHANT, orderId })), 'getOrder again');
        const tokenCalls = extra.wire.calls('token');
        assert.equal(tokenCalls.length, 1, 'the token is fetched once and cached');
        assert.match(tokenCalls[0].headers.authorization, /^Basic [A-Za-z0-9+/=]+$/);
        assert.equal(tokenCalls[0].body.grant_type, 'client_credentials');
        const issued = extra.sensitive().find((s) => /^A21AA/.test(s));
        for (const kind of ['create_order', 'get_order']) {
          for (const call of extra.wire.calls(kind)) {
            assert.match(call.headers.authorization, /^Bearer \S+$/);
            if (issued) assert.equal(call.headers.authorization, `Bearer ${issued}`);
          }
        }
      });

      test('createOrder body: intent AUTHORIZE, USD amount as a string without floating point, urls, PAY_NOW', async (t) => {
        if (skipWire(t)) return;
        const expected = [[5, '0.05'], [1250, '12.50'], [100000, '1000.00'], [1999, '19.99'], [7, '0.07']];
        for (const [cents, value] of expected) {
          h.wire.clear();
          ok(await createOrder(cents), `createOrder ${cents}`);
          const call = lastOf('create_order');
          const unit = call.body.purchase_units[0];
          assert.equal(call.body.intent, 'AUTHORIZE');
          assert.deepEqual(unit.amount, { currency_code: 'USD', value });
          assert.match(unit.reference_id, /^so-\d+$/);
          const context = call.body.payment_source.paypal.experience_context;
          assert.equal(context.return_url, RETURN_URL);
          assert.equal(context.cancel_url, CANCEL_URL);
          assert.equal(context.user_action, 'PAY_NOW');
          assert.equal(context.shipping_preference, 'NO_SHIPPING');
          assert.equal(call.method, 'POST');
          assert.equal(call.path, '/v2/checkout/orders');
          assert.match(call.headers.prefer ?? '', /return=minimal/);
        }
      });

      test('authorize, capture, void, refund and the reads use the mapped method, path and body', async (t) => {
        if (skipWire(t)) return;
        h.wire.clear();
        const a = await authorized(1999);
        const authCall = lastOf('authorize');
        assert.equal(authCall.method, 'POST');
        assert.equal(authCall.path, `/v2/checkout/orders/${a.orderId}/authorize`);
        assert.deepEqual(authCall.body ?? {}, {});
        const c = ok(await capture(a, rid('capture'), 1999), 'capture');
        const capCall = lastOf('capture');
        assert.equal(capCall.path, `/v2/payments/authorizations/${a.authorizationId}/capture`);
        assert.deepEqual(capCall.body.amount, { currency_code: 'USD', value: '19.99' });
        assert.equal(capCall.body.final_capture, true);
        assert.match(capCall.body.invoice_id, /^rs-so-\d+-cap$/);
        ok(await refund({ ...a, captureId: c.captureId }, rid('refund'), 1999), 'refund');
        const refCall = lastOf('refund');
        assert.equal(refCall.path, `/v2/payments/captures/${c.captureId}/refund`);
        assert.deepEqual(refCall.body.amount, { currency_code: 'USD', value: '19.99' });
        assert.equal(typeof refCall.body.note_to_payer, 'string');
        const v = await authorized();
        ok(await voidAuth(v), 'void');
        assert.equal(lastOf('void').path, `/v2/payments/authorizations/${v.authorizationId}/void`);
        ok(await getAuthorization(v.authorizationId), 'getAuthorization');
        assert.equal(lastOf('get_authorization').method, 'GET');
        ok(await getCapture(c.captureId), 'getCapture');
        assert.equal(lastOf('get_capture').path, `/v2/payments/captures/${c.captureId}`);
        ok(await getOrder(a.orderId), 'getOrder');
        assert.equal(lastOf('get_order').path, `/v2/checkout/orders/${a.orderId}`);
      });

      test('verifyWebhook posts the header fields, the merchant webhook id and the RAW body bytes', async (t) => {
        if (skipWire(t)) return;
        const raw = '{ "id":"WH-RAW-2",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1","n":1.50},"zz":[1, 2] }';
        const signed = signEvent({ rawBody: raw, secret: h.webhookSecret, transmissionTime: new Date(clock.now()).toISOString() });
        h.wire.clear();
        assert.equal(ok(await verify(signed), 'verifyWebhook').verified, true);
        const call = lastOf('verify_webhook');
        assert.equal(call.path, '/v1/notifications/verify-webhook-signature');
        assert.equal(call.webhookEventRaw, raw, 'the body is spliced unchanged, not re-serialised');
        assert.equal(call.body.transmission_id, signed.headers['paypal-transmission-id']);
        assert.equal(call.body.transmission_time, signed.headers['paypal-transmission-time']);
        assert.equal(call.body.transmission_sig, signed.headers['paypal-transmission-sig']);
        assert.equal(call.body.cert_url, signed.headers['paypal-cert-url']);
        assert.equal(call.body.auth_algo, signed.headers['paypal-auth-algo']);
        assert.equal(typeof call.body.webhook_id, 'string');
        assert.notEqual(call.body.webhook_id, '');
      });
    });

    // ---- logging ---------------------------------------------------------------------------------------------------------
    describe('logging and Outcomes', () => {
      test('no log line, output or Outcome carries a body, a token, a credential or payer data; log lines are JSON with a requestId', { timeout: 60000 }, async (t) => {
        const capture_ = outputCapture();
        try {
          const done = await refunded();
          ok(await getOrder(done.orderId), 'getOrder');
          ok(await getRefund(done.refundId), 'getRefund');
          ok(await verify(signedWebhook()), 'verifyWebhook');
          const v = await authorized();
          ok(await voidAuth(v), 'void');
          await capture(v); // a definitive rejection with a provider body
          await getOrder('NO-SUCH-ORDER-LEAK');
          for (const fault of ['http_500:get_order', 'http_429:get_order', 'timeout:get_order', 'lost_response:get_order', 'bad_body:get_order']) {
            if (!h.supports(fault)) continue;
            h.inject(fault);
            await getOrder(done.orderId);
          }
          if (h.supports('http_401:get_order')) {
            h.inject('http_401:get_order');
            await getOrder(done.orderId);
          }
          h.clear();
        } finally {
          capture_.stop();
        }
        const markers = [...h.sensitive(), ...PAYER_MARKERS, BODY_MARKER, RETURN_URL_MARKER];
        const lines = logLines.slice();
        const texts = [...lines, ...capture_.chunks, ...outcomes.map((o) => JSON.stringify(o))];
        assert.deepEqual(findLeaks(texts, markers), [], 'a secret, a provider body or payer data reached a log, an output stream or an Outcome');
        for (const line of lines) {
          let parsed;
          assert.doesNotThrow(() => { parsed = JSON.parse(line); }, 'every log line is JSON');
          assert.equal(typeof parsed.requestId, 'string', 'every log line has a requestId');
        }
        if (h.sensitive().length === 0) t.diagnostic(`harness "${name}" reported no sensitive strings; only payer data and bodies were checked`);
      });
    });
  });
}
