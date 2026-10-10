// technical-reviewer helper: applies the session-refresh and feasibility-bias edits to .eccode/drafts/tr-phc-walk.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/drafts/tr-phc-walk.mjs';
let text = readFileSync(file, 'utf8');
const swaps = [
  [
    "async function signIn(username, password = DEMO_PASSWORD) { const c = createClient(h.request); await c.signIn(username, password); return c; }",
    "const creds = new Map();\nasync function signIn(username, password = DEMO_PASSWORD) { const c = createClient(h.request); await c.signIn(username, password); creds.set(c, [username, password]); return c; }\nlet lastLogin = h.clock.now();\nasync function refreshSessions() { for (const [c, [u, p]] of creds) await c.signIn(u, p); lastLogin = h.clock.now(); }",
  ],
  [
    "await c.register({ username: `rev-walk-${i}-${process.pid}`, password: 'review-walk-password', displayName: 'Walk' }); customers.push(c); }",
    "const u = `rev-walk-${i}-${process.pid}`; await c.register({ username: u, password: 'review-walk-password', displayName: 'Walk' }); creds.set(c, [u, 'review-walk-password']); customers.push(c); }",
  ],
  ["const q = pick([100, 200, 200, 300, 400]);", "const q = pick([200, 200, 200, 100, 300]);"],
  ["budgetCents: pick([12000, 20000, 50000, 9000]), maxPickups: pick([1, 2, 2, 3]),", "budgetCents: pick([12000, 20000, 50000, 20000, 9000]), maxPickups: pick([2, 2, 3, 1]),"],
  [
    "for (let step = 1; step <= STEPS; step++) {\n  let res;",
    "for (let step = 1; step <= STEPS; step++) {\n  if (h.clock.now() - lastLogin > 45 * 60_000) await refreshSessions();\n  let res;",
  ],
];
for (const [from, to] of swaps) {
  if (!text.includes(from)) { console.error('pattern not found: ' + from.slice(0, 60)); process.exit(1); }
  text = text.replace(from, to);
}
writeFileSync(file, text);
console.log('patched ' + swaps.length + ' places');
