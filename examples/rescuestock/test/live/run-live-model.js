// Opt-in live model suite (LIVE-M1): runs EXT-1 against the REAL model and is billed to the user's account.
//
//   RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 npm run test:live-model            (CLI login, default)
//   RS_LIVE_MODEL=1 RS_LIVE_MODEL_CEILING_USD=5 RS_MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run test:live-model
//   ... npm run test:live-model -- --dry-run      prints what the run would spend and exits 0 without a model call
//
// It refuses (exit 2) unless RS_LIVE_MODEL=1 AND RS_LIVE_MODEL_CEILING_USD is a positive amount of at most USD 5 (the
// recorded ceiling, decision dec-mv16pz0g-01d5c4c2), and never runs under the offline network guard or with
// RS_TEST_OFFLINE=1. It prints the worst-case spend first, runs the cli-image-smoke case first (the first assertion is
// schemaAccepted, F-TR-13), stops before any call that could push the total past the ceiling, and writes
// reports/live-model-<UTC>.json. Exit 1 on any threshold miss, a skipped case or a failed smoke assertion.
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
  badCeiling: 'RS_LIVE_MODEL_CEILING_USD must be a positive decimal amount of at most 5.00 (the recorded ceiling)',
  netGuard: 'The live model suite must not run under the offline network guard; run it with npm run test:live-model',
  offline: 'The live model suite must not run with RS_TEST_OFFLINE=1',
  fakeProvider: 'The live model suite needs RS_MODEL_PROVIDER=cli or anthropic, not fake',
});

const GUARD_KEY = Symbol.for('rescuestock.netGuard');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const usd = (micro) => `$${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`;

/** -> { ok: true, ceilingMicroUsd } | { ok: false, message }; the order of the checks is part of the contract. */
export function evaluateLaunch(env, { guardInstalled = Boolean(globalThis[GUARD_KEY]) } = {}) {
  if (env.RS_LIVE_MODEL !== '1') return { ok: false, message: LIVE_MESSAGES.notEnabled };
  const raw = env.RS_LIVE_MODEL_CEILING_USD;
  if (raw === undefined || raw === '') return { ok: false, message: LIVE_MESSAGES.noCeiling };
  let ceilingMicroUsd;
  try {
    ceilingMicroUsd = toMicroUsd(raw);
  } catch {
    return { ok: false, message: LIVE_MESSAGES.badCeiling };
  }
  if (ceilingMicroUsd <= 0 || ceilingMicroUsd > LIVE_CEILING_MAX_MICRO_USD) return { ok: false, message: LIVE_MESSAGES.badCeiling };
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
 * runLive({ env, argv, out, err, guardInstalled, providerFactory, reportDir, now }) -> exit code
 * The injectable parts exist for the unit tests; the entry point below passes the real process.
 */
export async function runLive({
  env = process.env, argv = process.argv.slice(2), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s),
  guardInstalled = Boolean(globalThis[GUARD_KEY]), providerFactory = defaultProviderFactory, reportDir = join(ROOT, 'reports'), now = () => new Date(),
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
  let cliVersion = null;
  if (provider.id === 'cli') cliVersion = await (await import('../../src/ai/cli.js')).cliVersion();

  const started = now();
  const results = await runCases(provider, cases, { ceilingMicroUsd: plan.ceilingMicroUsd, capMicroUsd });
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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLive().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`live model suite failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}
