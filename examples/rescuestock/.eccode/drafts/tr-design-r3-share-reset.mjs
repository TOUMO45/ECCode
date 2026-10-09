// technical-reviewer check (design gate, revision 3, F-TR-15 / F-TR-16 / NFR6 / RS-37 / RS-38):
// Part A: my implementation of AI > Runtime controls step 3 (integer micro-dollars; global test spend + cap > budget;
//   per-customer test against floor(share x budget) when share < 1), with the defaults READ FROM the spec's env table.
//   (1) NFR6's stated configuration (cap 0.10, budget 0.25) with the share pinned to 1: calls 1-2 allowed, 3 refused
//       "global" -> the AC holds as the test pins it.
//   (2) The same NFR6 configuration under the production default share: what happens (reported, shows the pin matters).
//   (3) Production defaults, fake cost = cap: one customer's 5th call refused "customer", another customer allowed.
// Part B: the revised migrations on node:sqlite: the admin reset's new step (DELETE request_create rate events) is
//   permitted, while audit_events / inventory_ledger stay append-only and payment rows are not touched by it.
// Exit 0 = (1), (3) and Part B hold.  Usage: node tr-design-r3-share-reset.mjs <spec.md>
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const spec = readFileSync(process.argv[2], 'utf8');
const envDefault = (name) => { const m = spec.match(new RegExp('\\| `' + name + '` \\| `?([0-9.]+)`? \\|')); return m ? m[1] : null; };
const micro = (s) => { const [i, f = ''] = String(s).split('.'); return Number(i) * 1e6 + Number((f + '000000').slice(0, 6)); };
const D = { share: envDefault('RS_MODEL_CUSTOMER_DAILY_SHARE'), cap: envDefault('RS_MODEL_CALL_CAP_USD'), budget: envDefault('RS_MODEL_DAILY_BUDGET_USD') };
console.log(`defaults read from the spec env table: ${JSON.stringify(D)}`);
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`); };

function simulate({ cap, budget, share, cost }, calls) {
  const spend = []; const out = [];
  const B = micro(budget), C = micro(cap), S = Number(share);
  for (const customer of calls) {
    const total = spend.reduce((a, r) => a + r.v, 0);
    const mine = spend.filter((r) => r.c === customer).reduce((a, r) => a + r.v, 0);
    if (total + C > B) { out.push('refused:global'); continue; }
    if (S < 1 && mine + C > Math.floor(S * B)) { out.push('refused:customer'); continue; }
    spend.push({ c: customer, v: micro(cost) }); out.push('ok');
  }
  return out;
}
const nfr6Pinned = simulate({ cap: '0.10', budget: '0.25', share: '1', cost: '0.10' }, [1, 1, 1]);
check('(1) NFR6 config, share pinned to 1: ok, ok, refused:global', nfr6Pinned.join(',') === 'ok,ok,refused:global', nfr6Pinned.join(','));
const nfr6Default = simulate({ cap: '0.10', budget: '0.25', share: D.share, cost: '0.10' }, [1, 1, 1]);
console.log(`info (2) NFR6 config under the production default share ${D.share}: ${nfr6Default.join(',')}`);
const perCustomer = simulate({ cap: D.cap, budget: D.budget, share: D.share, cost: D.cap }, [1, 1, 1, 1, 1, 2]);
check('(3) defaults, cost = cap: customer 1 calls 1-4 ok, 5th refused:customer, customer 2 ok', perCustomer.join(',') === 'ok,ok,ok,ok,refused:customer,ok', perCustomer.join(','));

// Part B
const dd = spec.slice(spec.indexOf('## Data Design'), spec.indexOf('## Background Processing'));
const blocks = [...dd.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'tr-r3-')), 'app.db'));
let migErr = null; try { blocks.forEach((b) => db.exec(b)); } catch (e) { migErr = e.message; }
check('revised migrations 001-005 execute', blocks.length === 5 && !migErr, migErr || `${blocks.length} blocks`);
const now = '2026-10-20T07:00:00.000Z';
db.exec(`INSERT INTO rate_events (user_key, kind, at) VALUES ('u:1','request_create','${now}'),('u:1','request_create','${now}'),('ip:10.0.0.1','register','${now}');
INSERT INTO audit_events (at, actor_role, action, entity_type, outcome) VALUES ('${now}','admin','reset','demo','ok');
INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, actor, at) VALUES (1,1,'adjust',1,0,1,0,'admin_reset','admin','${now}');`);
let delErr = null; try { db.exec("DELETE FROM rate_events WHERE kind = 'request_create'"); } catch (e) { delErr = e.message; }
const left = db.prepare('SELECT kind, count(*) AS n FROM rate_events GROUP BY kind').all();
check('reset step: DELETE request_create rate events permitted; other rate events kept', !delErr && left.length === 1 && left[0].kind === 'register', delErr || JSON.stringify(left));
const refused = (sql) => { try { db.exec(sql); return false; } catch { return true; } };
check('RS-38 still holds after the reset step: audit_events and inventory_ledger refuse DELETE', refused('DELETE FROM audit_events') && refused('DELETE FROM inventory_ledger'));
db.close();
console.log(`failures: ${fails}`);
process.exit(fails ? 1 : 0);
