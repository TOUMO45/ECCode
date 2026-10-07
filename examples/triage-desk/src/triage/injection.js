'use strict';
// Deterministic prompt-injection heuristics on the ORIGINAL ticket text (spec C6.3, D1.3, R8, DES-7).
// Pure: no I/O, no clock, no randomness, no state between calls. The flag drives the UI warning and tells the
// fallback which sentences to drop before scoring; it is not a security boundary (the model sees neutralised text).
//
// Patterns are written as general families, not per-example phrases. They were tuned only on `split: tune` and
// in-family attack rows of eval/dataset.json and measured only with `npm run eval:tune` (spec E5, DES-2).

const RULE_IDS = Object.freeze(['INJ_DELIM', 'INJ_EXTRACT', 'INJ_LABEL', 'INJ_LINK', 'INJ_OVERRIDE', 'INJ_ROLE']);

// Angle brackets and their lookalikes (DES-7): ASCII, full-width (the neutralised form), CJK, single guillemets,
// mathematical and small-form variants. Any opener may pair with any closer.
const OPEN = '[<\\uFF1C\\u3008\\u2039\\u27E8\\uFE64]';
const CLOSE = '[>\\uFF1E\\u3009\\u203A\\u27E9\\uFE65]';

const CATEGORY_WORD = '(?:billing|technical|account|feature[ _-]?request|other)';
const LABEL_VALUE = '(?:billing|technical|account|feature[ _-]?request|other|low|medium|high|urgent|critical|p[0-4])';
const INSTRUCTION_NOUN = '(?:instructions?|rules|prompts?|directions|guidelines|directives|programming|guardrails|constraints|commands)';

// Full-text rules: every match marks the sentences it overlaps. All patterns are bounded (no nested unbounded
// quantifiers), so the cost stays linear-ish on the 8,000-character cap.
const TEXT_RULES = Object.freeze([
  // instruction_override: "ignore/disregard/forget ... previous/your instructions", "new instructions:".
  { id: 'INJ_OVERRIDE', re: new RegExp(
    '\\b(?:ignore|disregard|forget|override|bypass)\\s+' +
    '(?:(?:all|any|every|of|the|your|these|those|previous|prior|above|earlier|preceding|original|initial|system|existing|current|other)\\s+){0,4}' +
    INSTRUCTION_NOUN + '\\b', 'gi') },
  { id: 'INJ_OVERRIDE', re: /\bnew\s+(?:system\s+)?instructions?\s*:/gi },

  // role_spoofing: role markers at the start of a line, bracketed roles, chat-template tokens, persona switches,
  // and messages claiming to come from the vendor or the developers.
  { id: 'INJ_ROLE', re: /^[ \t>*_-]*\[?(?:system|assistant|developer|admin(?:istrator)?|operator)\]?[ \t]*:/gim },
  { id: 'INJ_ROLE', re: /\[(?:system|assistant|developer|admin(?:istrator)?|operator)\]/gi },
  { id: 'INJ_ROLE', re: /\[\/?INST\]|<<\/?SYS>>|<\|[^|\n]{1,40}\|>/gi },
  { id: 'INJ_ROLE', re: /\byou\s+are\s+now\s+(?:a|an|the|my|in|acting|operating|playing|no\s+longer|unrestricted|free)\b/gi },
  { id: 'INJ_ROLE', re: /^[ \t]*#{1,6}[ \t]*(?:system|assistant|developer|admin(?:istrator)?)\b[^\n]{0,40}$/gim },
  { id: 'INJ_ROLE', re: /\b(?:developer|admin(?:istrator)?|system)\s+(?:message|note|notice|instructions?)\s+from\b/gi },
  { id: 'INJ_ROLE', re: /\b(?:message|instructions?|policy|notice|update)\s+from\s+(?:anthropic|openai|the\s+(?:developers?|ai\s+team|model\s+provider))\b/gi },

  // delimiter_spoofing: fake <ticket>/<system> tags (ASCII or lookalike brackets), end-of-input markers on their
  // own line, and fenced "system" blocks.
  { id: 'INJ_DELIM', re: new RegExp(OPEN + '\\s*\\/?\\s*(?:ticket|system|assistant|instructions?)\\s*' + CLOSE, 'gi') },
  { id: 'INJ_DELIM', re: /\bend\s+of\s+ticket\b/gi },
  { id: 'INJ_DELIM', re: /^[ \t\-=#*_~`>[(]*(?:end|start|begin(?:ning)?)\s+of\s+(?:the\s+)?(?:\w+\s+)?(?:ticket|message|input|data|prompt)\b[ \t\-=#*_~`\])]*$/gim },
  { id: 'INJ_DELIM', re: /```[ \t]*(?:system|assistant|instructions?)\b/gi },

  // prompt_extraction: requests to reveal, print or repeat the prompt or instructions.
  { id: 'INJ_EXTRACT', re: new RegExp(
    '\\b(?:print|reveal|show|display|repeat|output|quote|recite|dump|leak|share|tell\\s+me|give\\s+me|write\\s+out|paste|expose|disclose)\\b' +
    '[^.!?\\n]{0,40}?\\b(?:system\\s+prompt|(?:your|the\\s+(?:hidden|system|initial|original|secret|internal))\\s+(?:\\w+\\s+){0,2}?' +
    '(?:instructions|prompt|rules|guidelines|directives|configuration))\\b(?!\\s+(?:for|on|about|how)\\b|\\s+to\\s+(?!me\\b|us\\b))', 'gi') },
  { id: 'INJ_EXTRACT', re: /\b(?:what|which)\s+(?:exactly\s+)?(?:are|were|is)\s+your\s+(?:\w+\s+)?(?:instructions|rules|guidelines|directives|system\s+prompt|prompt)\b(?!\s+(?:for|on|about|how)\b|\s+to\s+(?!me\b|us\b))/gi },
  { id: 'INJ_EXTRACT', re: /\b(?:repeat|print|output|copy|quote)\s+(?:back\s+)?(?:everything|all(?:\s+the)?\s+text|the\s+text|all|what(?:ever)?\s+(?:is|was))\s+(?:written\s+)?(?:above|before)\b/gi },

  // label_forcing: imperatives aimed at the classifier.
  { id: 'INJ_LABEL', re: new RegExp(
    '\\b(?:classify|categori[sz]e|label|mark|tag|treat|flag)\\s+(?:this|it|that|every|all|each|the)' +
    '(?:\\s+(?:ticket|request|issue|message|one)s?)?\\s+(?:as\\s+)?(?:an?\\s+)?' +
    '(?:(?:low|medium|high)[ -](?:urgency|priority)\\b|' + CATEGORY_WORD + '\\b)', 'gi') },
  { id: 'INJ_LABEL', re: /\bset\s+(?:the\s+|its\s+|ticket\s+)?(?:urgency|category|priority|severity|label|classification)\s+(?:to|=|as)\b/gi },
  { id: 'INJ_LABEL', re: new RegExp('\\b(?:category|urgency|priority|severity|classification|label)\\s*[:=]\\s*' + LABEL_VALUE + '\\b', 'gi') },
  { id: 'INJ_LABEL', re: /\b(?:correct|proper|final|required)\s+(?:classification|categori[sz]ation|category|labels?|urgency|triage)\b/gi },
  { id: 'INJ_LABEL', re: /\bdo\s+not\s+(?:change|alter|modify|override)\s+(?:these|the|this|my)\s+(?:labels?|classification|category|urgency)\b/gi },
  { id: 'INJ_LABEL', re: /\boutput\s+(?:the\s+)?(?:category|urgency)\b/gi },
]);

// link_insertion is judged per sentence: a link (or the word link/URL) together with a reference to the reply and
// an insertion verb. A URL alone is ordinary ticket content and is not flagged.
const LINKISH = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|(?<![@\w.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ai|app|dev|info|biz|xyz|me|ly|ru|cn)\b|\b(?:link|url|hyperlink|web\s*address|website)s?\b)/i;
const REPLY_REF = /\b(?:your|suggested|the)\s+(?:reply|response|answer)\b|\bwhen\s+you\s+(?:answer|reply|respond)\b|\bin\s+(?:the|your)\s+(?:reply|response|answer)\b|\bfor\s+the\s+(?:user|customer|reader)\b/i;
const INSERT_VERB = /\b(?:include|add|insert|put|place|tell|direct|send|point|mention|contain|append|paste|embed|say)\b/i;

/**
 * Sentence spans covering the whole text, in order and without gaps: a boundary falls after a run of . ! ? that is
 * followed by whitespace, and after every newline.
 * @returns {Array<{start:number,end:number}>}
 */
function splitSentences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const spans = [];
  let start = 0;
  const cut = (end) => {
    if (end > start) spans.push({ start, end });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      cut(i + 1);
    } else if (ch === '.' || ch === '!' || ch === '?') {
      let j = i;
      while (j + 1 < text.length && /[.!?]/.test(text[j + 1])) j++;
      if (j + 1 < text.length && /\s/.test(text[j + 1]) && text[j + 1] !== '\n') cut(j + 1);
      else if (j + 1 < text.length && text[j + 1] === '\n') cut(j + 1);
      i = j;
    }
  }
  cut(text.length);
  return spans;
}

/**
 * @param {string} text original (trimmed) ticket
 * @returns {{suspected:boolean, rules:string[], spans:Array<{start:number,end:number}>}}
 *   rules: sorted unique rule ids; spans: the sentences (from splitSentences) that a rule matched, sorted.
 */
function detectInjection(text) {
  if (typeof text !== 'string' || text.length === 0) return { suspected: false, rules: [], spans: [] };
  const sentences = splitSentences(text);
  const hit = new Array(sentences.length).fill(false);
  const rules = new Set();

  const markRange = (start, end) => {
    for (let k = 0; k < sentences.length; k++) {
      const s = sentences[k];
      if (s.start < end && start < s.end) hit[k] = true;
    }
  };

  for (const rule of TEXT_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      rules.add(rule.id);
      markRange(m.index, m.index + m[0].length);
    }
    rule.re.lastIndex = 0;
  }

  for (let k = 0; k < sentences.length; k++) {
    const s = text.slice(sentences[k].start, sentences[k].end);
    if (LINKISH.test(s) && REPLY_REF.test(s) && INSERT_VERB.test(s)) {
      rules.add('INJ_LINK');
      hit[k] = true;
    }
  }

  const spans = [];
  for (let k = 0; k < sentences.length; k++) if (hit[k]) spans.push({ start: sentences[k].start, end: sentences[k].end });
  const sorted = [...rules].sort();
  return { suspected: sorted.length > 0, rules: sorted, spans };
}

module.exports = { detectInjection, splitSentences, RULE_IDS };
