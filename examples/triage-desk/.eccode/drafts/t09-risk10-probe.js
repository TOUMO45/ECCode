'use strict';
// RISK-10 probe (t09): times validateTriage directly (no gate) vs createAnthropicProvider().analyse (gated) on the
// same 32k-char "a.a.a." model output. Run from the project root. Exits 1 if the gated path is not < 100 ms.
const { validateTriage } = require('../../src/triage/schema.js');
const { createAnthropicProvider } = require('../../src/triage/anthropic-provider.js');
const { messageOk } = require('../../test/helpers/fake-fetch.js');
const deg = 'a.'.repeat(16000);
const obj = { category: 'billing', urgency: 'high', summary: deg, suggestedReply: deg };
(async () => {
  let t = performance.now();
  const direct = validateTriage(obj);
  const directMs = performance.now() - t;
  const p = createAnthropicProvider({ apiKey: 'k', model: 'claude-haiku-5-5', baseUrl: 'https://api.anthropic.com',
    timeoutMs: 30000, maxTokens: 2048, fetchImpl: messageOk(obj) });
  t = performance.now();
  const r = await p.analyse('t');
  const gatedMs = performance.now() - t;
  console.log(JSON.stringify({ ungatedValidateTriageMs: Math.round(directMs), ungatedErrors: direct.errors,
    gatedAnalyseMs: +gatedMs.toFixed(2), gatedResult: { reason: r.reason, detail: r.detail } }));
  process.exit(gatedMs < 100 && r.reason === 'invalid_output' ? 0 : 1);
})();
