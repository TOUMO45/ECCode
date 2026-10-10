// technical-reviewer helper: in tr-r1-general.mjs G2, call /api/auth/session last, because the test client adopts any
// csrfToken in a response body and /api/auth/csrf hands out a pre-login token (a probe artifact, not an app defect).
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/drafts/tr-r1-general.mjs';
const text = readFileSync(file, 'utf8');
const from = "['/api/health', '/api/config', '/api/auth/session', '/api/auth/csrf']";
const to = "['/api/health', '/api/config', '/api/auth/csrf', '/api/auth/session']";
if (!text.includes(from)) { console.error('pattern not found'); process.exit(1); }
writeFileSync(file, text.replace(from, to));
console.log('patched');
