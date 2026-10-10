// ExtractionProvider contract (AI / LLM Design; Interface Contracts, "ai/provider.js").
//
//   ExtractionProvider = {
//     id: 'fake' | 'cli' | 'anthropic',
//     simulated: boolean,                  // true only for the fake; the UI labels simulated extraction
//     model: string,                       // 'haiku' by default (NFR6)
//     extract({ text: string, image: { bytes: Buffer, mime: string } | null, signal: AbortSignal })
//       -> Promise<{ output: ExtractionOutput,   // already validated by schema.js validateExtraction
//                    usage: { model, costUsd, costMicroUsd?, inputTokens, outputTokens, latencyMs } }>
//        | rejects ProviderError { code: PROVIDER_TIMEOUT | PROVIDER_UNAVAILABLE | PROVIDER_BAD_OUTPUT | PROVIDER_BUSY, usage? }
//     rephrase?({ system, content, input, signal })   // optional, only when RS_EXPLAIN_REPHRASE=1
//       -> Promise<{ output: { text: string }, usage }>
//   }
//
// `costMicroUsd` (integer micro-dollars, F-TR-12) is the exact amount the gate settles with when present; `costUsd`
// is the same amount as a number for display and for adapters that only know dollars.
import { unknownExtraction } from './schema.js';

export const PROVIDER_ERROR_CODES = Object.freeze([
  'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_BAD_OUTPUT', 'PROVIDER_BUSY',
]);
export const PROVIDER_IDS = Object.freeze(['fake', 'cli', 'anthropic']);
export const DEFAULT_MODEL = 'haiku';

const MESSAGES = Object.freeze({
  PROVIDER_TIMEOUT: 'The model did not answer in time.',
  PROVIDER_UNAVAILABLE: 'The model is unavailable.',
  PROVIDER_BAD_OUTPUT: 'The model returned output that failed validation.',
  PROVIDER_BUSY: 'The model is busy.',
});

// The message is fixed text per code; it never echoes model output or buyer input.
export class ProviderError extends Error {
  constructor(code, { usage, cause } = {}) {
    if (!PROVIDER_ERROR_CODES.includes(code)) throw new TypeError('unknown provider error code');
    super(MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
    this.code = code;
    if (usage !== undefined) this.usage = usage;
  }
}

export function isProviderError(err) {
  return err instanceof Error && err.name === 'ProviderError' && PROVIDER_ERROR_CODES.includes(err.code);
}

// Any failure of a provider call becomes one of the four codes; an unexpected error is PROVIDER_UNAVAILABLE.
export function errorCodeOf(err) {
  return isProviderError(err) ? err.code : 'PROVIDER_UNAVAILABLE';
}

export function assertExtractionProvider(provider) {
  const ok = provider !== null && typeof provider === 'object' &&
    PROVIDER_IDS.includes(provider.id) &&
    typeof provider.simulated === 'boolean' &&
    typeof provider.model === 'string' && provider.model.length > 0 &&
    typeof provider.extract === 'function';
  if (!ok) throw new TypeError('not an ExtractionProvider');
  return provider;
}

/**
 * The degraded result of a failed provider call (RS-03): schema_ok = false, an error code and every field unknown.
 * Row-level labels (`degraded: true`, notice text) are added by the extraction service.
 */
export function toDegraded(err) {
  return { schemaOk: false, degraded: true, errorCode: errorCodeOf(err), output: unknownExtraction() };
}

/**
 * Provider selection. Always the fake when RS_TEST_OFFLINE=1 (config.testOffline), whatever else is configured.
 * Otherwise config.extractionProvider (falling back to config.modelProvider) picks the factory. A missing adapter
 * (for example the claude binary was not found) falls back to the fake, and the result says so:
 *   { provider, requested, source: 'fake' | 'cli' | 'anthropic' | 'fallback', fellBack: boolean, reason }
 * `factories` = { fake: () => provider, cli?: () => provider | null, anthropic?: () => provider | null }.
 */
export function selectProvider(config, factories) {
  if (!factories || typeof factories.fake !== 'function') throw new TypeError('selectProvider needs a fake factory');
  const requested = config?.testOffline === true ? 'fake' : String(config?.extractionProvider ?? config?.modelProvider ?? 'fake');
  if (!PROVIDER_IDS.includes(requested)) throw new RangeError('unknown model provider');

  if (requested === 'fake') {
    return { provider: assertExtractionProvider(factories.fake()), requested, source: 'fake', fellBack: false, reason: null };
  }
  const made = typeof factories[requested] === 'function' ? factories[requested]() : null;
  if (made) {
    return { provider: assertExtractionProvider(made), requested, source: requested, fellBack: false, reason: null };
  }
  return {
    provider: assertExtractionProvider(factories.fake()),
    requested,
    source: 'fallback',
    fellBack: true,
    reason: `${requested} adapter unavailable`,
  };
}
