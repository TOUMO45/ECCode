// Security review probe (security-reviewer) of the RescueStock design spec.
// Usage: node sec-design-spec-walk.mjs <spec.md> --structural | --probes
//   --structural: every mutating route has an authentication rule (RBAC group), a CSRF rule and an
//                 idempotency rule; every error-catalog code is produced somewhere (by name, by its HTTP
//                 status in a route row, or by a named framework component); the only side-effecting GET
//                 routes are the PayPal return/cancel. Exit 0 = all hold.
//   --probes:     tests security hypotheses against the exact spec text. Prints CONFIRMED / REFUTED per
//                 hypothesis with the quoted text. Exit 1 if any gap is CONFIRMED (the expected outcome of a
//                 reproduction), 0 if every hypothesis is refuted.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [file, mode] = process.argv.slice(2);
if (!file || !['--structural', '--probes'].includes(mode)) {
  console.error('usage: node sec-design-spec-walk.mjs <spec.md> --structural|--probes');
  process.exit(2);
}
const raw = readFileSync(file);
const text = raw.toString('utf8');
const lines = text.split('\n');
console.log('spec', file, 'sha256', createHash('sha256').update(raw).digest('hex'), 'lines', lines.length);

const section = (start, endRe) => {
  const i = lines.findIndex((l) => l.startsWith(start));
  if (i < 0) return '';
  let j = i + 1;
  while (j < lines.length && !endRe.test(lines[j])) j++;
  return lines.slice(i, j).join('\n');
};
const quote = (re) => {
  const m = text.match(re);
  return m ? m[0].replace(/\s+/g, ' ').slice(0, 220) : null;
};

// ---- route rows ----------------------------------------------------------------------------------
const routeRe = /^\| `(GET|POST|PATCH|DELETE|PUT) (\/api\/[^`?\s]+)[^`]*` \|(.*)$/;
const routes = [];
lines.forEach((l, i) => {
  const m = l.match(routeRe);
  if (m) routes.push({ method: m[1], path: m[2], rest: m[3], line: i + 1 });
});
const webhookPath = '/api/webhooks/paypal/:merchantKey';
if (!routes.some((r) => r.path === webhookPath)) {
  // the webhook route is specified in prose under "### Webhooks", not in a table row
  const i = lines.findIndex((l) => l.startsWith('`POST ' + webhookPath + '`'));
  if (i >= 0) routes.push({ method: 'POST', path: webhookPath, rest: lines[i], line: i + 1 });
}

// ---- RBAC matrix groups --------------------------------------------------------------------------
const rbac = section('### RBAC matrix', /^### /);
const groups = [];
for (const l of rbac.split('\n')) {
  if (!l.startsWith('| `')) continue;
  const cells = l.split('|').map((c) => c.trim());
  const pats = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  groups.push({ pats, rule: cells.slice(2, 6).join(' / ') });
}
const groupFor = (p) => {
  for (const g of groups) {
    for (const pat of g.pats) {
      if (pat === p) return g;
      if (pat.endsWith('*')) {
        const base = pat.replace(/\*+$/, '');
        if (p.startsWith(base)) return g;
      }
    }
  }
  return null;
};

if (mode === '--structural') {
  let fail = 0;
  const conv = section('### Conventions', /^### /);
  const csrfRule = /every non-GET route requires the header `X-CSRF-Token`, except `POST \/api\/webhooks\/paypal\/:merchantKey`/.test(conv);
  const idemBlanket = /All other mutating routes are idempotent by state/.test(conv);
  console.log('\n[1] mutating routes: auth (RBAC group), CSRF, idempotency');
  const mut = routes.filter((r) => r.method !== 'GET');
  for (const r of mut) {
    const g = groupFor(r.path);
    const isWebhook = r.path === webhookPath;
    const csrf = isWebhook ? (/authenticated by signature only/.test(text) ? 'exempt: signature only' : null) : (csrfRule ? 'X-CSRF-Token' : null);
    let idem;
    if (/Idempotency-Key/.test(r.rest)) idem = 'Idempotency-Key (explicit)';
    else if (isWebhook) idem = /valid\*\* row with this transmission id exists/.test(text) ? 'transmission-id dedupe' : null;
    else if (/repeat|already|replay|unchanged/i.test(r.rest)) idem = 'state (explicit in row)';
    else idem = idemBlanket ? 'state (blanket convention only)' : null;
    const ok = g && csrf && idem;
    if (!ok) fail++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} L${r.line} ${r.method} ${r.path} | auth: ${g ? g.rule : 'NO RBAC GROUP'} | csrf: ${csrf} | idem: ${idem}`);
  }
  console.log(`mutating routes: ${mut.length}`);

  console.log('\n[2] every error-catalog code is produced somewhere');
  const cat = section('### Error catalog', /^### /);
  const codes = [...new Set([...cat.matchAll(/`([A-Z][A-Z_]+)`/g)].map((m) => m[1]))];
  const outside = text.replace(cat, '');
  const statusOf = {};
  for (const l of cat.split('\n')) {
    const m = l.match(/^\| (\d{3}) \| (.*)$/);
    if (m) for (const c of m[2].matchAll(/`([A-Z][A-Z_]+)`/g)) statusOf[c[1]] = m[1];
  }
  // framework-level producers named in Components (router, body parser)
  const framework = {
    INVALID_JSON: /body\.js\s+JSON body/,
    BAD_REQUEST: /router\.js\s+method \+ path-template routing/,
    METHOD_NOT_ALLOWED: /404\/405 envelopes/,
    NOT_FOUND: /404\/405 envelopes/,
  };
  const rowText = routes.map((r) => r.rest).join('\n');
  for (const c of codes) {
    const n = (outside.match(new RegExp('\\b' + c + '\\b', 'g')) || []).length;
    const st = statusOf[c];
    const byStatus = st ? (rowText.match(new RegExp('(^|[^0-9])' + st + '([^0-9]|$)', 'gm')) || []).length : 0;
    const byFramework = framework[c] ? framework[c].test(text) : false;
    const how = n > 0 ? `by name x${n}`
      : byStatus > 0 ? `by status ${st} in route rows x${byStatus} (code name not used)`
      : byFramework ? 'by framework component only (router/body.js)' : 'UNUSED';
    const ok = how !== 'UNUSED';
    if (!ok) fail++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${c}: ${how}`);
  }

  console.log('\n[3] GET routes with side effects');
  const gets = routes.filter((r) => r.method === 'GET');
  const sideEffect = /sets? `|moves|→ `?approved|queue|insert|delete/i;
  const sideGets = gets.filter((r) => r.path.startsWith('/api/paypal/'));
  for (const r of gets) console.log(`     L${r.line} GET ${r.path} ${r.path.startsWith('/api/paypal/') ? '(side-effecting by brief: return/cancel)' : ''}`);
  const others = gets.filter((r) => !r.path.startsWith('/api/paypal/') && sideEffect.test(r.rest));
  if (others.length) { fail++; console.log('FAIL other side-effecting GETs:', others.map((r) => r.path)); }
  else console.log(`OK   only ${sideGets.length} side-effecting GETs (PayPal return/cancel); owner check before any call stated: ${/customer is not the session user → 404/.test(text)}`);

  console.log(`\nstructural result: ${fail === 0 ? 'PASS' : 'FAIL'} (${fail} failures)`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---- probes -------------------------------------------------------------------------------------
const results = [];
const probe = (id, title, confirmed, evidence) => {
  results.push({ id, confirmed });
  console.log(`\n${confirmed ? 'CONFIRMED' : 'REFUTED  '} ${id}: ${title}`);
  for (const e of evidence) console.log('   ' + e);
};

// H1: idempotency scope ignores the plan id in the path, and the reserve body is always {}.
{
  const scope = quote(/Scope: \([^)]*\)/);
  const hash = quote(/Body hash: [^.]*\./);
  const reserveBody = quote(/`POST \/api\/plans\/:id\/reserve` \| header `Idempotency-Key`; body `\{\}`/);
  const scopeHasId = scope && /:id|plan|path/i.test(scope.replace('route template', ''));
  const hashHasId = hash && /:id|plan|path/i.test(hash);
  probe('H1', 'Idempotency key reused on ANOTHER plan replays the first plan\'s reservation (no 422)',
    Boolean(scope && reserveBody && !scopeHasId && !hashHasId),
    [`scope: ${scope}`, `hash: ${hash}`, `reserve row: ${reserveBody}`]);
}
// H2: per-username throttle refuses the correct password -> anonymous lockout of named accounts.
{
  const t = quote(/a sign-in is refused with 429 when the username has[^.]*\.[^.]*\./);
  const r = quote(/refused \*\*before\*\* the password is checked, so the correct password is also refused/);
  const seeded = quote(/one supplier user per supplier \(`supplier-a` … `supplier-e`\) and two customers \(`cafe1`, `cafe2`\)/);
  const admin = quote(/The admin account `admin` is created/);
  const pairKey = /\(username, ?ip\)|username and ip pair|per \(username/i.test(text);
  probe('H2', 'Anonymous caller locks out any known username (admin, supplier-a..e, cafe1/2), correct password refused',
    Boolean(t && r && seeded && admin && !pairKey), [`throttle: ${t}`, `rule: ${r}`, `known usernames: ${seeded}; ${admin}`, `per-(username,IP) keying present: ${pairKey}`]);
}
// H3: placeholder values are accepted as secrets.
{
  const ph = '<placeholder>';
  const demoMin = Number((text.match(/`RS_DEMO_PASSWORD` \(≥ (\d+) chars\)/) || [])[1]);
  const adminMin = Number((text.match(/`RS_ADMIN_PASSWORD` \(≥ (\d+) chars/) || [])[1]);
  const fakeSecretRow = quote(/\| `RS_FAKE_WEBHOOK_SECRET` \|[^\n]*/);
  const demoRow = quote(/\| `RS_DEMO_PASSWORD` \|[^\n]*/);
  const rejectsPlaceholder = /refuses?[^.\n]*placeholder|placeholder[^.\n]*(refused|rejected)/i.test(text);
  probe('H3', 'The literal .env.example placeholder passes the secret checks (demo password, fake webhook secret)',
    Boolean(ph.length >= demoMin && !rejectsPlaceholder && fakeSecretRow),
    [`"${ph}".length = ${ph.length}; demo min ${demoMin} (accepted: ${ph.length >= demoMin}); admin min ${adminMin} (accepted: ${ph.length >= adminMin})`,
      `rows: ${demoRow} ; ${fakeSecretRow}`, `any rule refusing placeholder values: ${rejectsPlaceholder}`]);
}
// H4: anonymous webhook route has no rate limit; invalid rows are kept forever; each POST costs an outbound verify call.
{
  const rl = section('**Rate limiting:**', /^\*\*Threat list/);
  const mentionsWebhook = /webhook/i.test(rl);
  const kept = quote(/webhook events are kept \(ids only\)/);
  const invalidInsert = quote(/`FAILURE` or missing headers → insert a row with `signature_status = 'invalid'`/);
  const verifyCall = quote(/Sandbox: `POST \/v1\/notifications\/verify-webhook-signature`/);
  probe('H4', 'Unsigned webhook flood: no rate limit, one stored row + one outbound PayPal verify call per POST, rows never purged',
    Boolean(!mentionsWebhook && kept && invalidInsert && verifyCall),
    [`rate-limit section mentions webhooks: ${mentionsWebhook}`, `retention: ${kept}`, `insert: ${invalidInsert}`, `verify: ${verifyCall}`]);
}
// H5: a loopback PayPal stub is accepted at runtime and labelled as PayPal Sandbox.
{
  const base = quote(/PayPal base URL must be `https:\/\/api-m\.sandbox\.paypal\.com` or `http:\/\/127\.0\.0\.1:<port>`[^;]*/);
  const label = quote(/With the Sandbox adapter, every payment element shows "PayPal Sandbox — no real money"/);
  const gated = /loopback[^.\n]*(only when|only if|requires?) `?RS_TEST/i.test(text) || /loopback[^.\n]*simulated/i.test(text);
  probe('H5', 'RS_PAYPAL_BASE_URL=http://127.0.0.1:<port> runs under `npm start` and is labelled "PayPal Sandbox", not "Simulated"',
    Boolean(base && label && !gated), [`base: ${base}`, `label: ${label}`, `loopback gated to tests or labelled simulated: ${gated}`]);
}
// H6: no cap on live reservations per customer (stock hoarding with seed on_hand = 1).
{
  const onHand = quote(/inventory `on_hand = 1, reserved = 0`/);
  const signup = quote(/Customers may also self-register \(`RS_ALLOW_SIGNUP`, default `1`\)/);
  const cap = /(live|active) reservations? per customer|per customer[^.\n]*reservation|reservations? per (user|customer)/i.test(text);
  const ttl = quote(/`expires_at = now \+ RS_RESERVATION_TTL_MIN` \(default 30\)/);
  probe('H6', 'One self-registered customer can hold every supplier\'s stock for 30 min, repeatedly (no per-customer reservation cap, no payment needed)',
    Boolean(onHand && signup && !cap), [`seed: ${onHand}`, `signup: ${signup}`, `ttl: ${ttl}`, `per-customer reservation cap present: ${cap}`]);
}
// H7: CLI stdout cap stated twice with different values.
{
  const a = quote(/stdout cap \d+ MiB/);
  const b = quote(/stdout: NDJSON \(cap \d+ MiB\)/);
  const va = a && a.match(/(\d+) MiB/)[1];
  const vb = b && b.match(/(\d+) MiB/)[1];
  probe('H7', 'CLI stdout cap is inconsistent between Security T25 and the CLI adapter', Boolean(va && vb && va !== vb), [`T25: ${a}`, `adapter: ${b}`]);
}
// H8: model-authored question text and question.field are free strings shown to the customer.
{
  const q = quote(/"field": \{"type": "string"\}, "question": \{"type": "string"\}/);
  const local = quote(/at most 6 questions, each ≤ 300 characters/);
  const fieldEnum = /questions?[^.\n]*field[^.\n]*(enum|one of the nine)/i.test(text);
  probe('H8', 'Injected image text can surface verbatim as a model-authored "question" in the customer UI (field not enum-bound, text not templated)',
    Boolean(q && !fieldEnum), [`schema: ${q}`, `validator: ${local}`, `question.field enum-bound: ${fieldEnum}`]);
}
// H9: provenance on confirm is client-supplied.
{
  const c = quote(/`POST \/api\/requests\/:id\/confirm` \| `\{fields: \{<name>: \{value, provenance: "user_text"\|"image"\|"manual"\}\}\}`/);
  const derived = /provenance[^.\n]*(derived by the server|server-derived|server derives)/i.test(text);
  probe('H9', 'Customer can submit any value with provenance "image" or "user_text" at confirm', Boolean(c && !derived), [`route: ${c}`, `server derives provenance: ${derived}`]);
}
// H10: throttle username key normalisation unspecified (case variants vs COLLATE NOCASE lookup).
{
  const nocase = quote(/username TEXT NOT NULL UNIQUE COLLATE NOCASE/);
  const key = quote(/login_failures \(id INTEGER PRIMARY KEY, username_key TEXT NOT NULL/);
  const norm = /username_key[^.\n]*(lower|NFC|normali[sz]ed|case-fold)/i.test(text);
  probe('H10', 'Throttle key normalisation unspecified while the user lookup is case-insensitive', Boolean(nocase && key && !norm), [`users: ${nocase}`, `failures: ${key}`, `normalisation stated: ${norm}`]);
}
// H11: Origin check trusts the request's own Host; no Host allow-list (DNS rebinding to the 127.0.0.1 listener).
{
  const o = quote(/When an `Origin` header is present it must equal `RS_PUBLIC_URL`'s origin or `http\(s\):\/\/<Host>`/);
  const rest = o ? text.split("When an `Origin` header is present").join('') : text;
  const hostCheck = /Host header[^.\n]*(allow-?list|must equal|validated|refused)/i.test(rest);
  probe('H11', 'Origin check accepts http(s)://<Host>; no Host header allow-list', Boolean(o && !hostCheck), [`origin: ${o}`, `host allow-list stated elsewhere: ${hostCheck}`]);
}
// H12: file permissions of the database and uploads unspecified.
{
  const perms = /0o?600|0o?700|chmod|file mode|umask|permissions? (of|on) (the )?(data|db|database|uploads)/i.test(text);
  probe('H12', 'No file-mode rule for data/app.db (password hashes, sessions) and data/uploads/', !perms, [`mode rule present: ${perms}`]);
}
// H13: daily model budget is global with no per-customer share.
{
  const b = quote(/today's spend = Σ `COALESCE\(actual_usd, reserved_usd\)` for the Asia\/Amman day/);
  const share = /per-customer (daily|budget|share)|daily[^.\n]*per customer/i.test(text);
  probe('H13', 'One customer (or a handful of self-registered ones) can exhaust the shared daily model budget for everyone', Boolean(b && !share), [`budget: ${b}`, `per-customer daily share: ${share}`]);
}
// H14: forced reset archives authorized/unknown operations without voiding or resolving them.
{
  const f = quote(/Payment operations and provider calls get `archived_at`, never DELETE/);
  const ign = quote(/Archived operations are ignored by the reconciler and the reset guard/);
  const voidsFirst = /force[^.\n]*(void|resolve)[^.\n]*before archiv/i.test(text);
  probe('H14', 'Forced reset strands authorized holds and unresolved captures (archived rows are ignored by the reconciler)', Boolean(f && ign && !voidsFirst), [`archive: ${f}`, `reconciler: ${ign}`, `voids before archiving: ${voidsFirst}`]);
}
// H15: fake approval listener has no interface contract (auth, binding, id entropy, labelling).
{
  const contract = /fake approval (page|listener)[^.\n]*(route|GET |POST |form|token)/i.test(text);
  const labelled = /fake approval page[^.\n]*(Simulated|labelled)/i.test(text);
  probe('H15', 'Fake approval page/listener: no route contract, no stated id entropy, no "Simulated" label on the page itself', !contract && !labelled, [`contract: ${contract}`, `page labelled: ${labelled}`]);
}

const confirmed = results.filter((r) => r.confirmed).map((r) => r.id);
console.log(`\nprobe result: ${confirmed.length} of ${results.length} hypotheses CONFIRMED: ${confirmed.join(', ') || 'none'}`);
process.exit(confirmed.length ? 1 : 0);
