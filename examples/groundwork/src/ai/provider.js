// Narrow provider adapter contract (spec 3.10).
//
// interface Provider {
//   id: 'anthropic'|'cli'|'fallback'|'fake'|'fake-clean'
//   isFallback: boolean
//   available(): Promise<boolean>
//   generate({ incident:{title,severity,startedAt}, lines:NoteLine[], signal?:AbortSignal })
//     -> Promise<{ draft: DraftJSON, usage:{model,inputTokens,outputTokens,costUsd,durationMs,attempts} }>
// }
// Failures reject with ProviderError. Messages are fixed strings; nothing from the
// model, the CLI stderr or the network is ever put in `message`.

export const PROVIDER_IDS = Object.freeze(['anthropic', 'cli', 'fallback', 'fake', 'fake-clean']);
export const ERROR_CODES = Object.freeze(['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_BAD_OUTPUT', 'PROVIDER_BUSY']);

const MESSAGES = {
  PROVIDER_TIMEOUT: 'The provider timed out',
  PROVIDER_UNAVAILABLE: 'The provider is unavailable',
  PROVIDER_BAD_OUTPUT: 'The provider returned an unusable result',
  PROVIDER_BUSY: 'The provider is busy',
};

export class ProviderError extends Error {
  /** @param {string} code one of ERROR_CODES  @param {string} [reason] short internal class for logs, never returned to clients */
  constructor(code, reason = '') {
    super(MESSAGES[code] ?? MESSAGES.PROVIDER_UNAVAILABLE);
    this.name = 'ProviderError';
    this.code = ERROR_CODES.includes(code) ? code : 'PROVIDER_UNAVAILABLE';
    this.reason = String(reason).slice(0, 60);
  }
}

/** Throws TypeError when an object does not satisfy the Provider interface. */
export function assertProvider(p) {
  if (!p || !PROVIDER_IDS.includes(p.id)) throw new TypeError('provider.id invalid');
  if (typeof p.isFallback !== 'boolean') throw new TypeError('provider.isFallback must be boolean');
  if (typeof p.available !== 'function' || typeof p.generate !== 'function') {
    throw new TypeError('provider must implement available() and generate()');
  }
  return p;
}

export function emptyUsage(model = '') {
  return { model, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, attempts: 0 };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
export { num as safeNumber };

/** Structured, content-free log record (latency, tokens, cost). */
export function logCall(log, rec) {
  if (typeof log !== 'function') return;
  try {
    log({ event: 'ai.call', ...rec });
  } catch {
    /* logging must never break a request */
  }
}
