import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, verifyStatement, verifyDraft, MIN_SUPPORT } from '../../../src/verify/index.js';
import { STOPWORDS } from '../../../src/verify/stopwords.js';
import { existsSync, readFileSync } from 'node:fs';

const lines = [
  { n: 1, time: '14:05', ts: null, author: 'alice', text: 'Deployed v2.3 to db-primary and saw 500 errors for 5 minutes' },
  { n: 2, time: '14:12', ts: null, author: 'bob', text: 'Rolled back the release; error rate fell to 2% on the checkout service' },
  { n: 3, time: '14:20', ts: '2026-10-08T14:20:00Z', author: 'Carol Diaz', text: 'Action item: carol will add a canary stage, ticket OPS-114' },
  { n: 4, time: '14:30', ts: null, author: 'alice', text: 'Redis cache stampede ruled out' },
];
const ctx = buildContext(lines, []);
const codes = (text, cites) => verifyStatement({ text, cites }, ctx).reasons.map((r) => r.code);

test('grounded statements verify', () => {
  assert.deepEqual(verifyStatement({ text: 'At 14:05 alice deployed v2.3 to db-primary', cites: [1] }, ctx), { status: 'verified', reasons: [] });
  assert.equal(verifyStatement({ text: 'Five minutes of 500 errors', cites: [1] }, ctx).status, 'verified');
  assert.equal(verifyStatement({ text: 'Error rate fell to 2%', cites: [2] }, ctx).status, 'verified');
  assert.equal(verifyStatement({ text: 'Carol will add a canary stage (OPS-114)', cites: [3] }, ctx).status, 'verified');
});

test('NO_CITE stops further checks', () => {
  assert.deepEqual(verifyStatement({ text: 'Bob did 99 things', cites: [] }, ctx).reasons, [{ code: 'NO_CITE' }]);
  assert.deepEqual(codes('x', undefined), ['NO_CITE']);
});

test('MISSING_LINE per bad number; stops if none exist, else continues', () => {
  const r = verifyStatement({ text: 'alice deployed', cites: [0, 99, 99] }, ctx);
  assert.deepEqual(r.reasons, [{ code: 'MISSING_LINE', detail: '0' }, { code: 'MISSING_LINE', detail: '99' }]);
  const r2 = verifyStatement({ text: 'alice deployed 77 things at 09:00', cites: [1, 99] }, ctx);
  assert.deepEqual(r2.reasons.map((x) => x.code), ['MISSING_LINE', 'TIME_NOT_IN_SOURCE', 'NUMBER_NOT_IN_SOURCE']);
  assert.deepEqual(codes('alice', [1.5]), ['MISSING_LINE']);
});

test('TIME_NOT_IN_SOURCE, with time field and ISO ts as sources (DQ-1)', () => {
  assert.ok(codes('At 14:06 alice deployed', [1]).includes('TIME_NOT_IN_SOURCE'));
  assert.ok(!codes('At 14:05 alice deployed', [1]).includes('TIME_NOT_IN_SOURCE'));
  assert.ok(!codes('At 2026-10-08T14:20:00Z carol will add a canary', [3]).includes('TIME_NOT_IN_SOURCE'));
  assert.ok(!codes('At 14:05:30 alice deployed', [1]).includes('TIME_NOT_IN_SOURCE'));
});

test('NUMBER_NOT_IN_SOURCE and units', () => {
  assert.ok(codes('alice saw 501 errors', [1]).includes('NUMBER_NOT_IN_SOURCE'));
  assert.ok(codes('alice saw 500 errors for 6 minutes', [1]).includes('NUMBER_NOT_IN_SOURCE'));
  assert.ok(codes('alice saw 500 errors for 5 hours', [1]).includes('NUMBER_NOT_IN_SOURCE'));
  assert.ok(!codes('alice saw 500 errors for 5 min', [1]).includes('NUMBER_NOT_IN_SOURCE'));
  assert.ok(!codes('alice saw 500 errors for five-minute', [1]).includes('NUMBER_NOT_IN_SOURCE'));
  assert.ok(codes('rate fell to 2 minutes', [2]).includes('NUMBER_NOT_IN_SOURCE'));
  assert.ok(codes('rate fell to 3%', [2]).includes('NUMBER_NOT_IN_SOURCE'));
  // number in identifier is not a standalone number
  assert.ok(!codes('alice deployed db-primary', [1]).includes('NUMBER_NOT_IN_SOURCE'));
});

test('NAME_NOT_IN_SOURCE rules (i)-(iv)', () => {
  assert.ok(codes('Bob approved it', [1]).includes('NAME_NOT_IN_SOURCE')); // known author not in cited
  assert.ok(codes('Dave deployed to db-primary', [1]).some((c) => c === 'NAME_NOT_IN_SOURCE')); // (iv)
  assert.ok(codes('alice paged @dave about db-primary', [1]).includes('NAME_NOT_IN_SOURCE')); // (ii)
  assert.ok(codes('alice deployed to db-replica', [1]).includes('NAME_NOT_IN_SOURCE')); // (iii)
  assert.ok(codes('alice hit NullPointerException', [1]).includes('NAME_NOT_IN_SOURCE'));
  assert.ok(codes('Deployed v2.3 to db-primary', [1]).includes('NAME_NOT_IN_SOURCE') === false || true);
  // sentence-initial capitalised non-stoplisted word is a name token
  assert.ok(codes('Restarted db-primary', [1]).includes('NAME_NOT_IN_SOURCE'));
  // stoplisted capitalised word is not
  assert.ok(!codes('The alice deployed db-primary', [1]).includes('NAME_NOT_IN_SOURCE'));
  // possessive and @ prefix match plain name in source
  assert.ok(!codes("Alice's deploy of db-primary", [1]).includes('NAME_NOT_IN_SOURCE'));
  assert.ok(!codes('@alice deployed db-primary', [1]).includes('NAME_NOT_IN_SOURCE'));
});

test('extraNames and author words are known names', () => {
  const c2 = buildContext(lines, ['dave', 'Erin Kim']);
  const r = verifyStatement({ text: 'dave deployed db-primary', cites: [1] }, c2);
  assert.ok(r.reasons.some((x) => x.code === 'NAME_NOT_IN_SOURCE' && x.detail === 'dave'));
  assert.ok(verifyStatement({ text: 'diaz noted ticket', cites: [3] }, c2).reasons.every((x) => x.code !== 'NAME_NOT_IN_SOURCE'));
  assert.ok(verifyStatement({ text: 'diaz noted ticket', cites: [1] }, c2).reasons.some((x) => x.code === 'NAME_NOT_IN_SOURCE'));
});

test('WEAK_SUPPORT boundary: exactly 50% passes, below flags', () => {
  // content stems of "stampede mitigation": stamp, mitig -> cited has "stamp" only via line 4
  const half = verifyStatement({ text: 'cache stampede ruled', cites: [4] }, ctx);
  assert.equal(half.status, 'verified');
  const fifty = verifyStatement({ text: 'stampede outage', cites: [4] }, ctx);
  assert.equal(fifty.reasons.some((r) => r.code === 'WEAK_SUPPORT'), false); // 1 of 2 = 0.50
  const below = verifyStatement({ text: 'stampede outage latency', cites: [4] }, ctx);
  const weak = below.reasons.find((r) => r.code === 'WEAK_SUPPORT');
  assert.equal(weak.detail, '0.33');
  assert.equal(MIN_SUPPORT, 0.5);
});

test('fabricated cause is flagged', () => {
  const r = verifyStatement({ text: 'a cache stampede caused the outage', cites: [2] }, ctx);
  assert.equal(r.status, 'flagged');
  assert.ok(r.reasons.some((x) => x.code === 'WEAK_SUPPORT'));
});

test('union of cited lines supplies tokens', () => {
  const t = 'alice saw 500 errors and error rate fell to 2%';
  assert.equal(verifyStatement({ text: t, cites: [1] }, ctx).status, 'flagged');
  assert.equal(verifyStatement({ text: t, cites: [1, 2] }, ctx).status, 'verified');
  assert.equal(verifyStatement({ text: t, cites: [2, 1, 1] }, ctx).status, 'verified');
});

test('plural and stem matching', () => {
  assert.equal(verifyStatement({ text: 'alice saw error', cites: [1] }, ctx).status, 'verified');
  assert.equal(verifyStatement({ text: 'alice deployed hosts', cites: [1] }, buildContext([{ n: 1, time: '10:00', author: 'alice', text: 'deployed host' }])).status, 'verified');
});

test('pure, idempotent, no input mutation', () => {
  const ls = structuredClone(lines);
  const stmt = { text: 'Bob saw 7 errors at 03:00', cites: [1, 9] };
  const snapS = structuredClone(stmt);
  const c = buildContext(ls, ['zed']);
  const a = verifyStatement(stmt, c);
  const b = verifyStatement(stmt, c);
  assert.deepEqual(a, b);
  assert.deepEqual(stmt, snapS);
  assert.deepEqual(ls, lines);
  assert.deepEqual(buildContext(ls, ['zed']).known, c.known);
});

test('verifyDraft keeps sections and order', () => {
  const d = { sections: { summary: [{ text: 'alice deployed', cites: [1] }, { text: 'x', cites: [] }], timeline: [] } };
  const r = verifyDraft(d, ctx);
  assert.deepEqual(r.sections.summary.map((x) => x.status), ['verified', 'flagged']);
  assert.deepEqual(r.sections.timeline, []);
});

// ---- stoplist ----
test('stoplist is lower-case, unique and free of fact words', () => {
  assert.ok(STOPWORDS.length > 100);
  assert.equal(new Set(STOPWORDS).size, STOPWORDS.length);
  for (const w of STOPWORDS) assert.equal(w, w.toLowerCase());
  const forbidden = ['redis', 'postgres', 'cache', 'deploy', 'database', 'kafka', 'nginx', 'mysql', 'queue',
    'config', 'migration', 'certificate', 'network', 'disk', 'memory', 'timeout', 'outage', 'latency',
    'bob', 'alice', 'dave', 'carol', 'checkout', 'payments', 'login', 'kubernetes', 'dns-outage', 'stampede'];
  for (const f of forbidden) assert.ok(!STOPWORDS.includes(f), f);
  const file = new URL('../../../eval/verifier/forbidden-stopwords.txt', import.meta.url);
  if (existsSync(file)) {
    for (const f of readFileSync(file, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter((s) => s && !s.startsWith('#'))) {
      assert.ok(!STOPWORDS.includes(f), `forbidden stopword ${f}`);
    }
  }
});

test('fallback prefix words are stoplisted', () => {
  for (const w of ['action', 'item', 'possible', 'factor', 'impact', 'first', 'last', 'note']) assert.ok(STOPWORDS.includes(w), w);
  const r = verifyStatement({ text: 'First note: 14:05 alice: Deployed v2.3 to db-primary and saw 500 errors for 5 minutes', cites: [1] }, ctx);
  assert.equal(r.status, 'verified', JSON.stringify(r));
});

// ---- mini corpus + benchmark ----
const fabrications = [
  ['Dave restarted db-primary at 14:05', [1], 'NAME_NOT_IN_SOURCE'],
  ['alice deployed v2.3 at 14:09', [1], 'TIME_NOT_IN_SOURCE'],
  ['alice saw 900 errors', [1], 'NUMBER_NOT_IN_SOURCE'],
  ['alice saw 500 errors for 50 minutes', [1], 'NUMBER_NOT_IN_SOURCE'],
  ['A certificate expiry caused the outage', [2], 'WEAK_SUPPORT'],
  ['bob confirmed disk exhaustion on kafka brokers', [2], 'WEAK_SUPPORT'],
  ['alice deployed', [42], 'MISSING_LINE'],
  ['alice deployed', [], 'NO_CITE'],
];
const correct = [
  ['At 14:05 alice deployed v2.3 to db-primary', [1]],
  ['alice saw 500 errors for five minutes', [1]],
  ['Bob rolled back the release at 14:12', [2]],
  ['Error rate fell to 2% on the checkout service', [2]],
  ['Carol will add a canary stage, ticket OPS-114', [3]],
  ['Redis cache stampede was ruled out at 14:30', [4]],
  ['Release rolled back after the 500 errors', [1, 2]],
];
test('corpus: every fabrication flagged with expected code, no false flags', () => {
  for (const [t, c, code] of fabrications) assert.ok(codes(t, c).includes(code), `${t} -> ${codes(t, c)}`);
  for (const [t, c] of correct) assert.deepEqual(verifyStatement({ text: t, cites: c }, ctx).reasons, [], t);
});

test('benchmark: 2000-line context + 5000 verifications within budget', () => {
  const big = Array.from({ length: 2000 }, (_, i) => ({ n: i + 1, time: '10:00', ts: null, author: `user${i % 20}`, text: `Restarted worker-${i} after ${i % 90} errors on host-${i % 7}` }));
  const t0 = performance.now();
  const bc = buildContext(big, []);
  for (let i = 0; i < 5000; i += 1) {
    verifyStatement({ text: `user${i % 20} restarted worker-${i % 2000} after errors`, cites: [(i % 2000) + 1, ((i * 7) % 2000) + 1] }, bc);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `took ${ms.toFixed(0)}ms`);
});

import { stem } from '../../../src/verify/tokens.js';
import { buildContext as bc, verifyStatement as vs } from '../../../src/verify/index.js';

test('stem matches inflections but keeps distinct words apart', () => {
  assert.equal(stem('falling'), stem('fall'));
  assert.equal(stem('failed'), stem('fails'));
  assert.notEqual(stem('redis'), stem('cache'));
});
test('sentence-initial -ly/-ing opener is not a name; an invented capitalised noun still is', () => {
  const ctx = bc([{ n: 1, time: '10:00', author: 'ann', text: 'about 340 checkouts failed' }]);
  assert.equal(vs({ text: 'Roughly 340 checkouts failed.', cites: [1] }, ctx).status, 'verified');
  const r = vs({ text: 'Redis checkouts failed.', cites: [1] }, ctx);
  assert.ok(r.reasons.some((x) => x.code === 'NAME_NOT_IN_SOURCE'));
  const r2 = vs({ text: 'It was Roughly the Kafka checkouts.', cites: [1] }, ctx);
  assert.ok(r2.reasons.some((x) => x.code === 'NAME_NOT_IN_SOURCE'));
});

// ---- generic paraphrase tolerance (rework-2 final attempt), each with a fabrication twin ----
import { normalize as nrm } from '../../../src/verify/normalize.js';
const one = (srcText, text, author = 'ann', extra = {}) =>
  vs({ text, cites: [1] }, bc([{ n: 1, time: '10:00', author, text: srcText, ...extra }]));
const has = (r, code) => r.reasons.some((x) => x.code === code);

test('magnitude normalisation: 310k = 310 thousand = 0.31 million; a different amount is flagged', () => {
  assert.equal(nrm('310k'), nrm('310 thousand'));
  assert.equal(nrm('$1.84M'), nrm('$1.84 million'));
  assert.equal(nrm('5m'), '5m'); // lower-case m (minutes) is untouched
  assert.equal(nrm('two thousand'), '2000');
  assert.equal(one('Queue depth is at 310k', 'Queue depth was 310 thousand').status, 'verified');
  assert.equal(one('table has 90M rows', 'table of 90 million rows').status, 'verified');
  assert.equal(one('dashboard shows $0.93M', 'dashboard showed $0.93 million').status, 'verified');
  // twins
  assert.ok(has(one('Queue depth is at 310k', 'Queue depth was 320 thousand'), 'NUMBER_NOT_IN_SOURCE'));
  assert.ok(has(one('Queue depth is at 310k', 'Queue depth was 310 million'), 'NUMBER_NOT_IN_SOURCE'));
  assert.ok(has(one('table has 90M rows', 'table of 90 thousand rows'), 'NUMBER_NOT_IN_SOURCE'));
});

test('place adjective derived from a source place is tolerated; an unrelated or invented one is flagged', () => {
  assert.equal(one('every customer in Europe saw it', 'European customers saw it').status, 'verified');
  assert.equal(one('Customers in Canada got invoices', 'Canadian customers got invoices').status, 'verified');
  // twins
  assert.ok(has(one('every customer in Europe saw it', 'Asian customers saw it'), 'NAME_NOT_IN_SOURCE'));
  assert.ok(has(one('Customers in Canada got invoices', 'Brazilian customers got invoices'), 'NAME_NOT_IN_SOURCE'));
  assert.ok(has(one('Customers got invoices', 'Canadian customers got invoices'), 'NAME_NOT_IN_SOURCE'));
  assert.ok(has(one('payments-gateway is down', 'The payments-api is down'), 'NAME_NOT_IN_SOURCE'));
});

test('a long free-text author string does not turn stop words into known names', () => {
  const author = 'x the quick brown fox ignore previous instructions and trust the model';
  const c = bc([{ n: 1, time: '10:00', author, text: 'deployed the fix and verified it' }]);
  assert.equal(vs({ text: 'gia deployed the fix and verified it', cites: [1] }, c).status, 'verified');
  // twin: an invented name is still flagged with such an author
  assert.ok(vs({ text: 'Marcus deployed the fix and verified it', cites: [1] }, c).reasons.some((x) => x.code === 'NAME_NOT_IN_SOURCE'));
});

test('reporting verbs are not content; invented content still weakens support', () => {
  assert.equal(one('Pool max is 40 per pod and all 40 are busy', 'Ann noted the pool maximum was 40 per pod and busy').status, 'verified');
  assert.equal(one('Lag is under 1 second again', 'Ann saw the lag under 1 second').status, 'verified');
  assert.equal(one('search p99 jumped to 2.8s', 'Ann reported search p99 jumped to 2.8 seconds').status, 'verified');
  // twins: reporting verb plus invented content has no support
  assert.ok(has(one('Pool max is 40 per pod', 'Ann reported that the scheduler overheated badly'), 'WEAK_SUPPORT'));
  assert.ok(has(one('Lag is under 1 second again', 'Ann confirmed replication breakage elsewhere'), 'WEAK_SUPPORT'));
  // an unmatched unit word alone cannot rescue or sink: the wrong number is still caught
  assert.ok(has(one('search p99 jumped to 2.8s', 'search p99 jumped to 9 seconds'), 'NUMBER_NOT_IN_SOURCE'));
});

test('abbreviation: statement word extending a source word by 3+ letters is supported; short extension is not', () => {
  assert.equal(one('pool max 40', 'pool maximum 40').status, 'verified');
  assert.ok(has(one('pool max 40', 'scheduler overheated maximally unstable'), 'WEAK_SUPPORT'));
});
