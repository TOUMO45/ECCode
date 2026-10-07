'use strict';
// t04 probe: shows that the DES-8 vectors bite (the approved reference hasLink accepts them) and that the
// review's example `giu` regex would case-fold U+017F LONG S into the token, which the shipped regex avoids.
const assert = require('node:assert');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const origLog = console.log; console.log = () => {};
const ref = require(path.join(root, '.eccode/artifacts/design/design-vectors.js'));
console.log = origLog;
const { containsLinkOrEmail } = require(path.join(root, 'src/triage/schema.js'));
const des8 = ['Go to éasp.net now.', 'Go to ñsocket.io now.', 'Go to ١asp.net now.', 'Go to evil­asp.net now.'];
for (const s of des8) {
  assert.strictEqual(ref.hasLink(s), false, 'reference (ASCII lookbehind) accepts: ' + JSON.stringify(s));
  assert.strictEqual(containsLinkOrEmail(s), true, 'schema.js rejects: ' + JSON.stringify(s));
}
assert.strictEqual(ref.hasLink('See asp.net.” now.'), true, 'reference falsely rejects curly quote');
assert.strictEqual(containsLinkOrEmail('See asp.net.” now.'), false, 'schema.js accepts curly quote');
const reviewExample = /(?<![\p{L}\p{N}\p{M}_.@/:-])(?:asp\.net|ado\.net|vb\.net|socket\.io)(?=$|[\s,;!?"'’”)\]]|\.(?:$|[\s"'’”)\]]))/giu;
assert.strictEqual('Go to aſp.net now.'.replace(reviewExample, 'product'), 'Go to product now.', 'giu folds long s');
assert.strictEqual(containsLinkOrEmail('Go to aſp.net now.'), true, 'schema.js rejects long-s spelling');
console.log('DES-8 probe: reference accepts', des8.length, 'Unicode-prefixed hosts; schema.js rejects them; giu example folds U+017F, shipped regex does not');
