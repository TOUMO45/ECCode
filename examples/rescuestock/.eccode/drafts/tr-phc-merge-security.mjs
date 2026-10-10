// technical-reviewer helper: folds the security review (phase-c-security-1.md, SEC-C-1..7) into
// .eccode/reviews/drafts/phase-c-1.json. Merges TR-C-5 into SEC-C-2 and TR-C-1 into SEC-C-3, moves the expiry half of
// TR-C-8 into SEC-C-1, adds SEC-C-4..7 as info, and updates the summary and the notes that named the old ids.
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/reviews/drafts/phase-c-1.json';
const review = JSON.parse(readFileSync(file, 'utf8'));

const oldTail = review.summary.slice(review.summary.indexOf('\n\nDecision: approve.'));
if (!oldTail.startsWith('\n\nDecision: approve.')) throw new Error('summary tail not found');
review.summary = review.summary.slice(0, review.summary.length - oldTail.length) +
  "\n- Security review folded in (phase-c-security-1.md: no blocking or major; ev:ev-mv2z05jg-016641ca, ev:ev-mv2yb2r4-016452c4). I re-ran its hoarding reproduction (ev:ev-mv2z9jtb-01c883bb). I also showed the bound myself (ev:ev-mv2z9kns-01a0430f): the hold survives the TTL because nothing calls the expiry pass yet, and one pass releases it with expire rows, after which cafe1 plans A+B again. I confirmed SEC-C-4's URL acceptance (ev:ev-mv2z9kvi-01c52506).\n\n" +
  "Decision: approve. Every open item is minor or info, and each has an owner and a resolution condition.\n" +
  "Severities, my own judgement:\n" +
  "- SEC-C-1 is minor. RS-FIX-1 has one bundle per supplier, so even a legitimate canonical reservation takes two of the five. The design accepted 30-minute holds under a count cap. Once e4 runs the pass, the hold is bounded by the TTL, as I demonstrated.\n" +
  "- SEC-C-2 (merged with my TR-C-5) and SEC-C-3 (merged with my TR-C-1) are minor. Neither is an acceptance criterion of any phase-C task, and the general limit was never assigned in the approved plan, which my own plan review missed. Both go to the FU-15 rework before phase E.\n" +
  "- FU-8's environment names (TR-C-2) go to the FU-14 rework before phase D.\n" +
  "For SEC-B-1R (phase B), FU-1 (typed 422 planner_limit) and FU-8's route limit are now delivered and tested; only FU-14's environment names remain.";

for (const c of review.criteria) {
  if (c.notes) c.notes = c.notes.replace('IPv6 full-address keys: TR-C-5.', 'IPv6 full-address keys: SEC-C-2 (I ask for the /64 key, with the security reviewer).');
  if (c.id === 'task:c3-reservations-supplier-admin') {
    c.evidence.push('ev:ev-mv2z9kns-01a0430f');
    c.notes += ' The cap counts reservations, not stock (SEC-C-1). That is the design\'s SEC-2 as written, and is bounded by the TTL once e4 runs the pass.';
  }
  if (c.id === 'task:c5-frontend-dashboards') {
    c.evidence.push('ev:ev-mv2z9kvi-01c52506');
    c.notes += ' The URL guard lets /\\host and /<TAB>/host through to another host (SEC-C-4, info: no such value is rendered today).';
  }
  if (c.id === 'phase:c-core-flow') c.evidence.push('ev:ev-mv2z05jg-016641ca', 'ev:ev-mv2z9jtb-01c883bb');
}

const keep = review.findings.filter((f) => !['TR-C-1', 'TR-C-5', 'TR-C-8'].includes(f.id));
const sec = [
  { id: 'SEC-C-1', severity: 'minor', title: 'One reservation can hold every compatible bundle (the SEC-2 cap counts reservations, not stock), and nothing runs the expiry pass in a live server until e4',
    detail: 'Security\'s reproduction, which I re-ran (ev:ev-mv2z9jtb-01c883bb):\n- One self-registered customer asks for 500+500 with maxPickups 5 and a large budget.\n- The approved plan uses A, B, D and E (C\'s lids are 95 mm), and its single reservation holds all of them, within the cap of 1.\n- cafe1\'s canonical request then has no feasible plan.\n- 35 minutes later the hold is still active, because src/ calls expireDueReservations nowhere (reservations.js#L271; the reconciler is e4).\nMy bound probe (ev:ev-mv2z9kns-01a0430f): one call of the pass expires the reservation, writes 4 expire rows, brings reserved back to 0, and cafe1 plans A+B for 8400 again.\nI judge this minor:\n- RS-FIX-1 has one bundle per supplier, so any reservation takes a large share of the stock.\n- The design accepted 30-minute holds under a count cap.\n- Once e4 runs the pass every tick, the impact is bounded by the TTL.\nThis finding also carries the expiry half of my earlier TR-C-8.',
    evidence: ['ev:ev-mv2z1ypi-01dceb2e', 'ev:ev-mv2z9jtb-01c883bb', 'ev:ev-mv2z9kns-01a0430f', 'artifact:src/services/reservations.js#L127-L131', 'artifact:src/services/reservations.js#L271-L283'],
    recommendation: 'Owners:\n- e4-saga-reconciler (required);\n- the orchestrator with the user (the product decision recorded in RISK-20, owner backend-engineer).\nResolved when:\n- in phase E, a test with a running server process shows a reservation past its TTL expiring with no direct call, through the reconciler tick that main.js starts;\n- AND the decision on a per-reservation cap (bundles per supplier, or a share of on_hand inside the reserve transaction), or a shorter TTL before the first PayPal approval, is recorded either way in RISK-20.' },
  { id: 'SEC-C-2', severity: 'minor', title: 'Throttle keys use the full IPv6 address, so one /64 gives unlimited fresh pair and per-IP budgets (merged with TR-C-5)',
    detail: 'normalizeIp returns the whole lower-cased IPv6 address, and throttle.js keys on it.\n- Security\'s probe: 8 failures from 8 addresses of one /64 never hit a limit, and the correct password then gives 200 (ev:ev-mv2z05jg-016641ca S3).\n- Mine: 6 failures from 6 addresses of 2001:db8:1:1::/64, all 401 (ev:ev-mv2ys7g8-01cffb10).\nPer-IP signin_ip and register_ip become per-address for IPv6 clients. The per-username cross-IP delay sleeps per request, so concurrency dilutes it. Seeded accounts (96-bit passwords) and the admin (16+ characters, scrypt) are not at practical risk. Self-registered customers (10-character minimum) are bounded only by scrypt CPU. The default deployment is localhost.',
    evidence: ['ev:ev-mv2z05jg-016641ca', 'ev:ev-mv2ys7g8-01cffb10', 'artifact:src/auth/client-ip.js#L14-L36', 'artifact:src/auth/throttle.js#L42-L63'],
    recommendation: 'Owner: the orchestrator, folded into the FU-15 rework (backend-engineer, src/auth/**). Resolved when IPv6 addresses are mapped to their /64 for the sign-in and register throttle keys (IPv4 and ::ffff: unchanged), and a named test shows 5 failures spread over 5 addresses of one /64 making the 6th attempt get 429. This must land before phase E is dispatched.' },
  { id: 'SEC-C-3', severity: 'minor', title: 'The general per-user limit (300 requests/min) is absent and was never assigned in the approved plan, and an unchanged confirm still writes a new requirements version (merged with TR-C-1)',
    detail: 'Spec Security > Rate limiting and Conventions > Limits require the general limit; no plan task owns it (FU-15; my plan review missed the gap). Security measured 300 confirms in one minute writing 300 requirements versions and 300 audit rows, none limited, and 600 RequestView reads unthrottled (ev:ev-mv2z05jg-016641ca S9). confirmRequirements inserts a version even when the values equal the latest one; sameRequirements gates only supersession (requests.js#L215-L236). The expensive call (planning) has its own limit (FU-8), and the specific limits hold.',
    evidence: ['ev:ev-mv2z05jg-016641ca', 'ev:ev-mv2ybl0f-013c354c', 'artifact:src/services/requests.js#L215-L236', 'artifact:.eccode/artifacts/plan/followups.md#added-after-phase-c-delivery-lead-2026-10-10'],
    recommendation: 'Owner: the orchestrator (the FU-15 rework, backend-engineer; it must also own src/services/requests.js for point 2). Resolved when, before phase E is dispatched:\n1. The access hook counts every signed-in call per user in rate_events (kind general, key u:<id>, check and insert in one BEGIN IMMEDIATE), answers 429 RATE_LIMITED with details.limit general and Retry-After, and never counts plan:u:<id> keys. A named test shows the 301st call in a minute refused, and NFR5 p95 stays under 300 ms.\n2. A confirm whose values equal the latest version returns that version without inserting a row.\nThis may be merged with FU-14.' },
  { id: 'SEC-C-4', severity: 'info', title: 'dom.js isAllowedUrl accepts /\\host and /<TAB>/host, which browsers resolve to another host',
    detail: 'Confirmed: setAttr accepts "/\\evil.example/x", "/\\t/evil.example/x" and "/\\n/evil.example/x", which WHATWG URL resolves to evil.example; "//evil.example/x" is refused (ev:ev-mv2z9kvi-01c52506, ev:ev-mv2z05jg-016641ca S11). There is no exposure today: every href in public/** is a constant or a numeric hash route. Any absolute https URL is accepted by design anyway.',
    evidence: ['ev:ev-mv2z9kvi-01c52506', 'artifact:public/js/dom.js#L22-L27'],
    recommendation: 'Owner: the first of d4-frontend-extraction or e5-frontend-payments to touch dom.js, and in any case before e5 renders a server-supplied URL. Resolved when values containing a backslash, whitespace or a C0 control are refused (or are resolved with new URL and required to be same-origin unless absolute http(s) is intended), with a unit test.' },
  { id: 'SEC-C-5', severity: 'info', title: 'Proxy trust is all-or-nothing and set by the operator',
    detail: 'Behind a proxy with RS_TRUST_PROXY=0, every client shares the proxy address, so 20 failures lock everyone out for 15 minutes (signin_ip). Without a proxy and with RS_TRUST_PROXY=1, clients choose their own key. README line 84 tells proxied deployments to set the flag (ev:ev-mv2z05jg-016641ca S3).',
    evidence: ['ev:ev-mv2z05jg-016641ca', 'artifact:src/auth/client-ip.js#L29-L36'],
    recommendation: 'Owner: e1-payment-adapters (config) or g2 (docs). Resolved when a startup warning is logged for https RS_PUBLIC_URL with RS_TRUST_PROXY=0 and the README states both failure modes, or the owner records why not.' },
  { id: 'SEC-C-6', severity: 'info', title: 'The webhook route reaches its handler with no session and no CSRF; e3 must verify the signature before any write and apply 60/min per IP',
    detail: 'The signature policy works as the routing contract says (ev:ev-mv2z05jg-016641ca S5; my RBAC probe ev:ev-mv2yqv56-01c827cf shows any other signature route refused).',
    evidence: ['ev:ev-mv2z05jg-016641ca', 'ev:ev-mv2yqv56-01c827cf', 'artifact:src/auth/rbac.js#L47-L52'],
    recommendation: 'Owner: e3-webhooks; the phase-E reviewers re-check it. Resolved when e3\'s tests show the cheap pre-checks, signature verification before any write, and 60 requests per IP per minute (429, no row written).' },
  { id: 'SEC-C-7', severity: 'info', title: 'Phase-B carry-overs: SEC-B-2 and SEC-B-4 remain remediated; SEC-B-7 (scrypt N = 2^14) unchanged, as accepted',
    detail: 'recursive_triggers is ON and the server timeouts and maxConnections are in place (code reading by security; I verified both by probe in phase B, rev-mv1k04zq-01814d87).',
    evidence: ['ev:ev-mv2z05jg-016641ca'],
    recommendation: 'Owner: none. No action. SEC-B-7 stays an accepted demo setting.' },
];
const tr8 = { id: 'TR-C-8', severity: 'info', title: 'Nothing drains the re-plan queue yet (by plan: e4 wires the call, f1 builds the drain)',
  detail: 'After a supplier refusal the request reads "replanning" (row 4a, nextStep WAIT), and the page offers no Plan button until a drain stores a new run. A requirements change self-heals, because the UI plans right after confirm. The expiry half of this item moved to SEC-C-1.',
  evidence: ['ev:ev-mv2ypyue-019d3b1a', 'artifact:src/services/supersession.js#L27-L32'],
  recommendation: 'Owner: e4-saga-reconciler (drain calls) and f1-supersession-refusal-expiry (the drain). Resolved when phase-F tests show a refused request reaching a new proposed version without a customer action.' };
const order = ['SEC-C-1', 'SEC-C-2', 'SEC-C-3', 'TR-C-2', 'TR-C-3', 'TR-C-4', 'TR-C-6', 'TR-C-7', 'TR-C-8', 'SEC-C-4', 'SEC-C-5', 'SEC-C-6', 'SEC-C-7'];
const all = new Map([...keep, ...sec, tr8].map((f) => [f.id, f]));
review.findings = order.map((id) => { const f = all.get(id); if (!f) throw new Error('missing ' + id); return f; });
if (all.size !== order.length) throw new Error('unexpected finding ids: ' + [...all.keys()].join(','));
writeFileSync(file, JSON.stringify(review, null, 2) + '\n');
console.log('findings: ' + review.findings.map((f) => `${f.id}(${f.severity})`).join(', '));
