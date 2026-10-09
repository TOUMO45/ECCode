// technical-reviewer probe (phase B, third review, SEC-B-3), independent of the engineer's tests.
// Checks: jsonNestsDeeperThan refuses 20,000-deep and 33-deep text and accepts 32; string contents are ignored;
// http canonicalJson throws TypeError (not RangeError) on 20,000-deep objects and arrays; domain canonicalJson
// handles a 32-deep body (the deepest readJsonBody lets through). Exit 0 = all hold.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const imp = (p) => import(pathToFileURL(join(process.cwd(), p)));
const body = await imp('src/http/body.js');
const dom = await imp('src/domain/canonical.js');
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; };
const nestedText = (n) => '['.repeat(n) + ']'.repeat(n);
check(body.JSON_MAX_DEPTH === 32, 'JSON_MAX_DEPTH is 32');
check(body.jsonNestsDeeperThan(nestedText(20000)) === true, '20,000-deep array text refused');
check(body.jsonNestsDeeperThan('{"a":' + nestedText(32) + '}') === true, '33 levels refused');
check(body.jsonNestsDeeperThan(nestedText(32)) === false, '32 levels accepted');
check(body.jsonNestsDeeperThan(JSON.stringify({ s: '{'.repeat(10000) + '\\"[' })) === false, 'brackets and escapes inside strings ignored');
for (const kind of ['object', 'array']) {
  let deep = {};
  for (let i = 0; i < 20000; i++) deep = kind === 'object' ? { a: deep } : [deep];
  let name = 'no throw';
  try { body.canonicalJson(deep); } catch (e) { name = e.name; }
  check(name === 'TypeError', 'http canonicalJson on 20,000-deep ' + kind + ' throws TypeError (got ' + name + ')');
}
const parsed = JSON.parse(nestedText(32));
let domOk = true;
try { dom.canonicalJson(parsed); dom.canonicalJson(JSON.parse('{"a":' + nestedText(31) + '}')); } catch { domOk = false; }
check(domOk, 'domain canonicalJson encodes the deepest body readJsonBody accepts');
console.log(fails ? fails + ' FAILED' : 'all SEC-B-3 checks hold');
process.exit(fails ? 1 : 0);
