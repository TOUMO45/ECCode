// Normalisation (spec 5.1). Pure; applied identically to statements and cited text.
import { UNIT_ALT } from './units.js';

const ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/giu;
const TIME_RE = /(?<![\w:.])(\d{1,2}):([0-5]\d)(?::[0-5]\d)?(?![\w:]|\.\d)/gu;

const WORD_NUM = {
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12',
};
const WORD_NUM_RE = new RegExp(`(?<![\\p{L}\\d_])(${Object.keys(WORD_NUM).join('|')})(?![\\p{L}\\d_])`, 'giu');
// "one" only before a recognised unit (DQ-2); optional hyphen counts ("one-minute").
const ONE_RE = new RegExp(`(?<![\\p{L}\\d_])one(?:\\s+|-)(?=(?:${UNIT_ALT})(?![\\p{L}\\d_]))`, 'giu');
// number word or digits joined to a unit by a hyphen: "five-minute" -> "5 minute"
const HYPH_UNIT_RE = new RegExp(`(?<![\\w.-])(\\d+(?:\\.\\d+)?)-(?=(?:${UNIT_ALT})(?![\\p{L}\\d_]))`, 'giu');
const THOUSANDS_RE = /(?<![\w.,-])\d{1,3}(?:,\d{3})+(?![\w-]|,\d)/gu;
// "5min", "40%" -> "5 min", "40 %"
const GLUE_RE = new RegExp(`(?<![\\w.-])(\\d+(?:\\.\\d+)?)(?=(?:${UNIT_ALT})(?![\\p{L}\\d_]))`, 'giu');

// Magnitude suffixes: "310k", "90M", "1.84 million" -> plain integers, so "310 thousand" and "310k" agree.
// Glued form accepts k/K (thousand), M (million) and B (billion) only; lower-case "m"/"b" stay as they are.
const MAG = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
const MAG_GLUED_RE = /(?<![\w.-])(\d+(?:\.\d+)?)([kKMB])(?![\p{L}\d_])/gu;
const MAG_WORD_RE = /(?<![\w.-])(\d+(?:\.\d+)?)\s+(thousand|million|billion)(?![\p{L}\d_])/giu;
const scale = (num, mag) => String(Math.round(Number(num) * MAG[mag.toLowerCase()]));

export function normalizeMagnitudes(s) {
  return s.replace(MAG_GLUED_RE, (m, n, k) => scale(n, k)).replace(MAG_WORD_RE, (m, n, w) => scale(n, w));
}

export function normalizeTimes(s) {
  let out = s.replace(ISO_RE, (m) => {
    const mm = /[T ](\d{2}):(\d{2})/i.exec(m);
    return Number(mm[1]) <= 23 && Number(mm[2]) <= 59 ? `${mm[1]}:${mm[2]}` : m;
  });
  out = out.replace(TIME_RE, (m, h, min) => (Number(h) <= 23 ? `${h.padStart(2, '0')}:${min}` : m));
  return out;
}

/**
 * @param {string} text
 * @param {{fold?: boolean}} [opts] fold=false keeps case (used for the name rule)
 */
export function normalize(text, opts = {}) {
  const fold = opts.fold !== false;
  let s = String(text ?? '').normalize('NFKC');
  s = s.replace(/\s+/gu, ' ').trim();
  s = normalizeMagnitudes(s);
  if (fold) s = s.toLowerCase();
  s = normalizeTimes(s);
  s = s.replace(WORD_NUM_RE, (m) => WORD_NUM[m.toLowerCase()]);
  s = s.replace(ONE_RE, '1 ');
  s = s.replace(HYPH_UNIT_RE, '$1 ');
  s = s.replace(THOUSANDS_RE, (m) => m.replace(/,/g, ''));
  s = s.replace(GLUE_RE, '$1 ');
  s = s.replace(MAG_WORD_RE, (m, n, w) => scale(n, w)); // "two thousand" after number words became digits
  return s;
}
