'use strict';
// Configuration from environment variables (spec C6.1, DES-1, DES-6; Security T11/T12).
// loadConfig reads ONLY the variables in VARS. ConfigError messages name the variable, never its value.

/** @typedef {{host:string, port:number, allowRemote:boolean, apiKey:string|null, model:string,
 *             baseUrl:string, baseUrlCustom:boolean, timeoutMs:number, maxTokens:number,
 *             warnings:Array<'non_loopback_host'|'custom_base_url'>}} Config */

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
// DES-6: reference isLoopbackHost in design-vectors.js (bind address form, no brackets).
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
// DES-1: reference checkBaseUrl in design-vectors.js (URL hostname form, IPv6 in brackets).
const LOOPBACK_URL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHost(host) {
  return LOOPBACK_BIND_HOSTS.has(String(host).trim().toLowerCase());
}

/** @returns {{ok:true, baseUrl:string} | {ok:false}} canonical origin + pathname without trailing '/'. */
function checkBaseUrl(raw) {
  if (typeof raw !== 'string') return { ok: false };
  const v = raw.trim();
  if (v === '' || /[?#]/.test(v)) return { ok: false }; // no query/fragment, even empty ones
  let u;
  try { u = new URL(v); } catch { return { ok: false }; }
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return { ok: false };
  if (u.protocol === 'https:') { /* any host */ }
  else if (u.protocol === 'http:') { if (!LOOPBACK_URL_HOSTS.has(u.hostname)) return { ok: false }; }
  else return { ok: false };
  return { ok: true, baseUrl: u.origin + u.pathname.replace(/\/+$/, '') };
}

/** Integer in [min, max] written as plain decimal digits (surrounding whitespace allowed). */
function parseIntInRange(raw, name, min, max) {
  const v = String(raw).trim();
  if (!/^\d{1,9}$/.test(v)) throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  const n = Number(v);
  if (n < min || n > max) throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

/**
 * @param {Record<string,string|undefined>} env
 * @returns {Config}
 * @throws {ConfigError}
 */
function loadConfig(env) {
  if (env === null || typeof env !== 'object') throw new TypeError('loadConfig: env must be an object');
  // Each variable is read exactly once, by name. Nothing else in env is touched.
  const rawHost = env.HOST;
  const rawAllowRemote = env.TRIAGE_ALLOW_REMOTE;
  const rawPort = env.PORT;
  const rawKey = env.ANTHROPIC_API_KEY;
  const rawModel = env.ANTHROPIC_MODEL;
  const rawBaseUrl = env.TRIAGE_ANTHROPIC_BASE_URL;
  const rawTimeout = env.TRIAGE_TIMEOUT_MS;
  const rawMaxTokens = env.TRIAGE_MAX_TOKENS;

  const warnings = [];

  // TRIAGE_ALLOW_REMOTE: unset, '' or '0' → false; '1' → true; anything else is an error.
  let allowRemote;
  if (rawAllowRemote === undefined || rawAllowRemote === '' || rawAllowRemote === '0') allowRemote = false;
  else if (rawAllowRemote === '1') allowRemote = true;
  else throw new ConfigError('TRIAGE_ALLOW_REMOTE must be unset, empty, 0 or 1');

  // HOST: non-empty after trim; loopback unless TRIAGE_ALLOW_REMOTE=1 (DES-6).
  let host = '127.0.0.1';
  if (rawHost !== undefined) {
    host = String(rawHost).trim();
    if (host === '') throw new ConfigError('HOST must not be empty');
  }
  if (!isLoopbackHost(host)) {
    if (!allowRemote) {
      throw new ConfigError('HOST is not a loopback address; set TRIAGE_ALLOW_REMOTE=1 to expose the server to the network');
    }
    warnings.push('non_loopback_host');
  }

  const port = rawPort === undefined ? 3000 : parseIntInRange(rawPort, 'PORT', 0, 65535);

  let apiKey = null;
  if (rawKey !== undefined) {
    const k = String(rawKey).trim();
    apiKey = k === '' ? null : k;
  }

  let model = 'claude-haiku-5-5';
  if (rawModel !== undefined) {
    if (typeof rawModel !== 'string' || !MODEL_PATTERN.test(rawModel)) {
      throw new ConfigError('ANTHROPIC_MODEL must match ^[A-Za-z0-9._:-]{1,100}$');
    }
    model = rawModel;
  }

  // TRIAGE_ANTHROPIC_BASE_URL (DES-1). ANTHROPIC_BASE_URL is never read.
  let baseUrl = DEFAULT_BASE_URL;
  let baseUrlCustom = false;
  if (rawBaseUrl !== undefined && String(rawBaseUrl).trim() !== '') {
    const r = checkBaseUrl(String(rawBaseUrl));
    if (!r.ok) throw new ConfigError('TRIAGE_ANTHROPIC_BASE_URL is invalid');
    baseUrl = r.baseUrl;
    baseUrlCustom = true;
    warnings.push('custom_base_url');
  }

  const timeoutMs = rawTimeout === undefined ? 20000 : parseIntInRange(rawTimeout, 'TRIAGE_TIMEOUT_MS', 100, 120000);
  const maxTokens = rawMaxTokens === undefined ? 2048 : parseIntInRange(rawMaxTokens, 'TRIAGE_MAX_TOKENS', 256, 16000);

  return Object.freeze({
    host, port, allowRemote, apiKey, model, baseUrl, baseUrlCustom, timeoutMs, maxTokens,
    warnings: Object.freeze(warnings),
  });
}

module.exports = { loadConfig, ConfigError };
