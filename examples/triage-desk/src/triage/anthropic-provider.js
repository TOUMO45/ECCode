'use strict';
// Live provider: one Anthropic Messages API call over raw fetch (spec C6.4 10-step algorithm, C7 outbound contract,
// §AI/LLM Design "Timeouts, retries, fallback, cost"). Zero dependencies (NFR1). analyse() never rejects: every
// failure becomes a LiveResult with a fixed reason and a fixed detail code, never content.
// API shape (POST /v1/messages; headers x-api-key, anthropic-version: 2023-06-01, content-type; response fields
// stop_reason, content[] with {type:'text', text}, usage.input_tokens/output_tokens) checked 2026-10-07 against the
// claude-api skill reference. No live call was made (no key).
const { buildRequestBody } = require('./prompt.js');
const { validateTriage } = require('./schema.js');

const ANTHROPIC_VERSION = '2023-06-01';
// Security review rev-muypiolk-0132e9b0 SEC-CM-1 / RISK-10: containsLinkOrEmail (V2) is quadratic in text length
// and validateTriage applies it whatever the length. Output longer than the V1/V4 limits fails validation anyway,
// so it is rejected here, with the code validateTriage would report, before V2 can see it.
const MAX_SUMMARY = 200; // V1 (spec D4, brief V1)
const MAX_REPLY = 1200; // V4 (spec D4, brief V4)

const ABORTED = Symbol('aborted');

/** Settles like `promise`, or rejects with ABORTED as soon as `signal` aborts (a never-settling stub still times out). */
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(ABORTED); return; }
    const onAbort = () => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

function fail(reason, detail, upstreamStatus = null, usage = null) {
  return { ok: false, reason, upstreamStatus, usage, detail };
}

function mapUsage(body) {
  const u = body.usage;
  if (u !== null && typeof u === 'object' && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
    return { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
  }
  return null;
}

/** RISK-10 gate: error codes for over-long text fields, in validateTriage order, or [] when V2 is safe to run. */
function overLengthErrors(obj) {
  if (obj === null || typeof obj !== 'object') return [];
  const errors = [];
  if (typeof obj.summary === 'string' && obj.summary.length > MAX_SUMMARY) errors.push('summary_v1');
  if (typeof obj.suggestedReply === 'string' && obj.suggestedReply.length > MAX_REPLY) errors.push('reply_length');
  return errors;
}

/** Steps 5-10 on the raw 2xx body text. Synchronous and pure. */
function interpret(text, status) {
  let body;
  try { body = JSON.parse(text); } catch { return fail('model_error', 'body_not_json', status); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('model_error', 'body_not_json', status);
  const usage = mapUsage(body);

  if (body.stop_reason === 'refusal') return fail('refusal', 'refusal', status, usage);
  if (body.stop_reason === 'max_tokens') return fail('truncated', 'max_tokens', status, usage);

  const content = Array.isArray(body.content) ? body.content : [];
  const block = content.find((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string');
  if (block === undefined) return fail('invalid_output', 'no_text_block', status, usage);

  let parsed;
  try { parsed = JSON.parse(block.text); } catch { return fail('invalid_output', 'text_not_json', status, usage); }

  const tooLong = overLengthErrors(parsed);
  if (tooLong.length > 0) return fail('invalid_output', `invalid:${tooLong.join(',')}`, status, usage);

  const v = validateTriage(parsed);
  if (!v.ok) return fail('invalid_output', `invalid:${v.errors.join(',')}`, status, usage);
  return { ok: true, triage: v.triage, upstreamStatus: status, usage };
}

/**
 * @param {{apiKey:string, model:string, baseUrl:string, timeoutMs:number, maxTokens:number,
 *          fetchImpl:(url:string, init:object)=>Promise<{status:number, text:()=>Promise<string>}>}} opts
 * @returns {{model:string, analyse:(redactedTicket:string)=>Promise<object>}}
 */
function createAnthropicProvider({ apiKey, model, baseUrl, timeoutMs, maxTokens, fetchImpl }) {
  async function analyse(redactedTicket) {
    let status = null;
    let controller = null;
    let timer = null;
    try {
      // Step 1. buildRequestBody throws TypeError on invalid arguments (t04 note); the catch below keeps
      // analyse non-rejecting and no request is sent.
      const body = buildRequestBody({ model, maxTokens, ticketText: redactedTicket });
      // Step 2.
      controller = new AbortController();
      const { signal } = controller;
      timer = setTimeout(() => controller.abort(), timeoutMs);
      // Step 3. One fetch, never retried. redirect:'error' is mandatory (DES-1): a 3xx is never followed, so the
      // key and the ticket go only to the configured origin.
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      };
      const res = await raceAbort(new Promise((resolve) => resolve(fetchImpl(`${baseUrl}/v1/messages`, init))), signal);
      if (res === null || typeof res !== 'object' || !Number.isInteger(res.status)) return fail('model_error', 'fetch_threw');
      status = res.status;
      // Step 4. 3xx: refused and the body is not read.
      if (status >= 300 && status <= 399) return fail('model_error', 'redirect_refused', status);
      const text = await raceAbort(res.text(), signal);
      if (status < 200 || status > 299) return fail('model_error', `http_${status}`, status);
      if (typeof text !== 'string') return fail('model_error', 'body_not_json', status);
      // Steps 5-10.
      return interpret(text, status);
    } catch (err) {
      if (err === ABORTED || (controller !== null && controller.signal.aborted)) return fail('timeout', 'timeout', status);
      return fail('model_error', 'fetch_threw', status);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  return { model, analyse };
}

module.exports = { createAnthropicProvider };
