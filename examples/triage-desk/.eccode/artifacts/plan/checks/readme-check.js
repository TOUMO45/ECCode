'use strict';
// Plan check for task t16-readme (delivery-lead, plan gate companion).
// Run from the project root: node .eccode/artifacts/plan/checks/readme-check.js
// A floor, not a substitute for review: README.md must cover the topics and
// carry the two warnings listed in spec §Deployment "Run shape". Exit 0/1.
const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
const lower = text.toLowerCase();
const headings = text.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.toLowerCase());
const failures = [];

for (const topic of ['install', 'test', 'eval', 'start', 'privacy', 'configuration', 'limitation', 'rollback']) {
  if (!headings.some((h) => h.includes(topic))) failures.push(`no heading mentions "${topic}"`);
}
for (const s of [
  'npm test', 'npm run eval', 'npm run eval:tune', 'npm run eval -- --provider live', 'npm start',
  'node --env-file=.env src/server.js',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'TRIAGE_ANTHROPIC_BASE_URL', 'HOST', 'TRIAGE_ALLOW_REMOTE', 'PORT',
  'TRIAGE_TIMEOUT_MS', 'TRIAGE_MAX_TOKENS', 'GET /api/health', 'NOT RUN',
]) {
  if (!text.includes(s)) failures.push(`missing "${s}"`);
}
// DES-1 warning: the custom base URL receives the key and every redacted ticket; ANTHROPIC_BASE_URL is ignored.
if (!/TRIAGE_ANTHROPIC_BASE_URL[\s\S]{0,400}(api key|key)/i.test(text)) failures.push('no warning that TRIAGE_ANTHROPIC_BASE_URL receives the API key');
if (!/ANTHROPIC_BASE_URL[^\n]{0,200}ignored|ignored[^\n]{0,200}ANTHROPIC_BASE_URL/i.test(text.replace(/TRIAGE_ANTHROPIC_BASE_URL/g, 'T_A_B_U'))) {
  failures.push('no statement that ANTHROPIC_BASE_URL is ignored');
}
// DES-6 warning: TRIAGE_ALLOW_REMOTE=1 exposes an unauthenticated, key-spending endpoint.
if (!/TRIAGE_ALLOW_REMOTE=1[\s\S]{0,400}(no authentication|unauthenticated)/i.test(text)) failures.push('no unauthenticated-exposure warning for TRIAGE_ALLOW_REMOTE=1');
// Rollback / kill switch.
if (!/unset[^\n]{0,80}ANTHROPIC_API_KEY/i.test(text)) failures.push('rollback does not say to unset ANTHROPIC_API_KEY');
if (!lower.includes('fallback')) failures.push('no mention of fallback mode');

for (const f of failures) console.log(`FAIL ${f}`);
if (failures.length) {
  console.log(`readme-check FAIL ${failures.length}`);
  process.exit(1);
}
console.log('readme-check PASS');
