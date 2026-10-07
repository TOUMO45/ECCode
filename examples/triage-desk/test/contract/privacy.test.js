'use strict';
// Contract test: privacy (brief AC10, AC14; spec Security T6/T11, §Testing Strategy DES-1).
// Spawned servers in fallback mode and in live mode against the loopback fake-anthropic. A unique marker
// ticket and the fake key never appear in stdout/stderr, and the key never appears in any response.
// Parent-env isolation: a key and base URL set in the PARENT process never reach the spawned child, because
// spawn-server builds the child env explicitly. ANTHROPIC_BASE_URL (SDK-wide name) is ignored.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildApp } = require('../../src/app.js');
const { createLogger } = require('../../src/log.js');
const { request } = require('../helpers/http-client.js');
const { messageOk, capture } = require('../helpers/fake-fetch.js');
const { startFakeAnthropic } = require('../helpers/fake-anthropic.js');
const { spawnServer } = require('../helpers/spawn-server.js');

const MARKER = 'privacy-marker-e5d1907b';
const FAKE_KEY = 'sk-ant-FAKE-privacy-key-6c2a';
const PARENT_KEY = 'parent-key-FAKE';
const TICKET = `My account is locked and I cannot log in. ${MARKER} please help, email ${MARKER}@example.com.`;
const VALID = Object.freeze({
  category: 'account',
  urgency: 'high',
  summary: 'Customer cannot log in because the account is locked.',
  suggestedReply: 'Sorry you are locked out; we will help you regain access. Could you confirm the account name?',
});

const post = (port, ticket) => request({ port, method: 'POST', path: '/api/triage', body: { ticket } });

function assertNoSecretsInResponse(res, secrets) {
  const all = res.body + JSON.stringify(res.headers);
  for (const s of secrets) assert.ok(!all.includes(s), `secret/marker in a response: ${s}`);
}

function assertCleanOutput(srv, secrets) {
  const out = srv.stdout();
  const err = srv.stderr();
  for (const s of secrets) {
    assert.ok(!out.includes(s), `found in child stdout: ${s}`);
    assert.ok(!err.includes(s), `found in child stderr: ${s}`);
  }
}

/** Sets parent env vars for the duration of fn, restoring the previous values in finally. */
async function withParentEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
  try {
    Object.assign(process.env, vars);
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

async function exercise(srv) {
  const responses = [];
  responses.push(await request({ port: srv.port, path: '/api/health' }));
  responses.push(await post(srv.port, TICKET));
  responses.push(await request({ port: srv.port, path: '/' }));
  responses.push(await request({ port: srv.port, method: 'POST', path: '/api/triage', body: `{"ticket": "${MARKER}` }));
  responses.push(await request({ port: srv.port, method: 'POST', path: '/api/triage', headers: { host: 'evil.example' }, body: { ticket: TICKET } }));
  await srv.waitForLog((r) => r.event === 'request' && r.status === 403);
  return responses;
}

test('AC10 fallback mode (ANTHROPIC_API_KEY explicitly empty) + DES-1 parent-env isolation', async () => {
  await withParentEnv({ ANTHROPIC_API_KEY: PARENT_KEY, TRIAGE_ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }, async () => {
    const srv = await spawnServer({ env: { ANTHROPIC_API_KEY: '' } });
    try {
      assert.equal(srv.listening.mode, 'fallback');
      assert.equal(srv.listening.baseUrlCustom, false, 'parent TRIAGE_ANTHROPIC_BASE_URL must not reach the child');
      assert.ok(!('TRIAGE_ANTHROPIC_BASE_URL' in srv.env) && !('ANTHROPIC_BASE_URL' in srv.env));
      const [health, triage, ...rest] = await exercise(srv);
      assert.deepEqual(health.json, { status: 'ok', mode: 'fallback', model: null });
      assert.equal(triage.status, 200);
      assert.equal(triage.json.source, 'fallback');
      assert.equal(triage.json.fallbackReason, 'no_api_key');
      for (const r of [health, triage, ...rest]) assertNoSecretsInResponse(r, [PARENT_KEY, MARKER]);
      assertCleanOutput(srv, [MARKER, PARENT_KEY]);
      assert.ok(!srv.logs().some((r) => r.event === 'warning' && r.code === 'custom_base_url'));
    } finally {
      await srv.stop();
    }
  });
});

test('DES-1: with no key in the test env at all, a parent ANTHROPIC_API_KEY still does not reach the child', async () => {
  await withParentEnv({ ANTHROPIC_API_KEY: PARENT_KEY, TRIAGE_ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }, async () => {
    const srv = await spawnServer({ env: {} });
    try {
      assert.deepEqual(Object.keys(srv.env).sort(), ['PATH', 'PORT'].filter((k) => k !== 'PATH' || process.env.PATH !== undefined));
      assert.equal(srv.listening.mode, 'fallback');
      assert.equal(srv.listening.baseUrlCustom, false);
      const health = await request({ port: srv.port, path: '/api/health' });
      assert.equal(health.json.mode, 'fallback');
      assertCleanOutput(srv, [PARENT_KEY]);
    } finally {
      await srv.stop();
    }
  });
  assert.equal(process.env.ANTHROPIC_API_KEY === PARENT_KEY, false, 'parent env restored');
});

test('T11(c): ANTHROPIC_BASE_URL is ignored by the child (baseUrlCustom false, no custom_base_url warning)', async () => {
  const srv = await spawnServer({ env: { ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } });
  try {
    assert.equal(srv.listening.baseUrlCustom, false);
    assert.ok(!srv.logs().some((r) => r.event === 'warning'));
  } finally {
    await srv.stop();
  }
});

test('T11(c) in-process: ANTHROPIC_BASE_URL alone leaves the outbound URL at https://api.anthropic.com', async () => {
  const stub = capture(messageOk(VALID));
  const app = buildApp({ env: { ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: 'http://evil.example', PORT: '0' }, fetchImpl: stub, log: createLogger(() => {}) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(app.config.baseUrlCustom, false);
    const r = await post(app.server.address().port, TICKET);
    assert.equal(r.json.source, 'model');
    assert.equal(stub.calls[0].url, 'https://api.anthropic.com/v1/messages');
  } finally {
    await new Promise((resolve) => { app.server.closeAllConnections(); app.server.close(resolve); });
  }
});

test('AC10/AC14 live mode against fake-anthropic: marker and key never in stdout/stderr or any response', async () => {
  const fake = await startFakeAnthropic();
  const srv = await spawnServer({ env: { ANTHROPIC_API_KEY: FAKE_KEY, TRIAGE_ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_MODEL: 'claude-opus-5-5' } });
  try {
    assert.equal(srv.listening.mode, 'live');
    assert.equal(srv.listening.baseUrlCustom, true);
    await srv.waitForLog((r) => r.event === 'warning' && r.code === 'custom_base_url');

    // Success path; the upstream body names a different model, the response must name the configured one.
    fake.replyMessage(VALID, { model: 'claude-haiku-5-5' }, { once: true });
    // Error paths whose upstream bodies echo the marker and the key: none of it may surface.
    fake.reply(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${FAKE_KEY} ${MARKER}` } }, { once: true });
    fake.reply(200, `not json ${MARKER} ${FAKE_KEY}`, { once: true });
    fake.replyMessage({ ...VALID, summary: `Echo ${MARKER}. Second sentence.` }, undefined, { once: true });

    const responses = [];
    const health = await request({ port: srv.port, path: '/api/health' });
    responses.push(health);
    assert.deepEqual(health.json, { status: 'ok', mode: 'live', model: 'claude-opus-5-5' });

    const ok = await post(srv.port, TICKET);
    responses.push(ok);
    assert.equal(ok.json.source, 'model');
    assert.equal(ok.json.model, 'claude-opus-5-5');

    const expected = ['model_error', 'model_error', 'invalid_output'];
    for (const reason of expected) {
      const r = await post(srv.port, TICKET);
      responses.push(r);
      assert.equal(r.status, 200);
      assert.equal(r.json.source, 'fallback');
      assert.equal(r.json.fallbackReason, reason);
    }
    responses.push(...(await exercise(srv)).slice(2));

    assert.equal(fake.count, 5 /* 4 programmed + the default for exercise() */);
    for (const req of fake.requests) assert.equal(req.headers['x-api-key'], FAKE_KEY, 'the key is sent only to the configured endpoint');

    for (const r of responses) assertNoSecretsInResponse(r, [FAKE_KEY]);
    for (const r of responses.slice(1)) assert.ok(!r.body.includes(MARKER), 'marker echoed in a response');
    await srv.waitForLog((r) => r.event === 'request' && r.status === 403);
    assertCleanOutput(srv, [MARKER, FAKE_KEY, fake.url]);

    const reqs = srv.logs().filter((r) => r.event === 'request' && r.route === '/api/triage' && r.status === 200);
    assert.ok(reqs.some((r) => r.upstreamStatus === 401), 'upstream status is logged as metadata');
    for (const r of reqs) assert.equal(typeof r.ticketLength, 'number');
  } finally {
    await srv.stop();
    await fake.close();
  }
});
