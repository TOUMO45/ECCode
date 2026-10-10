// Deterministic fake ExtractionProvider (simulated: true). It stands in for the model in every offline test and
// whenever no real adapter is available; nothing it returns is evidence about a real model's quality.
//
//   Text   A lexicon parser for English and Arabic (digits in both scripts, the dual form "نقطتي" = 2). Every
//          quote is an exact substring of the request text, so grounding holds by construction.
//   Image  sha256 of the bytes -> canned fields through an injectable image map (default
//          test/fixtures/extraction/fake-image-map.json). An unknown image reads as nothing, plus questions.
//   Faults `faults()` returns the fault to apply to this call (null for none): timeout, invalid_json,
//          schema_invalid or error (a leading 'fake_model:' is accepted). The caller owns the fault_flags table and
//          its counters; the adapter never touches service tables.
//
// The fake never follows an instruction by construction: sentences that read as instructions to an AI are masked
// out before parsing and only set addressedToAssistant; image text in the map is never copied into a field.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProviderError } from './provider.js';
import {
  FIELD_NAMES, parseAndValidate, numbersIn, unknownField, MAX_WORDING_CHARS,
} from './schema.js';

export const DEFAULT_IMAGE_MAP_PATH = fileURLToPath(new URL('../../test/fixtures/extraction/fake-image-map.json', import.meta.url));
export const FAKE_TIMEOUT_DELAY_MS = 50;
export const FAKE_FAULTS = Object.freeze(['timeout', 'invalid_json', 'schema_invalid', 'error']);

// Fields the buyer must state (or confirm) before a plan can be made; the fake asks about the unknown ones.
const ASKED_WHEN_UNKNOWN = Object.freeze(['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'deadline', 'budgetUsd', 'maxPickups']);

// ---- folding: same-length normalisation so match indices map back to the original text -----------------------

function fold(text) {
  return text
    .replace(/[٠-٩۰-۹]/g, (ch) => {
      const code = ch.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/[أإآ]/g, 'ا') // أ إ آ -> ا
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ـ/g, ' ') // tatweel
    .replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

// Sentences that address an AI or try to set money, roles or approvals. They are masked, never parsed.
const INSTRUCTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\b[^\n]{0,60}\b(?:previous|prior|above|earlier|instructions?|rules?|all)\b/,
  /\bsystem\s*:/,
  /\b(?:you are|act as|pretend)\b/,
  /\b(?:ai|assistant|language model|chatbot|llm)\b/,
  /\bset\s+(?:the\s+)?(?:budget|price|total|amount|quantity)\s+to\b/,
  /\bapprove\b[^\n]{0,40}\bsuppliers?\b/,
  /\b(?:make|grant|give)\b[^\n]{0,30}\b(?:admin|administrator|root)\b/,
  /\b(?:reveal|print|show)\b[^\n]{0,30}\b(?:prompt|password|secret|key)\b/,
  /تجاهل|تجاهلي|انس[\s\S]{0,12}التعليمات|التعليمات السابقه|التعليمات السابقة|ايها المساعد|يا مساعد|النظام\s*:|اعتمد\s+المورد|وافق\s+علي\s+المورد|اجعل\S*\s+(?:هذا\s+)?المستخدم\s+(?:مديرا|ادمن)/,
];

function isInstruction(foldedSentence) {
  return INSTRUCTION_PATTERNS.some((re) => re.test(foldedSentence));
}

// Returns { masked, flagged }: `masked` is `folded` with every instruction sentence blanked out (same length).
function maskInstructions(folded) {
  let masked = '';
  let flagged = false;
  let last = 0;
  const boundary = /[.!?؟\n؛;]+(?!\d)/gu;
  const take = (from, to) => {
    const sentence = folded.slice(from, to);
    if (isInstruction(sentence)) {
      flagged = true;
      masked += sentence.replace(/[^\n]/g, ' ');
    } else {
      masked += sentence;
    }
  };
  for (const m of folded.matchAll(boundary)) {
    take(last, m.index);
    masked += folded.slice(m.index, m.index + m[0].length);
    last = m.index + m[0].length;
  }
  take(last, folded.length);
  return { masked, flagged };
}

function detectInstruction(text) {
  return maskInstructions(fold(String(text).normalize('NFC'))).flagged;
}

// ---- the lexicon -----------------------------------------------------------------------------------------------

const NUM = String.raw`(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?![\d]|[.,]\d)`;
const NUMD = String.raw`(?<![\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d])`;

const CUP_WORD = String.raw`(?:cups?|كوب|اكواب|كاس|اكواب)`;
const LID_WORD = String.raw`(?:lids?|غطاء|اغطيه|اغطية|اغطيه|غطا)`;

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const AR_WORDS = { واحد: 1, واحده: 1, واحدة: 1, اثنان: 2, اثنين: 2, ثلاث: 3, ثلاثه: 3, ثلاثة: 3, اربع: 4, اربعه: 4, اربعة: 4, خمس: 5, خمسه: 5, خمسة: 5 };

function parseInteger(text) {
  const n = Number(text.replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}

// All matches of `re` -> [{ value, start, end }] (indices into the folded text); `valueOf(match)` returns null to skip.
function collect(masked, re, valueOf) {
  const out = [];
  for (const m of masked.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
    const value = valueOf(m);
    if (value !== null && value !== undefined) out.push({ value, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// One distinct value -> found; none or conflicting values -> not found (the fake never guesses).
function single(hits) {
  if (hits.length === 0) return null;
  const distinct = new Set(hits.map((h) => String(h.value)));
  return distinct.size === 1 ? hits[0] : null;
}

function parseHour(h, mm, marker) {
  let hour = Number(h);
  const minute = mm === undefined || mm === '' ? 0 : Number(mm);
  if (marker) {
    if (hour < 1 || hour > 12) return null;
    const pm = /^(?:pm|p\.m\.|مساء|م)$/.test(marker);
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseText(original) {
  const folded = fold(original);
  const { masked, flagged } = maskInstructions(folded);
  const found = {};
  const cups = [];
  const lids = [];

  // quantities: "200 cups and 200 lids", "200 cups and lids", "200 cups", "200 lids", dual forms
  cups.push(...collect(masked, new RegExp(`${NUM}\\s*${CUP_WORD}(?![\\p{L}])`, 'u'), (m) => parseInteger(m[1])));
  lids.push(...collect(masked, new RegExp(`${NUM}\\s*${LID_WORD}(?![\\p{L}])`, 'u'), (m) => parseInteger(m[1])));
  for (const hit of collect(masked, new RegExp(`${NUM}\\s*${CUP_WORD}\\s*(?:and|&|with|\\+|,|و|مع)\\s*(?:matching\\s+|مطابقه\\s+|مناسبه\\s+)?${LID_WORD}(?![a-z])`, 'u'), (m) => parseInteger(m[1]))) {
    cups.push(hit);
    lids.push(hit);
  }
  cups.push(...collect(masked, /(?<![\p{L}])كوبين(?![\p{L}])|(?<![\p{L}])كوبان(?![\p{L}])/u, () => 2));
  lids.push(...collect(masked, /(?<![\p{L}])غطاءين(?![\p{L}])|(?<![\p{L}])غطاءان(?![\p{L}])/u, () => 2));
  // de-duplicate exact repeats of the same span
  const uniq = (hits) => hits.filter((h, i) => hits.findIndex((o) => o.start === h.start && o.end === h.end) === i);
  const cupHit = single(uniq(cups));
  const lidHit = single(uniq(lids));
  if (cupHit) found.cupQuantity = cupHit;
  if (lidHit) found.lidQuantity = lidHit;

  // product type: from what the text asks for
  if (cupHit && lidHit) {
    const start = Math.min(cupHit.start, lidHit.start);
    const end = Math.max(cupHit.end, lidHit.end);
    if (end - start <= MAX_WORDING_CHARS) found.productType = { value: 'cups_and_lids', start, end };
  } else if (cupHit) {
    found.productType = { value: 'cups', start: cupHit.start, end: cupHit.end };
  } else if (lidHit) {
    found.productType = { value: 'lids', start: lidHit.start, end: lidHit.end };
  }

  // capacity and diameter: only integers, never converted
  found.capacityMl = single(collect(masked, new RegExp(`${NUM}\\s*(?:ml|millilit(?:er|re)s?|مل(?!م)|ملل)(?![a-z])`, 'u'), (m) => parseInteger(m[1])));
  found.diameterMm = single(collect(masked, new RegExp(`${NUM}\\s*(?:mm|millimet(?:er|re)s?|ملم|مم)(?![a-z])`, 'u'), (m) => parseInteger(m[1])));

  // material
  const materials = [
    ...collect(masked, /(?<![a-z])paper(?![a-z])|(?<![\p{L}])ورقي(?![\p{L}])|(?<![\p{L}])ورق(?![\p{L}])/u, () => 'paper'),
    ...collect(masked, /(?<![a-z])plastic(?![a-z])|(?<![\p{L}])بلاستيك(?:ي)?(?![\p{L}])/u, () => 'plastic'),
  ];
  found.material = single(materials);

  // deadline: needs minutes or an am/pm marker; a bare "by 11" is ambiguous and stays unknown
  const deadlines = [
    ...collect(masked, /(?<![a-z])(?:by|before|until|till|no later than|deadline(?:\s+is)?)\s*:?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d])/u,
      (m) => (m[2] === undefined && m[3] === undefined ? null : parseHour(m[1], m[2], m[3]))),
    ...collect(masked, /(?:قبل|حتي|حتى|بحلول)\s*(?:ال)?(?:ساعه|ساعة)?\s*(\d{1,2})(?::(\d{2}))?\s*(صباحا|مساء|ص|م)?(?![\d\p{L}])/u,
      (m) => (m[2] === undefined && m[3] === undefined ? null : parseHour(m[1], m[2], m[3] && m[3].startsWith('ص') ? 'am' : m[3] ? 'pm' : undefined))),
  ];
  found.deadline = single(deadlines);

  // budget in US dollars; any other currency leaves the budget unknown
  const usd = [
    ...collect(masked, new RegExp(`\\$\\s*${NUMD}`, 'u'), (m) => usdValue(m[1])),
    ...collect(masked, new RegExp(`${NUMD}\\s*(?:\\$|usd|us\\s*dollars?|dollars?|bucks|دولار(?:ا|ات)?)(?![a-z])`, 'u'), (m) => usdValue(m[1])),
  ];
  const otherCurrency = collect(masked, new RegExp(`${NUMD}\\s*(?:jod|jd|dinars?|دينار|دنانير|euros?|eur|pounds?|gbp|riyals?|sar|aed|dirhams?|درهم|ريال|يورو|جنيه)(?![a-z])|[€£]\\s*${NUMD}`, 'u'), () => 1);
  found.budgetUsd = otherCurrency.length > 0 ? null : single(uniq(usd));

  // maximum pickups
  const pickupNoun = String.raw`(?:pick[- ]?up\s+(?:points?|locations?|spots?|sites?|stops?)|collection\s+(?:points?|locations?)|pick[- ]?ups?)`;
  const pickups = [
    ...collect(masked, new RegExp(`(?<![\\d.,a-z])(\\d+|one|two|three|four|five)\\s*(?:different\\s+|separate\\s+)?${pickupNoun}(?![a-z])`, 'u'),
      (m) => (/^\d+$/.test(m[1]) ? parseInteger(m[1]) : WORDS[m[1]])),
    ...collect(masked, /(?<![a-z])(?:max(?:imum)?\s+)?pick[- ]?ups?\s*[:=]\s*(\d+)(?![\d])/u, (m) => parseInteger(m[1])),
    ...collect(masked, /(?<![\d.,])(\d+)\s*(?:نقاط|نقطه|نقطة|مواقع|موقع|اماكن)\s*(?:استلام|تسليم)/u, (m) => parseInteger(m[1])),
    ...collect(masked, /(?<![\p{L}])(?:نقطتي|نقطتين)(?:\s*(?:استلام|تسليم))?/u, () => 2),
    ...collect(masked, /(?<![\p{L}])نقط[هة]\s*(?:استلام|تسليم)\s*(واحد[هة])/u, () => 1),
  ];
  found.maxPickups = single(uniq(pickups));

  return { found, flagged, otherCurrency: otherCurrency.length > 0 };
}

function usdValue(text) {
  const clean = text.replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(clean);
  if (!m || (m[2] !== undefined && m[2].length > 2)) return null;
  return Number(clean);
}

function detectLanguage(text) {
  const arabic = (text.match(/[؀-ۿ]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (arabic === 0 && latin === 0) return 'unknown';
  if (arabic === 0) return 'en';
  if (latin === 0) return 'ar';
  const small = Math.min(arabic, latin);
  const large = Math.max(arabic, latin);
  if (small < 3 || small / large < 0.15) return arabic > latin ? 'ar' : 'en';
  return 'mixed';
}

// ---- the image map --------------------------------------------------------------------------------------------

// Entry shape: { fields: { <name>: { value, wording } }, visibleNumbers?: number[], questions?: string[],
//                addressedToAssistant?: boolean, imageText?: string, language?: string }
// `imageText` is what the picture "says"; it is only ever scanned for instructions, never copied into a field.
export function loadImageMap(path = DEFAULT_IMAGE_MAP_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  const map = JSON.parse(raw);
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new TypeError('the image map must be a JSON object');
  return map;
}

export function sha256OfImage(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function entryFor(map, sha) {
  return Object.hasOwn(map, sha) && map[sha] !== null && typeof map[sha] === 'object' ? map[sha] : null;
}

function readImage(entry) {
  const fields = {};
  const numbers = new Set();
  const spec = entry.fields && typeof entry.fields === 'object' ? entry.fields : {};
  for (const name of FIELD_NAMES) {
    const f = Object.hasOwn(spec, name) ? spec[name] : null;
    if (!f || f.value === null || f.value === undefined) continue;
    const wording = typeof f.wording === 'string' ? f.wording.slice(0, MAX_WORDING_CHARS) : null;
    fields[name] = { value: f.value, wording };
    if (typeof f.value === 'number') numbers.add(f.value);
    if (wording) for (const n of numbersIn(wording)) numbers.add(n);
  }
  for (const n of entry.visibleNumbers ?? []) if (Number.isFinite(n)) numbers.add(Number(n));
  const flagged = entry.addressedToAssistant === true || (typeof entry.imageText === 'string' && detectInstruction(entry.imageText));
  const questions = Array.isArray(entry.questions) ? entry.questions.filter((q) => FIELD_NAMES.includes(q)) : [];
  return { fields, numbers, flagged, questions, language: typeof entry.language === 'string' ? entry.language : null };
}

// ---- the provider -------------------------------------------------------------------------------------------------

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('PROVIDER_TIMEOUT'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new ProviderError('PROVIDER_TIMEOUT'));
    }, { once: true });
  });
}

function toMicroUsd(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('costMicroUsd must be a non-negative integer');
  return value;
}

/**
 * createFakeProvider({ costMicroUsd?, imageMap?, imageMapPath?, faults?, sleep?, clock?, model?, rephrase? })
 *   costMicroUsd  integer micro-dollars reported per call (RS_FAKE_MODEL_COST_USD as micro-dollars; default 0)
 *   imageMap      object keyed by sha256 hex; defaults to the file at imageMapPath (missing file = empty map)
 *   faults        () => null | 'timeout' | 'invalid_json' | 'schema_invalid' | 'error'
 *   rephrase      (input) => string, replaces the default rephrasing of lines (tests use it for bad output)
 */
export function createFakeProvider({
  costMicroUsd = 0, imageMap, imageMapPath = DEFAULT_IMAGE_MAP_PATH, faults = () => null, sleep = defaultSleep,
  clock = { now: () => Date.now() }, model = 'fake', rephrase: rephraseFn,
} = {}) {
  const cost = toMicroUsd(costMicroUsd);
  let map = imageMap ?? null;

  const usageFor = (startedMs, text, extra = 0) => ({
    model,
    costUsd: cost / 1_000_000,
    costMicroUsd: cost,
    inputTokens: Math.ceil(String(text).length / 4) + extra,
    outputTokens: 120,
    latencyMs: Math.max(0, clock.now() - startedMs),
  });

  function faultOf() {
    const raw = faults();
    if (raw === null || raw === undefined || raw === '') return null;
    const name = String(raw).replace(/^fake_model:/, '');
    if (!FAKE_FAULTS.includes(name)) throw new RangeError('unknown fake model fault');
    return name;
  }

  async function extract({ text, image = null, signal } = {}) {
    const started = clock.now();
    if (typeof text !== 'string') throw new TypeError('extract needs the request text');
    if (signal?.aborted) throw new ProviderError('PROVIDER_TIMEOUT');

    const fault = faultOf();
    if (fault === 'timeout') {
      await sleep(FAKE_TIMEOUT_DELAY_MS, signal);
      throw new ProviderError('PROVIDER_TIMEOUT', { usage: { ...usageFor(started, text), costUsd: 0, costMicroUsd: 0 } });
    }
    if (fault === 'error') throw new ProviderError('PROVIDER_UNAVAILABLE', { usage: { ...usageFor(started, text), costUsd: 0, costMicroUsd: 0 } });

    const normalized = text.normalize('NFC');
    const { found, flagged, otherCurrency } = parseText(normalized);
    const fields = {};
    for (const name of FIELD_NAMES) fields[name] = unknownField();
    for (const name of FIELD_NAMES) {
      const hit = found[name];
      if (hit) {
        fields[name] = { value: hit.value, provenance: 'user_text', originalWording: normalized.slice(hit.start, hit.end) };
      }
    }

    let language = detectLanguage(normalized);
    let addressed = flagged;
    let imageQuestions = [];
    let imageNumbers;
    if (image) {
      if (map === null) map = loadImageMap(imageMapPath);
      const entry = entryFor(map, sha256OfImage(image.bytes));
      if (entry) {
        const read = readImage(entry);
        for (const [name, f] of Object.entries(read.fields)) {
          if (fields[name].provenance === 'none') fields[name] = { value: f.value, provenance: 'image', originalWording: f.wording };
        }
        imageNumbers = read.numbers;
        imageQuestions = read.questions;
        addressed = addressed || read.flagged;
        if (language === 'unknown' && read.language) language = read.language;
      } else {
        imageQuestions = ['capacityMl', 'diameterMm'];
      }
    }

    const asked = new Set(imageQuestions);
    const type = fields.productType.value;
    for (const name of ASKED_WHEN_UNKNOWN) {
      if (fields[name].provenance !== 'none') continue;
      if (name === 'lidQuantity' && type === 'cups') continue;
      if (name === 'cupQuantity' && type === 'lids') continue;
      asked.add(name);
    }
    if (otherCurrency) asked.add('budgetUsd');
    const questions = FIELD_NAMES.filter((n) => asked.has(n) && fields[n].provenance === 'none');

    const output = { language, fields, questions, addressedToAssistant: addressed };

    let rawJson = JSON.stringify(output);
    if (fault === 'invalid_json') rawJson = `${rawJson.slice(0, Math.floor(rawJson.length / 2))}`;
    if (fault === 'schema_invalid') rawJson = JSON.stringify({ ...output, approvedSupplier: 'C' });
    // The same path a real adapter takes: parse defensively, validate strictly, then trust.
    const checked = parseAndValidate(rawJson, { text: normalized, imageNumbers });
    if (!checked.ok) {
      throw new ProviderError('PROVIDER_BAD_OUTPUT', { usage: usageFor(started, text) });
    }
    return { output: checked.value, usage: usageFor(started, text) };
  }

  async function rephrase({ input, signal } = {}) {
    const started = clock.now();
    if (signal?.aborted) throw new ProviderError('PROVIDER_TIMEOUT');
    const fault = faultOf();
    if (fault === 'timeout') {
      await sleep(FAKE_TIMEOUT_DELAY_MS, signal);
      throw new ProviderError('PROVIDER_TIMEOUT');
    }
    if (fault === 'error') throw new ProviderError('PROVIDER_UNAVAILABLE');
    const lines = Array.isArray(input?.lines) ? input.lines : [];
    const text = rephraseFn ? rephraseFn(input) : `In short: ${lines.map((l) => l.text).join(' ')}`;
    return { output: { text }, usage: usageFor(started, text) };
  }

  return Object.freeze({ id: 'fake', simulated: true, model, extract, rephrase });
}
