// technical-reviewer probe (phase C, SEC-C-4): which href values public/js/dom.js setAttr accepts, and where a browser-
// style URL parser (WHATWG URL, as in Chromium) resolves them against http://localhost:3000/. Measurement only.
// Usage: node tr-phc-domurl.mjs   Prints one line per value; exit 0 always.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { setAttr } = await import(pathToFileURL(join(process.cwd(), 'public/js/dom.js')));
const values = ['#/requests/1', '/api/x', '//evil.example/x', '/\\evil.example/x', '/\t/evil.example/x', '/\n/evil.example/x', 'javascript:alert(1)', 'https://www.sandbox.paypal.com/checkoutnow?token=1'];
for (const v of values) {
  const node = { setAttribute() {} };
  let accepted = true;
  try { setAttr(node, 'href', v); } catch { accepted = false; }
  let host = '-';
  try { host = new URL(v, 'http://localhost:3000/').host; } catch { host = 'unparsable'; }
  console.log(`${accepted ? 'accepted' : 'refused '} ${JSON.stringify(v).padEnd(52)} resolves to host ${host}`);
}
process.exit(0);
