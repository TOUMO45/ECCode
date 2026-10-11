// ExtractionProvider contract suite (Testing Strategy, contract tests (c); plan task d5-extraction-contract-browser).
// ONE suite, run against three implementations of src/ai/provider.js:
//   fake       the deterministic simulated provider (faults injected through its faults() callback);
//   cli        the Claude CLI adapter against a stub `claude` binary that replays the recorded transcript;
//   anthropic  the Anthropic API adapter against a loopback stub of POST /v1/messages.
// Per implementation: the validated output, the usage fields, and each ProviderError code (PROVIDER_TIMEOUT,
// PROVIDER_UNAVAILABLE, PROVIDER_BAD_OUTPUT, PROVIDER_BUSY), with the rule that an error never carries the provider's body,
// the buyer's text or a key. No model is called; every result proves the adapters' mapping, not model quality.
// A code an implementation cannot produce is reported as SKIPPED with the reason, never as passed.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider } from '../../../src/ai/anthropic.js';
import { createCliProvider } from '../../../src/ai/cli.js';
import { createFakeProvider } from '../../../src/ai/fake.js';
import { PROVIDER_ERROR_CODES, assertExtractionProvider, errorCodeOf, isProviderError, toDegraded } from '../../../src/ai/provider.js';
import { validateExtraction } from '../../../src/ai/schema.js';
import { CONTRACT_CORE, CONTRACT_TEXT } from '../../eval/lib/provider-contract.js';
import { PROVIDER_BODY_MARKER, createCliStubRoot, okMessage, startAnthropicStub } from '../../helpers/provider-stubs.js';

const KEY = 'contract-suite-key-not-a-secret';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const NO_SLEEP = async () => {};

// ---- the three implementations ---------------------------------------------------------------------------------------------
// Each defines: name, expectSimulated, text(scenario), provider(scenario) -> { call(extra) -> Promise, leaks: string[] }.
// Scenarios: ok | timeout | unavailable | bad_output | busy. `busy` returns null when the implementation cannot produce it.

const cliRoot = createCliStubRoot();
let anthropic;

function fakeImpl() {
  const faults = { timeout: 'timeout', unavailable: 'error', bad_output: 'schema_invalid' };
  return {
    name: 'fake',
    expectSimulated: true,
    // The fake never sees a provider body; the buyer's text carries the marker, and an error must not echo it.
    text: (scenario) => (scenario === 'ok' ? CONTRACT_TEXT : `${CONTRACT_TEXT} ${PROVIDER_BODY_MARKER}`),
    provider(scenario) {
      if (scenario === 'busy') return null;
      const provider = createFakeProvider({ costMicroUsd: 1500, faults: () => faults[scenario] ?? null, sleep: NO_SLEEP });
      return { provider, leaks: [PROVIDER_BODY_MARKER] };
    },
  };
}

function cliImpl() {
  const modes = { ok: 'transcript', timeout: 'hang', unavailable: 'exit1', bad_output: 'prose', busy: 'slow' };
  return {
    name: 'cli',
    expectSimulated: false,
    text: () => CONTRACT_TEXT,
    provider(scenario) {
      const sb = cliRoot.sandbox(modes[scenario]);
      const provider = createCliProvider({ env: sb.env, tmpRoot: sb.tmp, callCapMicroUsd: 50_000, timeoutMs: scenario === 'timeout' ? 300 : 20_000 });
      // stderr of the stub ("boom /secret/path") and its prose answer are provider output.
      return { provider, leaks: ['boom', '/secret/path', 'Sorry, I could not produce', sb.dir] };
    },
    // The adapter allows two calls at once; the third is refused without starting a process.
    async busy(provider, call) {
      const first = call();
      const second = call();
      try {
        return await call();
      } finally {
        await Promise.all([first, second]);
      }
    },
  };
}

function anthropicImpl() {
  const replies = {
    ok: [],
    timeout: [{ status: 200, json: okMessage(), delayMs: 3000 }],
    unavailable: [{ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: PROVIDER_BODY_MARKER } } }],
    bad_output: [{ status: 200, json: okMessage(`not json ${PROVIDER_BODY_MARKER}`) }],
    busy: [{ status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: PROVIDER_BODY_MARKER } } }],
  };
  return {
    name: 'anthropic',
    expectSimulated: false,
    text: () => CONTRACT_TEXT,
    provider(scenario) {
      anthropic.reset();
      anthropic.queue(...replies[scenario]);
      const provider = createAnthropicProvider({ apiKey: KEY, baseUrl: anthropic.baseUrl, allowLoopback: true, timeoutMs: scenario === 'timeout' ? 150 : 5000 });
      return { provider, leaks: [PROVIDER_BODY_MARKER, KEY] };
    },
  };
}

before(async () => {
  anthropic = await startAnthropicStub();
});
after(async () => {
  await anthropic.close();
  cliRoot.cleanup();
});

// ---- shared helpers --------------------------------------------------------------------------------------------------------

const extractArgs = (impl, scenario, extra = {}) => ({ text: impl.text(scenario), image: null, signal: new AbortController().signal, ...extra });

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return assert.fail('expected the call to reject');
}

function assertUsage(usage) {
  assert.equal(typeof usage.model, 'string');
  assert.ok(usage.model.length > 0, 'usage.model');
  assert.ok(Number.isSafeInteger(usage.costMicroUsd) && usage.costMicroUsd >= 0, 'usage.costMicroUsd is an integer number of micro-dollars');
  assert.equal(typeof usage.costUsd, 'number');
  assert.ok(Math.abs(usage.costUsd - usage.costMicroUsd / 1_000_000) < 1e-9, 'usage.costUsd is the same amount as costMicroUsd');
  assert.ok(Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0, 'usage.inputTokens');
  assert.ok(Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0, 'usage.outputTokens');
  assert.ok(Number.isFinite(usage.latencyMs) && usage.latencyMs >= 0, 'usage.latencyMs');
}

// A ProviderError is the only failure of a provider: the right code, a fixed message that echoes nothing from the provider,
// the buyer or the configuration, and usage (when present) in the same shape as a success.
function assertProviderError(err, code, leaks) {
  assert.ok(isProviderError(err), `not a ProviderError: ${err?.stack}`);
  assert.equal(err.name, 'ProviderError');
  assert.equal(err.code, code);
  assert.equal(errorCodeOf(err), code);
  assert.ok(PROVIDER_ERROR_CODES.includes(err.code));
  assert.match(err.message, /^[A-Z][A-Za-z ]{5,60}\.$/, 'fixed sentence, no data');
  const visible = [err.message, String(err), JSON.stringify(err), err.stack ?? ''].join('\n');
  for (const leak of leaks) assert.equal(visible.includes(leak), false, `the error exposes ${JSON.stringify(leak)}`);
  if (err.usage !== undefined) assertUsage(err.usage);
  const degraded = toDegraded(err);
  assert.deepEqual([degraded.schemaOk, degraded.degraded, degraded.errorCode], [false, true, code], 'toDegraded maps the error to the degraded result (RS-03)');
}

const SCENARIO_CODES = Object.freeze([
  ['timeout', 'PROVIDER_TIMEOUT'],
  ['unavailable', 'PROVIDER_UNAVAILABLE'],
  ['bad_output', 'PROVIDER_BAD_OUTPUT'],
  ['busy', 'PROVIDER_BUSY'],
]);

// ---- the one suite ---------------------------------------------------------------------------------------------------------

for (const make of [fakeImpl, cliImpl, anthropicImpl]) {
  const impl = make();
  describe(`ExtractionProvider contract: ${impl.name}`, () => {
    test(`RS-01: ${impl.name} is an ExtractionProvider (id, simulated flag, model name, extract function)`, () => {
      const { provider } = impl.provider('ok');
      assertExtractionProvider(provider);
      assert.equal(provider.id, impl.name);
      assert.equal(provider.simulated, impl.expectSimulated, 'only the fake is labelled simulated');
      assert.equal(typeof provider.model, 'string');
    });

    test(`RS-01: ${impl.name} returns output that passes validateExtraction and carries the RS-FIX-1 core values`, async () => {
      const { provider, leaks } = impl.provider('ok');
      const result = await provider.extract(extractArgs(impl, 'ok'));
      assert.deepEqual(Object.keys(result).filter((k) => k === 'output' || k === 'usage').sort(), ['output', 'usage']);
      const check = validateExtraction(result.output, { text: CONTRACT_TEXT });
      assert.equal(check.ok, true, JSON.stringify(check.errors));
      for (const [name, value] of Object.entries(CONTRACT_CORE)) assert.equal(result.output.fields[name].value, value, name);
      assert.equal(result.output.fields.productType.provenance, 'user_text');
      assert.equal(result.output.addressedToAssistant, false);
      const shown = JSON.stringify(result);
      for (const leak of leaks) assert.equal(shown.includes(leak), false, `the result exposes ${JSON.stringify(leak)}`);
    });

    test(`NFR6: ${impl.name} reports usage: model, costUsd and integer costMicroUsd, token counts, latency`, async () => {
      const { provider } = impl.provider('ok');
      const { usage } = await provider.extract(extractArgs(impl, 'ok'));
      assertUsage(usage);
    });

    test(`RS-02: ${impl.name} accepts a package photo with the text and still returns valid output`, async () => {
      const { provider } = impl.provider('ok');
      const { output } = await provider.extract(extractArgs(impl, 'ok', { image: { bytes: PNG, mime: 'image/png' } }));
      const check = validateExtraction(output, { text: CONTRACT_TEXT });
      assert.equal(check.ok, true, JSON.stringify(check.errors));
    });

    test(`RS-03: ${impl.name} rejects with PROVIDER_TIMEOUT when the caller has already aborted`, async () => {
      const { provider, leaks } = impl.provider('ok');
      const aborted = new AbortController();
      aborted.abort();
      assertProviderError(await rejection(provider.extract(extractArgs(impl, 'ok', { signal: aborted.signal }))), 'PROVIDER_TIMEOUT', leaks);
    });

    for (const [scenario, code] of SCENARIO_CODES) {
      test(`RS-03: ${impl.name} maps ${scenario.replace('_', ' ')} to ${code} without echoing the provider body, the buyer text or a key`, async (t) => {
        const arranged = impl.provider(scenario);
        if (arranged === null) {
          t.skip(`the ${impl.name} provider has no busy fault (FAKE_FAULTS: timeout, invalid_json, schema_invalid, error); ${code} is covered for cli and anthropic here and, as a gate refusal, in test/api/extract-degraded.test.js`);
          return;
        }
        const { provider, leaks } = arranged;
        const call = () => provider.extract(extractArgs(impl, scenario));
        const err = await rejection(impl.busy && scenario === 'busy' ? impl.busy(provider, call) : call());
        assertProviderError(err, code, leaks);
      });
    }

    test(`RS-03: ${impl.name} stays usable after every failure (no slot, process or reservation is left behind)`, async () => {
      for (const [scenario] of SCENARIO_CODES) {
        const arranged = impl.provider(scenario);
        if (arranged === null) continue;
        const call = () => arranged.provider.extract(extractArgs(impl, scenario));
        await rejection(impl.busy && scenario === 'busy' ? impl.busy(arranged.provider, call) : call());
      }
      // A fresh provider of the same kind answers normally; for the CLI the concurrency slots of the busy case are free again.
      const { provider } = impl.provider('ok');
      const { output } = await provider.extract(extractArgs(impl, 'ok'));
      assert.equal(output.fields.cupQuantity.value, 200);
    });
  });
}

describe('ExtractionProvider contract: the error type', () => {
  test('RS-03: the four codes are exactly the set the spec names, and an unknown code cannot be built', async () => {
    assert.deepEqual([...PROVIDER_ERROR_CODES], ['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_BAD_OUTPUT', 'PROVIDER_BUSY']);
    const { ProviderError } = await import('../../../src/ai/provider.js');
    assert.throws(() => new ProviderError('PROVIDER_ON_FIRE'), TypeError);
    assert.equal(errorCodeOf(new Error('anything else')), 'PROVIDER_UNAVAILABLE', 'an unexpected error is PROVIDER_UNAVAILABLE');
  });
});

describe('ExtractionProvider contract: the checks themselves fail when they should (negative controls)', () => {
  test('RS-03: an error that echoes provider output, or carries the wrong code, is refused by the shared checks', async () => {
    const { ProviderError } = await import('../../../src/ai/provider.js');
    const echoing = new ProviderError('PROVIDER_BUSY');
    echoing.message = `The model is busy. ${PROVIDER_BODY_MARKER}`;
    assert.throws(() => assertProviderError(echoing, 'PROVIDER_BUSY', [PROVIDER_BODY_MARKER]));
    assert.throws(() => assertProviderError(new ProviderError('PROVIDER_BUSY'), 'PROVIDER_TIMEOUT', []));
    assert.throws(() => assertProviderError(new Error('plain'), 'PROVIDER_UNAVAILABLE', []));
    assert.doesNotThrow(() => assertProviderError(new ProviderError('PROVIDER_BUSY'), 'PROVIDER_BUSY', [PROVIDER_BODY_MARKER]));
  });

  test('NFR6: usage with a fractional micro-dollar cost, a missing model or a negative latency is refused', () => {
    const good = { model: 'm', costUsd: 0.0015, costMicroUsd: 1500, inputTokens: 1, outputTokens: 1, latencyMs: 0 };
    assert.doesNotThrow(() => assertUsage(good));
    assert.throws(() => assertUsage({ ...good, costMicroUsd: 1500.5 }));
    assert.throws(() => assertUsage({ ...good, costUsd: 0.002 }));
    assert.throws(() => assertUsage({ ...good, model: '' }));
    assert.throws(() => assertUsage({ ...good, latencyMs: -1 }));
  });
});
