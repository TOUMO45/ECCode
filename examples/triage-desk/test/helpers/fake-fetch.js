'use strict';
// fetchImpl stubs for the provider boundary (spec C6.4: the provider uses only res.status and res.text()).
// Each factory returns a function with the fetch signature (url, init) => Promise<response-like>.

/** A response-like object: status, ok, text(), json(). */
function makeResponse(status, text) {
  return {
    status,
    ok: status >= 200 && status <= 299,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function toText(jsonOrText) {
  return typeof jsonOrText === 'string' ? jsonOrText : JSON.stringify(jsonOrText);
}

/** Stub that answers `status` with a JSON-serialised object, or a string verbatim. */
function respond(status, jsonOrText = '') {
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new RangeError('respond: status must be an integer 100-599');
  const text = toText(jsonOrText);
  return async () => makeResponse(status, text);
}

const DEFAULT_USAGE = Object.freeze({ input_tokens: 120, output_tokens: 40 });

/**
 * A Messages API response body (spec C7). `obj` is JSON.stringify'd into the text block; a string is
 * used verbatim (for "text is not JSON" cases).
 * @param {object|string} obj
 * @param {{stop_reason?:string, thinkingFirst?:boolean, usage?:object|null, model?:string}} [opts]
 *   usage: omitted → {input_tokens:120, output_tokens:40}; null → no `usage` key; anything else verbatim.
 */
function messageBody(obj, { stop_reason = 'end_turn', thinkingFirst = false, usage = DEFAULT_USAGE, model = 'claude-haiku-5-5' } = {}) {
  const content = [];
  if (thinkingFirst) content.push({ type: 'thinking', thinking: 'Considering the ticket category and urgency.', signature: 'fake-signature' });
  content.push({ type: 'text', text: toText(obj) });
  const body = { id: 'msg_fake_0001', type: 'message', role: 'assistant', model, content, stop_reason, stop_sequence: null };
  if (usage !== null) body.usage = usage === DEFAULT_USAGE ? { ...DEFAULT_USAGE } : usage;
  return body;
}

/** Stub answering 200 with messageBody(obj, opts). The built body is also on the stub as `.body`. */
function messageOk(obj, opts) {
  const body = messageBody(obj, opts);
  const stub = respond(200, body);
  stub.body = body;
  return stub;
}

/** Stub whose promise never settles, not even when init.signal aborts (the provider must race the abort). */
function never() {
  return () => new Promise(() => {});
}

/** Stub that rejects, like fetch does on a network failure or (with redirect:'error') a 3xx. */
function throws(err) {
  return async () => { throw err === undefined ? new TypeError('fetch failed') : err; };
}

/**
 * Wraps `inner`, recording every call before delegating: calls[i] = {url, init, body, rawBody}, where
 * body = JSON.parse(init.body) or null when it is not JSON. `count` is the number of calls so far.
 */
function capture(inner) {
  if (typeof inner !== 'function') throw new TypeError('capture: inner must be a fetch-like function');
  const calls = [];
  const fn = (url, init) => {
    const rawBody = init && init.body !== undefined ? init.body : undefined;
    let body = null;
    if (typeof rawBody === 'string') {
      try { body = JSON.parse(rawBody); } catch { body = null; }
    }
    calls.push({ url, init, body, rawBody });
    return inner(url, init);
  };
  fn.calls = calls;
  Object.defineProperty(fn, 'count', { get: () => calls.length, enumerable: true });
  return fn;
}

module.exports = { respond, messageBody, messageOk, never, throws, capture, makeResponse };
