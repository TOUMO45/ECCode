// Anthropic Messages API provider (spec 3.10). Cannot be exercised live on this host
// (no API key); tested against a local fake HTTP server.
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { validateDraft, parseJsonText } from './schema.js';
import { ProviderError, safeNumber, logCall } from './provider.js';

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULTS = Object.freeze({ timeoutMs: 60000, deadlineMs: 150000, maxAttempts: 3, backoffMs: 500, maxResponseBytes: 2 * 1024 * 1024 });

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ProviderError('PROVIDER_UNAVAILABLE', 'aborted')); }, { once: true });
});

/**
 * @param {{config:{anthropic:{apiKey:string,model:string,url:string}}, env?:object, log?:Function, timeoutMs?:number, deadlineMs?:number, maxAttempts?:number, backoffMs?:number}} opts
 * The key is read at call time (env first, then config) and never logged.
 */
export function createAnthropicProvider({ config, env = process.env, log, ...over }) {
  const o = { ...ANTHROPIC_DEFAULTS, ...over };
  const a = config.anthropic;
  const key = () => env.ANTHROPIC_API_KEY || a.apiKey || '';

  async function callOnce(body, apiKey, signal) {
    const ctl = AbortSignal.any([AbortSignal.timeout(o.timeoutMs), ...(signal ? [signal] : [])]);
    let res;
    try {
      res = await fetch(`${a.url.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
        body,
        signal: ctl,
        redirect: 'error',
      });
      if (res.status === 429) throw new ProviderError('PROVIDER_BUSY', 'http-429');
      if (res.status >= 500) throw new ProviderError('PROVIDER_UNAVAILABLE', `http-${res.status}`);
      if (!res.ok) throw new ProviderError('PROVIDER_UNAVAILABLE', `http-${res.status}`);
      const text = await res.text();
      if (text.length > o.maxResponseBytes) throw new ProviderError('PROVIDER_BAD_OUTPUT', 'too-large');
      return text;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (signal?.aborted) throw new ProviderError('PROVIDER_UNAVAILABLE', 'aborted');
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new ProviderError('PROVIDER_TIMEOUT', 'timeout');
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'network');
    }
  }

  function parse(text) {
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      throw new ProviderError('PROVIDER_BAD_OUTPUT', 'api-json');
    }
    const usage = { inputTokens: safeNumber(r?.usage?.input_tokens), outputTokens: safeNumber(r?.usage?.output_tokens) };
    const joined = (Array.isArray(r?.content) ? r.content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    const v = validateDraft(parseJsonText(joined));
    if (!v.ok) throw Object.assign(new ProviderError('PROVIDER_BAD_OUTPUT', 'schema'), { usage });
    return { draft: v.draft, usage, model: typeof r.model === 'string' ? r.model : a.model };
  }

  return {
    id: 'anthropic',
    isFallback: false,
    async available() {
      return key().length > 0;
    },
    async generate({ incident, lines, signal }) {
      const started = Date.now();
      const apiKey = key();
      if (!apiKey) throw new ProviderError('PROVIDER_UNAVAILABLE', 'no-key');
      const body = JSON.stringify({
        model: a.model, max_tokens: 4096, temperature: 0, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage({ incident, lines }) }],
      });
      let attempts = 0;
      let inTok = 0;
      let outTok = 0;
      let lastErr;
      try {
        while (attempts < o.maxAttempts) {
          if (Date.now() - started >= o.deadlineMs) break;
          attempts += 1;
          try {
            const parsed = parse(await callOnce(body, apiKey, signal));
            inTok += parsed.usage.inputTokens;
            outTok += parsed.usage.outputTokens;
            const usage = { model: parsed.model, inputTokens: inTok, outputTokens: outTok, costUsd: 0, durationMs: Date.now() - started, attempts };
            logCall(log, { provider: 'anthropic', ok: true, ...usage });
            return { draft: parsed.draft, usage };
          } catch (e) {
            if (!(e instanceof ProviderError)) throw e;
            if (e.usage) { inTok += e.usage.inputTokens; outTok += e.usage.outputTokens; }
            lastErr = e;
            if (e.code === 'PROVIDER_TIMEOUT') break; // never retry after a timeout
            if (e.code === 'PROVIDER_BAD_OUTPUT' && attempts >= 2) break; // one retry for malformed output
            if (e.code === 'PROVIDER_UNAVAILABLE' && !/^http-5/.test(e.reason)) break;
            if (attempts < o.maxAttempts) await sleep(o.backoffMs * 2 ** (attempts - 1), signal);
          }
        }
        throw lastErr ?? new ProviderError('PROVIDER_UNAVAILABLE', 'deadline');
      } catch (e) {
        logCall(log, { provider: 'anthropic', ok: false, code: e.code ?? 'ERROR', reason: e.reason ?? '', attempts, durationMs: Date.now() - started });
        throw e instanceof ProviderError ? e : new ProviderError('PROVIDER_UNAVAILABLE', 'internal');
      }
    },
  };
}
