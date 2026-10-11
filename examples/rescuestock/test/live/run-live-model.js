// Opt-in live model suite (LIVE-M1): runs EXT-1 against the REAL model and is billed to the user's account.
//
//   RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model            (CLI login, default)
//   RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 RS_MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run test:live-model
//   ... npm run test:live-model -- --dry-run      prints what the run would spend and exits 0 without a model call
//
// It refuses (exit 2) unless RS_LIVE_MODEL=1 AND RS_LIVE_MODEL_CEILING_USD is an exact decimal amount from 0.01 to 5.00 with at
// most two decimal places (the recorded ceiling, decision dec-mv16pz0g-01d5c4c2; nothing is rounded: 5.0000001 is refused), and
// never runs under the offline network guard or with RS_TEST_OFFLINE=1. Before its first model call it prints the provider,
// the model, the CLI version, the per-call cap, the worst-case total and the ceiling; it runs the cli-image-smoke case first
// (the first assertion is schemaAccepted, F-TR-13), stops before any call that could push the total past the ceiling, and
// writes reports/live-model-<UTC>.json. Exit 1 on any threshold miss, a skipped case or a failed smoke assertion. SIGINT and
// SIGTERM close the model adapter (ending its CLI children), write no report and exit 130 / 143 (TR-D-9, SEC-D-2).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toMicroUsd } from '../../src/ai/gate.js';
import { PROMPT_VERSION } from '../../src/ai/prompt.js';
import { loadCorpus } from '../eval/lib/corpus.js';
import { THRESHOLDS, computeMetrics, judge, runCases, totalCostMicroUsd } from '../eval/lib/metrics.js';

export const LIVE_CEILING_MAX_MICRO_USD = 5_000_000; // dec-mv16pz0g-01d5c4c2: USD 5 per live run
export const LIVE_MESSAGES = Object.freeze({
  notEnabled: 'Set RS_LIVE_MODEL=1 to run the live model suite (billed to your account)',
  noCeiling: 'Set RS_LIVE_MODEL_CEILING_USD to the most you are willing to spend on this run (a positive amount of at most 5.00)',
  badCeiling: 'RS_LIVE_MODEL_CEILING_USD must be a positive decimal amount of at most 5.00 (the recorded ceiling), with at most two decimal places, e.g. 0.50 or 5',
  netGuard: 'The live model suite must not run under the offline network guard; run it with npm run test:live-model',
  offline: 'The live model suite must not run with RS_TEST_OFFLINE=1',
  fakeProvider: 'The live model suite needs RS_MODEL_PROVIDER=cli or anthropic, not fake',
});

const GUARD_KEY = Symbol.for('rescuestock.netGuard');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INTERRUPT_SIGNALS = Object.freeze([['SIGINT', 130], ['SIGTERM', 143]]); // 128 + the signal number
const usd = (micro) => `$${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`;

// TR-D-10: a spend limit typed by a person is never reinterpreted. Only a plain decimal with no sign, no exponent, no
// whitespace, no leading zero and at most two fraction digits is accepted, and it is compared in integer cents BEFORE any
// conversion to micro-dollars, so 5.0000001 (which rounded to 5.00 before) is refused, as are 5.001, 1e0, " 5" and "05".
const CEILING_PATTERN = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/;

/** "0.50" -> 500000 (micro-dollars); null for anything that is not an exact amount from 0.01 to 5.00 with two decimals at most. */
export function parseCeilingMicroUsd(raw) {
  if (typeof raw !== 'string') return null;
  const m = CEILING_PATTERN.exec(raw);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (cents < 1 || cents * 10_000 > LIVE_CEILING_MAX_MICRO_USD) return null;
  return cents * 10_000;
}

/** -> { ok: true, ceilingMicroUsd } | { ok: false, message }; the order of the checks is part of the contract. */
export function evaluateLaunch(env, { guardInstalled = Boolean(globalThis[GUARD_KEY]) } = {}) {
  if (env.RS_LIVE_MODEL !== '1') return { ok: false, message: LIVE_MESSAGES.notEnabled };
  const raw = env.RS_LIVE_MODEL_CEILING_USD;
  if (raw === undefined || raw === '') return { ok: false, message: LIVE_MESSAGES.noCeiling };
  const ceilingMicroUsd = parseCeilingMicroUsd(raw);
  if (ceilingMicroUsd === null) return { ok: false, message: LIVE_MESSAGES.badCeiling };
  if (guardInstalled) return { ok: false, message: LIVE_MESSAGES.netGuard };
  if (env.RS_TEST_OFFLINE === '1') return { ok: false, message: LIVE_MESSAGES.offline };
  return { ok: true, ceilingMicroUsd };
}

/** What a run could cost at most: every case at the per-call cap. */
export function planSpend({ caseCount, capMicroUsd, ceilingMicroUsd }) {
  const worstCaseMicroUsd = caseCount * capMicroUsd;
  return { calls: caseCount, capMicroUsd, worstCaseMicroUsd, ceilingMicroUsd, wouldStopEarly: worstCaseMicroUsd > ceilingMicroUsd };
}

function defaultProviderFactory(config, capMicroUsd) {
  if (config.modelProvider === 'fake') throw new Error(LIVE_MESSAGES.fakeProvider);
  if (config.modelProvider === 'anthropic') {
    return import('../../src/ai/anthropic.js').then(({ createAnthropicProvider }) => createAnthropicProvider({
      apiKey: config.anthropicApiKey,
      baseUrl: config.anthropicBaseUrl,
      model: config.anthropicModel,
      timeoutMs: config.modelTimeoutMs,
      usdPerMtokIn: config.anthropicUsdPerMtokIn,
      usdPerMtokOut: config.anthropicUsdPerMtokOut,
    }));
  }
  return import('../../src/ai/cli.js').then(({ createCliProvider }) => createCliProvider({
    model: config.model, timeoutMs: config.modelTimeoutMs, callCapMicroUsd: capMicroUsd,
  }));
}

/**
 * runLive({ env, argv, out, err, guardInstalled, providerFactory, reportDir, now, signalTarget, exit }) -> exit code
 * The injectable parts exist for the unit tests; the entry point below passes the real process.
 *   signalTarget  where SIGINT/SIGTERM are listened for (default process)
 *   exit          called with 130 / 143 after the adapter was closed on a signal (default process.exit)
 */
export async function runLive({
  env = process.env, argv = process.argv.slice(2), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s),
  guardInstalled = Boolean(globalThis[GUARD_KEY]), providerFactory = defaultProviderFactory, reportDir = join(ROOT, 'reports'), now = () => new Date(),
  signalTarget = process, exit = (code) => process.exit(code),
} = {}) {
  const launch = evaluateLaunch(env, { guardInstalled });
  if (!launch.ok) {
    err(`${launch.message}\n`);
    return 2;
  }

  let config;
  try {
    const { loadConfig } = await import('../../src/config.js');
    config = loadConfig(env);
  } catch (e) {
    err(`Configuration refused: ${e?.variables ? e.variables.join(', ') : 'invalid environment'}\n`);
    return 2;
  }
  if (config.testOffline) {
    err(`${LIVE_MESSAGES.offline}\n`);
    return 2;
  }
  const capMicroUsd = Number.isSafeInteger(config.modelCallCapMicroUsd) ? config.modelCallCapMicroUsd : toMicroUsd(config.modelCallCapUsd);
  const { manifest, cases } = loadCorpus();
  const plan = planSpend({ caseCount: cases.length, capMicroUsd, ceilingMicroUsd: launch.ceilingMicroUsd });
  const model = config.modelProvider === 'anthropic' ? config.anthropicModel : config.model;

  out('Live model suite (billed to your account)\n');
  out(`  provider: ${config.modelProvider}   model: ${model}\n`);
  out(`  corpus: ${manifest.corpusVersion} (${cases.length} cases), prompt ${PROMPT_VERSION}\n`);
  out(`  per-call cap: ${usd(capMicroUsd)}   worst case for ${plan.calls} calls: ${usd(plan.worstCaseMicroUsd)}   ceiling: ${usd(plan.ceilingMicroUsd)}\n`);
  out(`  would spend at most ${usd(Math.min(plan.worstCaseMicroUsd, plan.ceilingMicroUsd))}; the run stops before any call that could push the total past the ceiling\n`);
  if (argv.includes('--dry-run')) {
    out('  dry run: no model call was made\n');
    return 0;
  }

  let provider;
  try {
    provider = await providerFactory(config, capMicroUsd);
  } catch (e) {
    err(`${e?.message ?? 'The model provider could not be created'}\n`);
    return 2;
  }

  // TR-D-9 / SEC-D-2: from here on a model call can be in flight. SIGINT and SIGTERM close the adapter (which ends its CLI
  // children and their process groups), say that the run was interrupted, write no report and exit non-zero (128 + signal);
  // a normal end or any other return path closes the adapter too.
  let interrupt;
  const interrupted = new Promise((resolve) => { interrupt = resolve; });
  let closing = null;
  const closeProvider = () => {
    closing ??= Promise.resolve().then(() => provider.close?.()).catch(() => {});
    return closing;
  };
  const handlers = INTERRUPT_SIGNALS.map(([name, exitCode]) => {
    const handler = () => {
      err(`  interrupted by ${name}: closing the model adapter; no report is written\n`);
      closeProvider().then(() => {
        interrupt(exitCode);
        exit(exitCode);
      });
    };
    signalTarget.on(name, handler);
    return [name, handler];
  });

  try {
    let cliVersion = null;
    if (provider.id === 'cli') {
      const version = await Promise.race([import('../../src/ai/cli.js').then((m) => m.cliVersion()), interrupted]);
      if (typeof version === 'number') return version;
      cliVersion = version;
      out(`  cli: ${version ? `claude ${version}` : 'version unknown'}\n`); // printed before the first model call
    }

    const started = now();
    const results = await Promise.race([runCases(provider, cases, { ceilingMicroUsd: plan.ceilingMicroUsd, capMicroUsd }), interrupted]);
    if (typeof results === 'number') return results;
    const metrics = computeMetrics(cases, results);
    const verdicts = judge(metrics);
    const smoke = results.get('cli-image-smoke');
    const schemaAccepted = smoke?.ok === true && smoke.meta?.schemaAccepted === true;
    const skipped = [...results.entries()].filter(([, r]) => r.skipped).map(([id, r]) => `${id}:${r.reason}`);
    const costMicroUsd = totalCostMicroUsd(results);
    const pass = schemaAccepted && skipped.length === 0 && verdicts.every((v) => v.pass) && costMicroUsd <= plan.ceilingMicroUsd;

    const report = {
      suite: 'live-model',
      provider: provider.id,
      simulated: provider.simulated === true,
      model: provider.model,
      cliVersion,
      corpusVersion: manifest.corpusVersion,
      promptVersion: PROMPT_VERSION,
      startedAt: started.toISOString(),
      schemaAccepted,
      ceilingMicroUsd: plan.ceilingMicroUsd,
      costMicroUsd,
      skipped,
      thresholds: Object.fromEntries(Object.entries(THRESHOLDS).map(([k, t]) => [k, { kind: t.kind, value: t.value }])),
      metrics: Object.fromEntries(verdicts.map((v) => [v.name, { value: v.value, pass: v.pass, detail: metrics[v.name].detail }])),
      cases: cases.map((c) => {
        const r = results.get(c.id);
        return {
          id: c.id,
          status: r.skipped ? `skipped:${r.reason}` : r.ok ? 'ok' : `error:${r.errorCode}`,
          costMicroUsd: r.usage?.costMicroUsd ?? 0,
          output: r.ok ? r.output : null,
        };
      }),
      pass,
    };
    mkdirSync(reportDir, { recursive: true });
    const file = join(reportDir, `live-model-${started.toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

    out(`  schemaAccepted: ${schemaAccepted}\n`);
    for (const v of verdicts) out(`  ${v.pass ? 'PASS' : 'FAIL'} ${v.name}: ${v.value} (${v.kind} ${v.threshold})\n`);
    out(`  cost: ${usd(costMicroUsd)} of ${usd(plan.ceilingMicroUsd)}   report: ${file}\n`);
    out(pass ? '  result: all thresholds met\n' : '  result: NOT passed (see the report)\n');
    return pass ? 0 : 1;
  } finally {
    for (const [name, handler] of handlers) signalTarget.off(name, handler);
    await closeProvider();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLive().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`live model suite failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}
