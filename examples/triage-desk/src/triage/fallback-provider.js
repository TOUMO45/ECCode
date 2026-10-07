'use strict';
// Deterministic fallback triage (spec C6.3, §AI/LLM Design "Timeouts, retries, fallback, cost", R6, NFR8).
// Pure and total for string input: no I/O, no clock, no randomness, never throws. The summary and reply are fixed
// templates chosen by (category, urgency); no ticket text is ever interpolated, so nothing from the ticket (a
// canary, a URL, a prompt marker) can reach the output. Every template passes validateTriage (V1-V4).
//
// Keyword lists were tuned only on `split: tune` rows of eval/dataset.json and measured only with
// `npm run eval:tune` (spec E5, DES-2). They are general support vocabulary, not phrases copied from rows.

const { CATEGORIES, URGENCIES } = require('./schema.js');

// Category keywords: [regex source (matched with word boundaries, case-insensitive), weight].
const CATEGORY_KEYWORDS = Object.freeze({
  billing: [
    ['charged?', 3], ['charges', 3], ['charging', 3], ['invoices?', 3], ['refunds?', 3], ['refunded', 3],
    ['payments?', 2], ['paid', 2], ['pay', 1], ['billing', 3], ['billed', 3], ['bills?', 2], ['pric(?:e|es|ing)', 2],
    ['subscriptions?', 2], ['subscribe', 2], ['discounts?', 2], ['receipts?', 2], ['vat', 2], ['tax', 2],
    ['renewal', 2], ['overdue', 2], ['currency', 2], ['fees?', 2], ['credit card', 2], ['card', 1],
    ['plans?', 1], ['overcharged', 3], ['chargebacks?', 3], ['quotes?', 1], ['billing cycle', 3], ['bank', 1], ['annual(?:ly)?', 1], ['monthly', 1], ['upgrad(?:e|ing)', 1], ['downgrad(?:e|ed)', 1], ['cost', 1],
  ],
  account: [
    ['log ?in', 3], ['logged in', 1], ['sign(?:ed)? ?in', 3], ['sign-in', 3], ['passwords?', 3], ['2fa', 3],
    ['two-factor', 3], ['authenticator', 3], ['sso', 3], ['locked out', 3], ['profile', 2], ['accounts?', 1],
    ['email address', 2], ['username', 3], ['display name', 3], ['permissions?', 3], ['roles?', 2], ['access', 2],
    ['admin', 1], ['ownership', 3], ['hacked', 3], ['recovery', 2], ['verification', 2], ['invit(?:e|ing)', 1],
    ['deactivate', 3], ['deactivated', 3], ['suspended', 2], ['mfa', 3], ['reset', 1], ['lockout', 3], ['sessions?', 1], ['close my', 2], ['seats?', 1], ['users?', 1],
  ],
  technical: [
    ['errors?', 3], ['bugs?', 3], ['crash(?:es|ed|ing)?', 3], ['down', 2], ['outage', 3], ['5\\d\\d', 2],
    ['time[sd]? out', 3], ['timeout', 3], ['slow', 2], ['fails?', 2], ['failed', 2], ['failing', 2], ['broken', 3],
    ['not working', 3], ['stopped', 2], ['sync', 2], ['api', 2], ['webhooks?', 3], ['integration', 1],
    ['upload(?:s|ing)?', 2], ['export', 1], ['loads?', 1], ['render(?:s|ing)?', 2], ['notifications?', 2],
    ['app', 1], ['mobile', 1], ['android', 2], ['ios', 2], ['browser', 2], ['chrome', 2], ['firefox', 2],
    ['dashboard', 1], ['page', 1], ['button', 2], ['tooltip', 2], ['overlaps?', 2], ['misaligned', 2],
    ['contrast', 1], ['date picker', 2], ['search', 1], ['disappeared', 3], ['records', 1], ['security', 2], ['freez(?:e|es|ing)', 3], ['hang(?:s|ing)?', 2], ['glitch(?:es)?', 3],
    ['unresponsive', 3], ['latency', 2], ['intermittent(?:ly)?', 2], ['performance', 2], ['server', 1],
    ['does nothing', 3], ["doesn'?t work", 3], ['retried', 2], ['lagging', 2], ['data', 1],
  ],
  feature_request: [
    ['would be (?:great|nice|helpful|useful)', 4], ['would love', 3], ['could you add', 4], ['please add', 4],
    ['can you add', 4], ['add (?:a|an|support|the ability)', 2], ['suggestions?', 3], ['feature', 2],
    ['option to', 2], ['an option', 2], ['ability to', 3], ['wish', 2], ['roadmap', 3], ['support for', 3],
    ['integration with', 2], ['make it possible', 4], ['a way to', 3], ['let us', 2], ['we would like (?:a|an|to have)', 2],
    ['request', 1], ['feature request', 3], ['enhancement', 3], ['would it be possible', 3], ['it would help', 3],
  ],
  other: [
    ['journalist', 4], ['interview', 4], ['jobs?', 3], ['openings', 3], ['careers?', 3], ['thanks? to', 3],
    ['expo', 4], ['conference', 3], ['partnerships?', 3], ['partner', 2], ['reseller', 4], ['agreement', 3],
    ['phishing', 4], ['soc ?2', 4], ['auditors?', 3], ['questionnaire', 4], ['vendor', 2], ['mailing address', 4],
    ['head office', 4], ['case stud(?:y|ies)', 4], ['press', 3], ['sponsor(?:ship)?', 3], ['meetups?', 3],
    ['office', 1], ['brand', 2], ['webinars?', 3], ['events?', 1], ['trade show', 4], ['donations?', 3], ['feedback', 1],
  ],
});

// Urgency cues (word-boundary, case-insensitive).
const HIGH_CUES = [
  'outage', 'down', 'is down', '5\\d\\d', "can'?t log ?in", 'cannot log ?in', 'unable to log ?in', 'locked out',
  'charged (?:us |me )?twice', 'paid twice', 'double charged', 'repeated charges?', 'incorrect charge',
  'charged [^.]{0,40}again', 'data loss', 'disappeared', 'security', 'hacked', 'phishing', 'urgent(?:ly)?',
  'right away', 'asap', 'nothing loads', 'entire team', 'everyone', 'all users', 'cannot (?:place|complete) orders?',
  'duplicate charges?', 'overcharged', 'breach', 'compromised', 'unauthori[sz]ed', 'critical', 'production',
  "can'?t access", 'cannot access', 'wasn\'?t me',
];
const MEDIUM_CUES = [
  "can'?t", 'cannot', 'unable', "won'?t", "doesn'?t", "don'?t", 'fails?', 'failed', 'failing', 'stopped',
  'times? out', 'timeout', 'error', 'blocks?', 'blocked', 'blocking', 'holding up', 'stuck', 'lagging', 'rejects?',
  'disabled', 'greyed out', 'missing', 'broken', 'not working', 'wrong', 'stalls?', 'by friday', 'this week',
  'retried', 'until', 'overdue', 'lost',
];
const LOW_CUES = ['not urgent', 'no rush', 'minor', 'cosmetic', 'small thing', 'when you get a chance', 'just looks'];

function compile(src) {
  return new RegExp('(?<![\\w-])(?:' + src + ')(?![\\w-])', 'gi');
}
const CATEGORY_MATCHERS = Object.freeze(Object.fromEntries(
  Object.entries(CATEGORY_KEYWORDS).map(([cat, list]) => [cat, list.map(([src, w]) => [compile(src), w])])));
const HIGH_RE = compile(HIGH_CUES.join('|'));
const MEDIUM_RE = compile(MEDIUM_CUES.join('|'));
const LOW_RE = compile(LOW_CUES.join('|'));

// Tie-break order (spec): billing > account > technical > feature_request > other.
const TIE_ORDER = Object.freeze(['billing', 'account', 'technical', 'feature_request', 'other']);

const URGENCY_PHRASE = Object.freeze({ low: 'a low-urgency', medium: 'a medium-urgency', high: 'a high-urgency' });
const CATEGORY_PHRASE = Object.freeze({
  billing: 'billing or payment issue',
  technical: 'technical problem',
  account: 'account or access issue',
  feature_request: 'feature request',
  other: 'general enquiry',
});

const REPLY_OPENING = Object.freeze({
  billing: 'Thank you for contacting us about your billing question. We are sorry for any trouble this has caused.',
  technical: 'Thank you for reporting this technical problem. We are sorry for the disruption it is causing.',
  account: 'Thank you for contacting us about your account. We understand how important it is to have working access.',
  feature_request: 'Thank you for taking the time to share this suggestion with us.',
  other: 'Thank you for getting in touch with us.',
});
const REPLY_DETAILS = Object.freeze({
  billing: 'To help us look into it, could you tell us the invoice or order reference, the date and amount involved, and the payment method used? Please do not send full card numbers.',
  technical: 'To help us investigate, could you tell us when the problem started, the steps that lead to it, any error message you see, and the browser, app or device you are using?',
  account: 'To help us, could you confirm the name of the workspace and describe what happens when you try to access it? For your security, please never share your password with anyone, including our team.',
  feature_request: 'Could you tell us a little more about how you would use it and how it would help your team? This helps our product team understand the need.',
  other: 'Could you share a few more details about what you need so we can pass your message to the right team?',
});
const REPLY_URGENCY = Object.freeze({
  high: 'We have marked your request as high priority and a member of our support team will follow up as soon as possible.',
  medium: 'A member of our support team will review your request and follow up with you.',
  low: 'A member of our team will get back to you.',
});

/** The fixed Triage object for a (category, urgency) pair. Pure; exported for the unit test of all 15 templates. */
function templateFor(category, urgency) {
  const c = CATEGORIES.includes(category) ? category : 'other';
  const u = URGENCIES.includes(urgency) ? urgency : 'medium';
  return {
    category: c,
    urgency: u,
    summary: `Customer reports ${URGENCY_PHRASE[u]} ${CATEGORY_PHRASE[c]}.`,
    suggestedReply: `${REPLY_OPENING[c]} ${REPLY_DETAILS[c]} ${REPLY_URGENCY[u]}`,
  };
}

/** Removes the detection spans (sentences the detector matched); malformed spans are ignored. */
function scoringText(ticket, detection) {
  const spans = detection !== null && typeof detection === 'object' && Array.isArray(detection.spans) ? detection.spans : [];
  const drop = new Uint8Array(ticket.length);
  for (const s of spans) {
    if (s === null || typeof s !== 'object') continue;
    const start = Math.max(0, Math.min(ticket.length, Number.isFinite(s.start) ? Math.floor(s.start) : 0));
    const end = Math.max(start, Math.min(ticket.length, Number.isFinite(s.end) ? Math.floor(s.end) : start));
    drop.fill(1, start, end);
  }
  let out = '';
  for (let i = 0; i < ticket.length; i++) out += drop[i] ? ' ' : ticket[i];
  return out.toLowerCase().replace(/[‘’]/g, "'");
}

function countMatches(re, text) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  re.lastIndex = 0;
  return n;
}

function classify(text) {
  let best = 'other';
  let bestScore = 0;
  for (const cat of TIE_ORDER) {
    let score = 0;
    for (const [re, w] of CATEGORY_MATCHERS[cat]) score += countMatches(re, text) * w;
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
}

function urgencyOf(text) {
  if (countMatches(HIGH_RE, text) > 0) return 'high';
  if (countMatches(LOW_RE, text) > 0) return 'low';
  if (countMatches(MEDIUM_RE, text) > 0) return 'medium';
  return 'low';
}

/**
 * @param {string} ticket original trimmed ticket
 * @param {{spans:Array<{start:number,end:number}>}} detection detector result; its sentences are dropped first
 * @returns {{category:string, urgency:string, summary:string, suggestedReply:string}} always passes validateTriage
 */
function fallbackAnalyse(ticket, detection) {
  const text = scoringText(typeof ticket === 'string' ? ticket : '', detection);
  if (!/\p{L}/u.test(text)) return templateFor('other', 'medium');
  return templateFor(classify(text), urgencyOf(text));
}

module.exports = { fallbackAnalyse, templateFor };
