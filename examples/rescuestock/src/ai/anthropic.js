// Anthropic Messages API adapter (AI / LLM Design "Anthropic API adapter").
//
//   POST {baseUrl}/v1/messages with x-api-key, anthropic-version 2023-06-01, content-type application/json.
//   Body: { model, max_tokens: 1024, temperature: 0, system, messages: [{ role: 'user', content: [image?, text] }],
//           output_config: { format: { type: 'json_schema', schema } } } (structured outputs, no beta header; source:
//   https://platform.claude.com/docs/en/build-with-claude/structured-outputs, fetched 2026-10-09).
//   The first `text` block is parsed; stop_reason refusal and max_tokens are refused.
//   Timeout 30 s, redirect: 'error', ONE retry on 5xx / 529 and only when the deadline allows; none on timeout.
//   Cost = tokens x USD-per-million-token price, computed in integer micro-dollars with BigInt (F-TR-12).
//
// The base URL is allow-listed here as well as in config: exactly https://api.anthropic.com, or an http loopback
// URL when `allowLoopback` is true (RS_TEST_OFFLINE=1). The API key is never logged, never put in an error and never
// returned. Tested against a loopback stub only; the live behaviour is checked by the opt-in live suite.
import { toMicroUsd } from './gate.js';
import { buildExtractionPrompt } from './prompt.js';
import { ProviderError } from './provider.js';
import { REPHRASE_WIRE_SCHEMA } from './cli.js';
import { EXTRACTION_WIRE_SCHEMA, parseAndValidate } from './schema.js';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const ANTHROPIC_TIMEOUT_MS = 30000;
export const ANTHROPIC_MAX_TOKENS = 1024;
export const ANTHROPIC_MAX_RESPONSE_BYTES = 1024 * 1024;

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

/** Throws unless the URL is the official API or (allowLoopback) an http loopback origin. Returns it without a trailing slash. */
export function checkBaseUrl(url, { allowLoopback = false } = {}) {
  const value = typeof url === 'string' && url.endsWith('/') ? url.slice(0, -1) : url;
  if (value === ANTHROPIC_API_URL) return value;
  if (allowLoopback && typeof value === 'string' && LOOPBACK.test(value)) return value;
  throw new RangeError(`the Anthropic base URL must be ${ANTHROPIC_API_URL}${allowLoopback ? ' or a loopback origin' : ''}`);
}

/** tokens x (USD per million tokens) in integer micro-dollars, rounded up. Price is a decimal string or number. */
export function costMicroUsd({ inputTokens, outputTokens, usdPerMtokIn, usdPerMtokOut }) {
  const microPerMtok = (price) => BigInt(toMicroUsd(price)); // USD/Mtok x 1e6 = micro-dollars per million tokens
  const total = BigInt(inputTokens) * microPerMtok(usdPerMtokIn) + BigInt(outputTokens) * microPerMtok(usdPerMtokOut);
  return Number((total + 999_999n) / 1_000_000n);
}

const count = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

function combineSignals(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function isAbort(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * createAnthropicProvider({ apiKey, baseUrl, model, timeoutMs, usdPerMtokIn, usdPerMtokOut, allowLoopback, fetch, clock })
 *   apiKey  string or a config Secret (reveal())
 * extract() resolves { output, usage, meta: { schemaAccepted: true } } (an HTTP 200 means the schema was accepted).
 * A 400 rejects PROVIDER_UNAVAILABLE with err.schemaAccepted = false (F-TR-13); 429/529 are PROVIDER_BUSY.
 */
export function createAnthropicProvider({
  apiKey,
  baseUrl = ANTHROPIC_API_URL,
  model = ANTHROPIC_DEFAULT_MODEL,
  timeoutMs = ANTHROPIC_TIMEOUT_MS,
  usdPerMtokIn = 1.0,
  usdPerMtokOut = 5.0,
  allowLoopback = false,
  fetch: fetchImpl = globalThis.fetch,
  clock = { now: () => Date.now() },
} = {}) {
  const base = checkBaseUrl(baseUrl, { allowLoopback });
  const key = apiKey && typeof apiKey.reveal === 'function' ? apiKey.reveal() : apiKey;
  if (typeof key !== 'string' || key === '') throw new TypeError('an Anthropic API key is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');
  const modelName = model || ANTHROPIC_DEFAULT_MODEL;

  async function post(body, signal) {
    let response;
    try {
      response = await fetchImpl(`${base}/v1/messages`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new ProviderError(isAbort(err) ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE');
    }
    let text;
    try {
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > ANTHROPIC_MAX_RESPONSE_BYTES) throw new ProviderError('PROVIDER_BAD_OUTPUT');
      text = await response.text();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(isAbort(err) ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE');
    }
    if (Buffer.byteLength(text, 'utf8') > ANTHROPIC_MAX_RESPONSE_BYTES) throw new ProviderError('PROVIDER_BAD_OUTPUT');
    return { status: response.status, text };
  }

  async function call({ system, content, schema, interpret, signal }) {
    const started = clock.now();
    const deadline = started + timeoutMs;
    const body = {
      model: modelName,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      temperature: 0,
      system,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema } },
    };

    let reply = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - clock.now();
      if (remaining <= 0) throw new ProviderError('PROVIDER_TIMEOUT');
      reply = await post(body, combineSignals(remaining, signal));
      const retryable = reply.status >= 500 && reply.status <= 599;
      if (!retryable || attempt === 1) break;
    }

    const { status, text } = reply;
    if (status === 429 || status === 529) throw new ProviderError('PROVIDER_BUSY');
    if (status >= 500) throw new ProviderError('PROVIDER_UNAVAILABLE');
    if (status !== 200) {
      const err = new ProviderError('PROVIDER_UNAVAILABLE');
      if (status === 400) err.schemaAccepted = false; // the request, including the schema, was refused
      throw err;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      throw new ProviderError('PROVIDER_BAD_OUTPUT');
    }
    const inputTokens = count(message?.usage?.input_tokens);
    const outputTokens = count(message?.usage?.output_tokens);
    const micro = costMicroUsd({ inputTokens, outputTokens, usdPerMtokIn, usdPerMtokOut });
    const usage = {
      model: typeof message?.model === 'string' ? message.model : modelName,
      costUsd: micro / 1_000_000,
      costMicroUsd: micro,
      inputTokens,
      outputTokens,
      latencyMs: Math.max(0, clock.now() - started),
    };
    if (message?.stop_reason === 'refusal' || message?.stop_reason === 'max_tokens') throw new ProviderError('PROVIDER_BAD_OUTPUT', { usage });
    const block = Array.isArray(message?.content) ? message.content.find((b) => b && b.type === 'text') : null;
    if (!block || typeof block.text !== 'string') throw new ProviderError('PROVIDER_BAD_OUTPUT', { usage });
    const interpreted = interpret(block.text);
    if (!interpreted.ok) throw new ProviderError('PROVIDER_BAD_OUTPUT', { usage });
    return { output: interpreted.value, usage, meta: { schemaAccepted: true } };
  }

  async function extract({ text, image = null, signal } = {}) {
    const prompt = buildExtractionPrompt({ text, image });
    // the API takes the image block first, then the text block
    const content = [...prompt.content].sort((a, b) => (a.type === 'image' ? -1 : 0) - (b.type === 'image' ? -1 : 0));
    return call({
      system: prompt.system,
      content,
      schema: EXTRACTION_WIRE_SCHEMA,
      signal,
      interpret(raw) {
        const checked = parseAndValidate(raw);
        return checked.ok ? { ok: true, value: checked.value } : { ok: false };
      },
    });
  }

  async function rephrase({ system, content, signal } = {}) {
    if (!Array.isArray(content)) throw new TypeError('rephrase needs the prompt content');
    return call({
      system,
      content,
      schema: REPHRASE_WIRE_SCHEMA,
      signal,
      interpret(raw) {
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          return { ok: false };
        }
        const good = value !== null && typeof value === 'object' && !Array.isArray(value) &&
          Object.keys(value).length === 1 && typeof value.text === 'string';
        return good ? { ok: true, value: { text: value.text } } : { ok: false };
      },
    });
  }

  return Object.freeze({ id: 'anthropic', simulated: false, model: modelName, extract, rephrase });
}
