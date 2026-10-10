// technical-reviewer probe (phase C, T8 / SEC-1 / SEC-9 / F-TR-17), independent of c1's tests. In-process harness with
// RS_TRUST_PROXY=1 so each call can come from a chosen client IP (last X-Forwarded-For hop).
//   1 pair limit: 5 failures for cafe1 from IP-1, then the CORRECT password from IP-1 -> 429 signin_pair + Retry-After
//   2 the correct password from IP-2 right after -> 200 (no lockout of the real user)
//   3 cross-IP: 12 failures for cafe2 from 12 different IPs, then the correct password from a 13th IP -> 200 after a
//     delay of about (12 - 9) = 3 s, never a refusal
//   4 SEC-9: failures as "Admin", " admin ", "ADMIN" share one key: the 6th attempt as "admin" -> 429 signin_pair
//   5 unknown username: refused at the same count as a known one; its 401 equals the bad-password 401 (code, message)
//   6 IP limit: 20 failures with 20 usernames from one IP -> the 21st (any username) -> 429 signin_ip
//   7 F-TR-17: the 6th registration from one IP -> 429 register_ip (default RS_REGISTER_PER_IP_PER_HOUR = 5)
//   8 (measured, not judged) IPv6 rotation inside one /64: 6 failures from 6 addresses of 2001:db8:1:1::/64 -> refused?
// Usage: node tr-phc-throttle.mjs   Exit 0 = 1-7 hold.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const root = process.cwd();
const imp = (p) => import(pathToFileURL(join(root, p)));
const { DEMO_PASSWORD, startHarness } = await imp('test/helpers/app-harness.js');
const { ensureAdmin } = await imp('src/services/users.js');

const ADMIN_PASSWORD = 'admin-password-for-review-0001';
const h = await startHarness({ seed: true, record: false, env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD, RS_TRUST_PROXY: '1' } });
await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
const failures = [];
const lines = [];
const check = (ok, what) => { lines.push(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const csrf = (await h.request({ path: '/api/auth/csrf' })).json.csrfToken;
async function signin(username, password, ip) {
  const t = performance.now();
  const res = await h.request({ method: 'POST', path: '/api/auth/signin', jsonBody: { username, password }, headers: { 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip } });
  res.elapsed = performance.now() - t;
  return res;
}
async function register(username, ip) {
  return h.request({ method: 'POST', path: '/api/auth/register', jsonBody: { username, password: 'register-password-1', displayName: 'R' }, headers: { 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip } });
}

// 1, 2
for (let i = 0; i < 5; i++) await signin('cafe1', 'wrong-password', '10.0.0.1');
const sixth = await signin('cafe1', DEMO_PASSWORD, '10.0.0.1');
check(sixth.status === 429 && sixth.json.error.details.limit === 'signin_pair' && Number(sixth.headers['retry-after']) > 0, `1 6th attempt with the correct password from the same IP -> ${sixth.status} ${sixth.json?.error?.details?.limit} Retry-After ${sixth.headers['retry-after']}`);
const other = await signin('cafe1', DEMO_PASSWORD, '10.0.0.2');
check(other.status === 200, `2 correct password from another IP -> ${other.status}`);

// 3
for (let i = 0; i < 12; i++) await signin('cafe2', 'wrong-password', `10.1.0.${i + 1}`);
const delayed = await signin('cafe2', DEMO_PASSWORD, '10.1.0.200');
check(delayed.status === 200 && delayed.elapsed >= 2500 && delayed.elapsed < 9000, `3 after 12 cross-IP failures the correct password -> ${delayed.status} after ${Math.round(delayed.elapsed)} ms (about 3 s expected)`);

// 4
for (const variant of ['Admin', ' admin ', 'ADMIN', 'admin', 'Admin ']) await signin(variant, 'wrong-password', '10.2.0.1');
const adminSixth = await signin('admin', ADMIN_PASSWORD, '10.2.0.1');
check(adminSixth.status === 429 && adminSixth.json.error.details.limit === 'signin_pair', `4 SEC-9 case variants share one key: 6th -> ${adminSixth.status} ${adminSixth.json?.error?.details?.limit}`);

// 5
const unknown401 = await signin('nobody-at-all', 'wrong-password', '10.3.0.1');
const bad401 = await signin('cafe1', 'wrong-password', '10.3.0.2');
check(unknown401.status === 401 && bad401.status === 401 && unknown401.json.error.code === bad401.json.error.code && unknown401.json.error.message === bad401.json.error.message,
  `5 unknown user and bad password give the same 401 (${unknown401.json?.error?.code} / ${bad401.json?.error?.code})`);
for (let i = 0; i < 4; i++) await signin('nobody-at-all', 'wrong-password', '10.3.0.1');
const unknownSixth = await signin('nobody-at-all', 'wrong-password', '10.3.0.1');
check(unknownSixth.status === 429 && unknownSixth.json.error.details.limit === 'signin_pair', `5 unknown username refused at the same count -> ${unknownSixth.status}`);

// 6
for (let i = 0; i < 20; i++) await signin(`user-${i}`, 'wrong-password', '10.4.0.1');
const ipLimited = await signin('cafe1', DEMO_PASSWORD, '10.4.0.1');
check(ipLimited.status === 429 && ipLimited.json.error.details.limit === 'signin_ip', `6 21st attempt from one IP -> ${ipLimited.status} ${ipLimited.json?.error?.details?.limit}`);

// 7
const regs = [];
for (let i = 0; i < 6; i++) regs.push((await register(`reg-${i}-${process.pid}`, '10.5.0.1')).status);
const lastReg = await register(`reg-x-${process.pid}`, '10.5.0.1');
check(regs.slice(0, 5).every((s) => s === 201) && regs[5] === 429 && lastReg.json.error.details.limit === 'register_ip', `7 registrations from one IP: ${regs.join(',')} (6th refused, limit ${lastReg.json?.error?.details?.limit})`);

// 8 (measured)
const v6 = [];
for (let i = 1; i <= 6; i++) v6.push((await signin('cafe1', 'wrong-password', `2001:db8:1:1::${i.toString(16)}`)).status);
lines.push(`INFO 8 six failures for cafe1 from six addresses of one IPv6 /64: ${v6.join(',')} (all 401 = the /64 is not one key)`);

await h.close();
console.log(lines.join('\n'));
console.log(failures.length ? `${failures.length} FAILED` : 'T8 / SEC-1 / SEC-9 / F-TR-17 hold');
process.exit(failures.length ? 1 : 0);
