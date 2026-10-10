// Opt-in rephrasing of plan explanations (RS_EXPLAIN_REPHRASE=1; off by default and in the deterministic suites).
//
// The explanation is already complete and correct as fixed templates (domain/explain.js). Rephrasing may only
// reword it. The guard (SEC-17, RS-05):
//   * the model input carries only planner codes and the template sentences, which hold supplier letters and
//     numbers and fixed words; it never carries supplier, product or address names or refusal_reason text, because
//     the input is built from the explanation lines alone, never from the trace's catalog fields;
//   * a rephrased text that contains a number (either digit script) or a supplier code (a standalone capital
//     letter) that the template text does not contain is DISCARDED and the template stands;
//   * the guard cannot detect a reordered comparison or a negation (accepted residual, the feature is opt-in and
//     the result is labelled "AI-rephrased").
// The same provider and the same gate are used (purpose 'rephrase'). Every failure leaves the template as it is.
import { foldDigits } from './schema.js';
import { buildRephrasePrompt } from './prompt.js';
import { errorCodeOf } from './provider.js';

export const REPHRASE_LABEL = 'AI-rephrased';
export const MAX_REPHRASE_CHARS = 1200;
const MAX_LINE_CHARS = 400;
const MAX_LINES = 40;
const LINE_CODE = /^[A-Z][A-Z0-9_]{2,47}$/;

// Number words that would smuggle in a figure the digits check cannot see.
const NUMBER_WORDS = /\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|half|dozen|double|triple)\b/i;

function numberTokens(text) {
  const folded = foldDigits(String(text));
  const whole = new Set();
  const parts = new Set();
  for (const m of folded.matchAll(/\d+(?:[.,:]\d+)*/g)) {
    whole.add(m[0]);
    for (const piece of m[0].split(/[.,:]/)) parts.add(piece);
  }
  return { whole, parts };
}

function supplierCodeTokens(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/(?<![A-Za-z0-9])[A-Z](?![A-Za-z0-9])/g)) out.add(m[0]);
  return out;
}

/**
 * guardRephrased(templateText, candidate) -> { ok: boolean, reason: string|null, foreignNumbers, foreignCodes }
 * `templateText` is the template explanation (all line texts joined); `candidate` is the model's text.
 * Reasons: NOT_TEXT, EMPTY, TOO_LONG, FOREIGN_NUMBER, FOREIGN_CODE, NUMBER_WORD, LINK.
 */
export function guardRephrased(templateText, candidate) {
  const verdict = (reason, extra = {}) => ({ ok: false, reason, foreignNumbers: [], foreignCodes: [], ...extra });
  if (typeof candidate !== 'string') return verdict('NOT_TEXT');
  const text = candidate.trim();
  if (text === '') return verdict('EMPTY');
  if (text.length > MAX_REPHRASE_CHARS) return verdict('TOO_LONG');
  if (/:\/\/|www\.|@/i.test(text)) return verdict('LINK');

  const allowedNumbers = numberTokens(templateText);
  const foreignNumbers = [...numberTokens(text).whole].filter((n) => !allowedNumbers.whole.has(n) && !allowedNumbers.parts.has(n));
  if (foreignNumbers.length > 0) return verdict('FOREIGN_NUMBER', { foreignNumbers });

  const allowedCodes = supplierCodeTokens(templateText);
  const foreignCodes = [...supplierCodeTokens(text)].filter((c) => !allowedCodes.has(c));
  if (foreignCodes.length > 0) return verdict('FOREIGN_CODE', { foreignCodes });

  const templateWords = new Set((String(templateText).toLowerCase().match(NUMBER_WORDS_GLOBAL) ?? []));
  const foreignWords = (text.toLowerCase().match(NUMBER_WORDS_GLOBAL) ?? []).filter((w) => !templateWords.has(w));
  if (foreignWords.length > 0) return verdict('NUMBER_WORD');

  return { ok: true, reason: null, foreignNumbers: [], foreignCodes: [] };
}
const NUMBER_WORDS_GLOBAL = new RegExp(NUMBER_WORDS.source, 'gi');

/**
 * buildRephraseInput(explanation) -> { lines: [{ code, text }] }
 * Only lines with a planner code and a short template sentence pass; nothing else of the explanation or the trace
 * is forwarded.
 */
export function buildRephraseInput(explanation) {
  const lines = Array.isArray(explanation?.lines) ? explanation.lines : [];
  const kept = [];
  for (const line of lines) {
    if (kept.length >= MAX_LINES) break;
    if (!line || typeof line.code !== 'string' || !LINE_CODE.test(line.code)) continue;
    if (typeof line.text !== 'string' || line.text.length === 0 || line.text.length > MAX_LINE_CHARS) continue;
    kept.push({ code: line.code, text: line.text });
  }
  return { lines: kept };
}

function parseOutput(output) {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'text' || typeof value.text !== 'string') return null;
  return value.text;
}

/**
 * createRephraser({ provider, gate, enabled = false, timeoutMs = 30000 })
 *   rephrase({ explanation, customerId, requestId?, signal? })
 *     -> { explanation, outcome, reason }
 *   explanation is { lines, rephrased: null } in, and the same object shape out with rephrased either null or
 *   { text, label: 'AI-rephrased', source: provider.id }. Lines are never altered.
 *   outcome: 'disabled' | 'accepted' | 'discarded' (guard) | 'refused' (gate) | 'failed' (provider)
 */
export function createRephraser({ provider, gate, enabled = false, timeoutMs = 30000 }) {
  async function rephrase({ explanation, customerId, requestId = null, signal }) {
    const template = { lines: explanation.lines, rephrased: null };
    if (!enabled) return { explanation: template, outcome: 'disabled', reason: null };
    if (!provider || typeof provider.rephrase !== 'function') return { explanation: template, outcome: 'failed', reason: 'PROVIDER_UNAVAILABLE' };

    const input = buildRephraseInput(explanation);
    if (input.lines.length === 0) return { explanation: template, outcome: 'discarded', reason: 'NO_INPUT' };
    const prompt = buildRephrasePrompt(input);
    const templateText = explanation.lines.map((l) => l.text).join('\n');

    let result;
    try {
      result = await gate.run({
        customerId,
        requestId,
        purpose: 'rephrase',
        call: () => provider.rephrase({
          system: prompt.system,
          content: prompt.content,
          input,
          signal: signal ?? AbortSignal.timeout(timeoutMs),
        }),
      });
    } catch (err) {
      if (err && err.name === 'AppError') return { explanation: template, outcome: 'refused', reason: err.details?.scope ?? err.details?.limit ?? err.code };
      return { explanation: template, outcome: 'failed', reason: errorCodeOf(err) };
    }

    const candidate = parseOutput(result?.output);
    const verdict = guardRephrased(templateText, candidate);
    if (!verdict.ok) return { explanation: template, outcome: 'discarded', reason: verdict.reason };
    return {
      explanation: { lines: explanation.lines, rephrased: { text: candidate.trim(), label: REPHRASE_LABEL, source: provider.id } },
      outcome: 'accepted',
      reason: null,
    };
  }
  return Object.freeze({ rephrase, enabled });
}
