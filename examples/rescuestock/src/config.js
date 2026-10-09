// Configuration: every environment variable of the Deployment table, parsed and
// validated once at startup. Secrets come only from process.env and are wrapped
// in Secret. A refusal names the variable and a fixed reason, never the value.
import { inspect } from 'node:util';
import { localDateInZone } from './clock.js';

export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';
export const ANTHROPIC_API = 'https://api.anthropic.com';
export const MERCHANT_KEYS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'DEFAULT']);
export const PRICE_NOTICE = 'Test prices, not market prices';
export const MAX_REGISTER_PER_IP_PER_HOUR = 5;

const REDACTED = '[redacted]';

// Wraps a secret value. toString, toJSON and util.inspect return "[redacted]";
// reveal() is used only while building an outbound header.
export class Secret {
  #value;
  constructor(value) {
    this.#value = String(value);
    Object.freeze(this);
  }
  reveal() {
    return this.#value;
  }
  toString() {
    return REDACTED;
  }
  toJSON() {
    return REDACTED;
  }
  [inspect.custom]() {
    return REDACTED;
  }
  [Symbol.toPrimitive]() {
    return REDACTED;
  }
}

export class ConfigError extends Error {
  constructor(problems) {
    const list = problems.map((p) => `${p.variable} (${p.reason})`).join('; ');
    super(`Invalid configuration: ${list}`);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
    this.problems = Object.freeze(problems.map((p) => Object.freeze({ ...p })));
    this.variables = Object.freeze(problems.map((p) => p.variable));
  }
}

// Placeholder-shaped secret values are refused (SEC-5): <...>, changeme, password.
export function isPlaceholder(value) {
  const v = String(value).trim();
  if (/^<.*>$/s.test(v)) return true;
  const lower = v.toLowerCase();
  return lower === 'changeme' || lower === 'password';
}

const HOST_TEXT = /^[A-Za-z0-9.:\-[\]]{1,255}$/;
const LOOPBACK_BASE = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function codePoints(text) {
  return Array.from(text).length;
}

function createReader(env, problems) {
  const fail = (variable, reason) => problems.push({ variable, reason });
  const raw = (name) => {
    const v = env[name];
    return v === undefined || v === null || v === '' ? undefined : String(v);
  };

  return {
    fail,
    raw,
    int(name, def, min, max) {
      const v = raw(name);
      if (v === undefined) return def;
      if (!/^\d{1,15}$/.test(v) || Number(v) < min || Number(v) > max) {
        fail(name, `must be an integer from ${min} to ${max}`);
        return def;
      }
      return Number(v);
    },
    number(name, def, min, max) {
      const v = raw(name);
      if (v === undefined) return def;
      if (!/^\d{1,9}(\.\d{1,9})?$/.test(v) || Number(v) < min || Number(v) > max) {
        fail(name, `must be a number from ${min} to ${max}`);
        return def;
      }
      return Number(v);
    },
    flag(name, def) {
      const v = raw(name);
      if (v === undefined) return def;
      if (v !== '0' && v !== '1') {
        fail(name, 'must be 0 or 1');
        return def;
      }
      return v === '1';
    },
    choice(name, def, values) {
      const v = raw(name);
      if (v === undefined) return def;
      if (!values.includes(v)) {
        fail(name, `must be one of ${values.join(', ')}`);
        return def;
      }
      return v;
    },
    text(name, def, pattern, maxLen = 1024) {
      const v = raw(name);
      if (v === undefined) return def;
      if (v.length > maxLen || v.includes('\u0000') || (pattern && !pattern.test(v))) {
        fail(name, 'has an invalid format');
        return def;
      }
      return v;
    },
    list(name, itemPattern) {
      const v = raw(name);
      if (v === undefined) return [];
      const items = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      for (const item of items) {
        if (item.length > 1024 || item.includes('\u0000') || (itemPattern && !itemPattern.test(item))) {
          fail(name, 'has an invalid entry');
          return [];
        }
      }
      return items;
    },
    secret(name, { minChars = 0, minBytes = 0 } = {}) {
      const v = raw(name);
      if (v === undefined) return null;
      if (isPlaceholder(v)) {
        fail(name, 'is a placeholder value');
        return null;
      }
      if (minChars && codePoints(v) < minChars) {
        fail(name, `must be at least ${minChars} characters`);
        return null;
      }
      if (minBytes && Buffer.byteLength(v, 'utf8') < minBytes) {
        fail(name, `must be at least ${minBytes} bytes`);
        return null;
      }
      return new Secret(v);
    },
  };
}

function parseBaseUrl(r, name, liveUrl, testOffline) {
  const v = r.raw(name);
  if (v === undefined) return liveUrl;
  const value = v.endsWith('/') ? v.slice(0, -1) : v;
  if (value === liveUrl) return liveUrl;
  const loop = LOOPBACK_BASE.exec(value);
  if (loop && Number(loop[2]) >= 1 && Number(loop[2]) <= 65535) {
    if (testOffline) return value;
    r.fail(name, `a loopback value needs RS_TEST_OFFLINE=1; otherwise only ${liveUrl} is accepted`);
    return liveUrl;
  }
  r.fail(name, `only ${liveUrl} is accepted`);
  return liveUrl;
}

function parsePublicUrl(r) {
  const v = r.raw('RS_PUBLIC_URL');
  if (v === undefined) return null;
  let url;
  try {
    url = new URL(v);
  } catch {
    r.fail('RS_PUBLIC_URL', 'must be an http or https origin');
    return null;
  }
  const originOnly =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  if (!originOnly) {
    r.fail('RS_PUBLIC_URL', 'must be an http or https origin without path, query or credentials');
    return null;
  }
  return url.origin;
}

function parseDemoDate(r, now) {
  const v = r.raw('RS_DEMO_DATE');
  if (v === undefined) return localDateInZone(now());
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])) {
      return v;
    }
  }
  r.fail('RS_DEMO_DATE', 'must be a calendar date as YYYY-MM-DD');
  return localDateInZone(now());
}

function parseMerchants(r) {
  const merchants = {};
  for (const key of MERCHANT_KEYS) {
    const clientId = r.secret(`RS_PAYPAL_${key}_CLIENT_ID`);
    const clientSecret = r.secret(`RS_PAYPAL_${key}_CLIENT_SECRET`);
    const webhookId = r.secret(`RS_PAYPAL_${key}_WEBHOOK_ID`);
    if (!clientId && !clientSecret && !webhookId) continue;
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      r.fail(
        clientId ? `RS_PAYPAL_${key}_CLIENT_SECRET` : `RS_PAYPAL_${key}_CLIENT_ID`,
        'client id and client secret must be set together',
      );
      continue;
    }
    merchants[key] = Object.freeze({ clientId, clientSecret, webhookId });
  }
  return Object.freeze(merchants);
}

export function loadConfig(env = process.env, { now = () => Date.now() } = {}) {
  const problems = [];
  const r = createReader(env, problems);

  const testOffline = r.flag('RS_TEST_OFFLINE', false);
  const port = r.int('PORT', 3000, 0, 65535);
  const host = r.text('HOST', '127.0.0.1', HOST_TEXT, 255);
  const publicUrl = parsePublicUrl(r);

  const paypalTimeoutMs = r.int('RS_PAYPAL_TIMEOUT_MS', 20000, 1, 300000);
  const sagaLeaseMs = r.int('RS_SAGA_LEASE_MS', 60000, 1, 86400000);
  if (sagaLeaseMs < 3 * paypalTimeoutMs) {
    r.fail('RS_SAGA_LEASE_MS', 'must be at least 3 times RS_PAYPAL_TIMEOUT_MS');
  }

  const registerPerIpPerHour = r.int('RS_REGISTER_PER_IP_PER_HOUR', MAX_REGISTER_PER_IP_PER_HOUR, 1, 100000);
  if (registerPerIpPerHour > MAX_REGISTER_PER_IP_PER_HOUR && !testOffline) {
    r.fail('RS_REGISTER_PER_IP_PER_HOUR', `must be at most ${MAX_REGISTER_PER_IP_PER_HOUR} unless RS_TEST_OFFLINE=1`);
  }

  const paymentProvider = r.choice('RS_PAYMENT_PROVIDER', 'fake', ['fake', 'paypal-sandbox']);
  const paypalBaseUrl = parseBaseUrl(r, 'RS_PAYPAL_BASE_URL', PAYPAL_SANDBOX_API, testOffline);
  const merchants = parseMerchants(r);
  const completeKeys = Object.keys(merchants);
  const perSupplier = ['A', 'B', 'C', 'D', 'E'].every((k) => completeKeys.includes(k));
  const merchantMode = paymentProvider === 'fake' || perSupplier ? 'per-supplier' : 'single-credential';
  if (paymentProvider === 'paypal-sandbox' && !perSupplier && !completeKeys.includes('DEFAULT')) {
    r.fail('RS_PAYPAL_DEFAULT_CLIENT_ID', 'a PayPal credential set is required (DEFAULT, or all of A to E)');
  }

  const testHooks = r.flag('RS_TEST_HOOKS', false);
  if (testHooks && paymentProvider === 'paypal-sandbox') {
    r.fail('RS_TEST_HOOKS', 'is refused when RS_PAYMENT_PROVIDER=paypal-sandbox');
  }

  let fakeApprovalHost = r.text('RS_FAKE_APPROVAL_HOST', '127.0.0.1', HOST_TEXT, 255);
  const approvalHostAllowed = testOffline ? ['127.0.0.1', 'localhost', '::1'] : ['127.0.0.1'];
  if (!approvalHostAllowed.includes(fakeApprovalHost)) {
    r.fail('RS_FAKE_APPROVAL_HOST', testOffline ? 'must be a loopback host' : 'must be 127.0.0.1 outside test mode');
    fakeApprovalHost = '127.0.0.1';
  }

  const anthropicApiKey = r.secret('ANTHROPIC_API_KEY');
  const requestedProvider = r.choice('RS_MODEL_PROVIDER', null, ['cli', 'fake', 'anthropic']);
  const modelProvider = requestedProvider || (anthropicApiKey ? 'anthropic' : 'cli');
  if (modelProvider === 'anthropic' && !anthropicApiKey) {
    r.fail('ANTHROPIC_API_KEY', 'is required when the model provider is anthropic');
  }
  const extractionProvider = testOffline ? 'fake' : modelProvider;

  const config = {
    port,
    host,
    publicUrl,
    publicUrlExplicit: publicUrl !== null,
    secureCookies: publicUrl !== null && publicUrl.startsWith('https://'),
    dbPath: r.text('RS_DB_PATH', 'data/app.db'),
    uploadDir: r.text('RS_UPLOAD_DIR', 'data/uploads'),
    dbBusyTimeoutMs: r.int('RS_DB_BUSY_TIMEOUT_MS', 5000, 0, 5000),
    demoDate: parseDemoDate(r, now),
    taxBp: r.int('RS_TAX_BP', 0, 0, 10000),
    reservationTtlMin: r.int('RS_RESERVATION_TTL_MIN', 30, 1, 1440),
    authExpiryMarginMin: r.int('RS_AUTH_EXPIRY_MARGIN_MIN', 10, 0, 1440),
    sagaLeaseMs,
    paypalTimeoutMs,
    reconcileIntervalMs: r.int('RS_RECONCILE_INTERVAL_MS', 15000, 10, 86400000),
    retentionIntervalMs: r.int('RS_RETENTION_INTERVAL_MS', 3600000, 10, 604800000),
    imageRetentionDays: r.int('RS_IMAGE_RETENTION_DAYS', 7, 1, 365),
    unknownEscalateMin: r.int('RS_UNKNOWN_ESCALATE_MIN', 15, 1, 100000),
    pendingEscalateMin: r.int('RS_PENDING_ESCALATE_MIN', 1440, 1, 100000),
    paymentProvider,
    paypalBaseUrl,
    paypal: Object.freeze({ merchants }),
    merchantMode,
    fakeApprovalHost,
    fakeApprovalPort: r.int('RS_FAKE_APPROVAL_PORT', 0, 0, 65535),
    // null means "generate once and keep in the meta table" (SEC-5); main.js does that.
    fakeWebhookSecret: r.secret('RS_FAKE_WEBHOOK_SECRET', { minBytes: 32 }),
    modelProvider,
    extractionProvider,
    model: r.text('RS_MODEL', 'haiku', MODEL_NAME, 80),
    modelTimeoutMs: r.int('RS_MODEL_TIMEOUT_MS', 30000, 1, 600000),
    modelCallCapUsd: r.number('RS_MODEL_CALL_CAP_USD', 0.05, 0.000001, 1000),
    modelDailyBudgetUsd: r.number('RS_MODEL_DAILY_BUDGET_USD', 1.0, 0, 100000),
    fakeModelCostUsd: r.number('RS_FAKE_MODEL_COST_USD', 0, 0, 1000),
    anthropicApiKey,
    anthropicModel: r.text('RS_ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001', MODEL_NAME, 80),
    anthropicBaseUrl: parseBaseUrl(r, 'RS_ANTHROPIC_BASE_URL', ANTHROPIC_API, testOffline),
    anthropicUsdPerMtokIn: r.number('RS_ANTHROPIC_USD_PER_MTOK_IN', 1.0, 0, 100000),
    anthropicUsdPerMtokOut: r.number('RS_ANTHROPIC_USD_PER_MTOK_OUT', 5.0, 0, 100000),
    explainRephrase: r.flag('RS_EXPLAIN_REPHRASE', false),
    adminPassword: r.secret('RS_ADMIN_PASSWORD', { minChars: 16 }),
    demoPassword: r.secret('RS_DEMO_PASSWORD', { minChars: 12 }),
    allowSignup: r.flag('RS_ALLOW_SIGNUP', true),
    maxLiveReservationsPerCustomer: r.int('RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER', 1, 1, 1000),
    maxRequestsPerCustomerPerDay: r.int('RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY', 10, 1, 100000),
    modelCustomerDailyShare: r.number('RS_MODEL_CUSTOMER_DAILY_SHARE', 0.2, 0, 1),
    registerPerIpPerHour,
    allowedHosts: Object.freeze(r.list('RS_ALLOWED_HOSTS', HOST_TEXT).map((h) => h.toLowerCase())),
    oldNodeBins: Object.freeze(r.list('RS_OLD_NODE_BINS')),
    trustProxy: r.flag('RS_TRUST_PROXY', false),
    testHooks,
    testOffline,
    testMode: testOffline,
    liveModel: r.flag('RS_LIVE_MODEL', false),
    livePaypal: r.flag('RS_LIVE_PAYPAL', false),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(config);
}

// Labels object of the API conventions (RS-34). Contains no secret.
export function buildLabels(config) {
  return {
    simulatedPayments: config.paymentProvider === 'fake',
    simulatedExtraction: config.extractionProvider === 'fake',
    sandbox: config.paymentProvider === 'paypal-sandbox',
    demoData: true,
    priceNotice: PRICE_NOTICE,
    merchantMode: config.merchantMode,
    singleCredentialNotice:
      config.merchantMode === 'single-credential' && config.paymentProvider === 'paypal-sandbox'
        ? 'All suppliers are paid through one Sandbox merchant account (single-credential mode).'
        : null,
    testMode: config.testMode,
  };
}
