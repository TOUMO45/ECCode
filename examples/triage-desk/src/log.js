'use strict';
// Metadata-only JSON-line logger (spec C6.2, D1.6; Security T6).
// Every record is built from an allowlist of keys. Values are type-checked and anything that could carry
// content (ticket text, headers, URLs, error messages, stacks, the API key) is dropped: unknown keys are
// never copied, and an allowlisted key with an unexpected value becomes null (or OTHER/other).

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']);
const ROUTES = new Set(['/', '/index.html', '/app.js', '/styles.css', '/api/health', '/api/triage']);
const ERROR_CODES = new Set(['invalid_json', 'invalid_request', 'ticket_empty', 'ticket_too_long', 'forbidden_host',
  'forbidden_origin', 'not_found', 'method_not_allowed', 'payload_too_large', 'unsupported_media_type', 'internal_error']);
const SOURCES = new Set(['model', 'fallback']);
const FALLBACK_REASONS = new Set(['no_api_key', 'model_error', 'timeout', 'refusal', 'truncated', 'invalid_output']);
const WARNING_CODES = new Set(['non_loopback_host', 'custom_base_url']);
const MODES = new Set(['live', 'fallback']);
const RID = /^[0-9a-f]{8}$/;
// Fixed detail codes (C6.4): fetch_threw, http_429, invalid:summary_v1,reply_v2, provider_threw, ...
const DETAIL = /^[A-Za-z0-9_]{1,64}(?::[A-Za-z0-9_]{1,64}(?:,[A-Za-z0-9_]{1,64}){0,31})?$/;
const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const MODEL = /^[A-Za-z0-9._:-]{1,100}$/;

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k) => (own(o, k) ? o[k] : undefined);

const isCount = (v) => Number.isInteger(v) && v >= 0;
const intOrNull = (v) => (isCount(v) ? v : null);
const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);
const inSet = (set, v) => (typeof v === 'string' && set.has(v) ? v : null);
const matchOrNull = (re, v) => (typeof v === 'string' && re.test(v) ? v : null);
const status = (v) => (Number.isInteger(v) && v >= 100 && v <= 599 ? v : null);

function redactions(v) {
  if (v === null || typeof v !== 'object') return null;
  const email = get(v, 'email'); const card = get(v, 'card'); const phone = get(v, 'phone');
  return isCount(email) && isCount(card) && isCount(phone) ? { email, card, phone } : null;
}

function usage(v) {
  if (v === null || typeof v !== 'object') return null;
  const inputTokens = get(v, 'inputTokens'); const outputTokens = get(v, 'outputTokens');
  return isCount(inputTokens) && isCount(outputTokens) ? { inputTokens, outputTokens } : null;
}

function method(v) {
  return typeof v === 'string' && METHODS.has(v) ? v : 'OTHER';
}

function route(v) {
  return typeof v === 'string' && ROUTES.has(v) ? v : 'other';
}

function errorName(f) {
  if (!own(f, 'errorName')) return null;
  const v = f.errorName;
  return typeof v === 'string' && ERROR_NAME.test(v) ? v : 'Error';
}

/**
 * @param {(line:string)=>void} [write] receives one JSON string per record, without a trailing newline
 * @returns {{request:(fields?:object)=>void, event:(name:'listening'|'warning', fields?:object)=>void, error:(fields?:object)=>void}}
 */
function createLogger(write = (l) => process.stdout.write(l + '\n')) {
  if (typeof write !== 'function') throw new TypeError('createLogger: write must be a function');
  const emit = (record) => write(JSON.stringify(record));
  const now = () => new Date().toISOString();

  return {
    request(fields) {
      const f = fields;
      emit({
        t: now(),
        event: 'request',
        rid: matchOrNull(RID, get(f, 'rid')),
        method: method(get(f, 'method')),
        route: route(get(f, 'route')),
        status: status(get(f, 'status')),
        ms: intOrNull(get(f, 'ms')),
        errorCode: inSet(ERROR_CODES, get(f, 'errorCode')),
        ticketLength: intOrNull(get(f, 'ticketLength')),
        source: inSet(SOURCES, get(f, 'source')),
        fallbackReason: inSet(FALLBACK_REASONS, get(f, 'fallbackReason')),
        injectionSuspected: boolOrNull(get(f, 'injectionSuspected')),
        redactions: redactions(get(f, 'redactions')),
        upstreamStatus: status(get(f, 'upstreamStatus')),
        detail: matchOrNull(DETAIL, get(f, 'detail')),
        usage: usage(get(f, 'usage')),
      });
    },

    event(name, fields) {
      const f = fields;
      if (name === 'listening') {
        const port = get(f, 'port');
        emit({
          t: now(),
          event: 'listening',
          host: typeof get(f, 'host') === 'string' ? get(f, 'host') : null,
          port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null,
          mode: inSet(MODES, get(f, 'mode')),
          model: matchOrNull(MODEL, get(f, 'model')),
          timeoutMs: intOrNull(get(f, 'timeoutMs')),
          maxTokens: intOrNull(get(f, 'maxTokens')),
          baseUrlCustom: boolOrNull(get(f, 'baseUrlCustom')),
        });
        return;
      }
      if (name === 'warning') {
        emit({ t: now(), event: 'warning', code: inSet(WARNING_CODES, get(f, 'code')) });
        return;
      }
      throw new TypeError('log.event: unknown event name');
    },

    error(fields) {
      const f = fields;
      emit({
        t: now(),
        event: 'error',
        rid: matchOrNull(RID, get(f, 'rid')),
        errorCode: inSet(ERROR_CODES, get(f, 'errorCode')),
        errorName: errorName(f),
      });
    },
  };
}

module.exports = { createLogger };
