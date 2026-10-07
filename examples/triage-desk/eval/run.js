'use strict';
// TriageDesk eval runner (spec §AI/LLM Design E1–E4, DES-2, DES-5, DES-9).
//
//   node eval/run.js [--split full|tune] [--provider fallback|live] [--dataset eval/dataset.json]
//                    [--holdout eval/holdout.json] [--thresholds eval/thresholds.json]
//                    [--results <file.json>] [--verbose]
//
// Full mode (default) is the only mode that prints ECCODE_EVAL {"passed":n,"total":m} (last line).
// Tune mode (`--split tune`, npm run eval:tune) never opens, stats or resolves --holdout, scores dataset.json only,
// never prints the substring ECCODE_EVAL and ends with TUNE_EVAL {"mode":"tune","passed":n,"total":m}.
// Exit codes: 0 every enforced check passed, 1 a check failed, 2 usage/file/dataset-format error (DES-9: the last
// line is then ECCODE_EVAL {"passed":0,"total":1} in full mode, TUNE_EVAL {"mode":"tune","passed":0,"total":1} in tune).
//
// The src/ execution modules are required lazily, only when rows are executed (DES-5); --results never loads them.
// The fallback path reads no environment variable (DES-1). Output carries ids and numbers only: never ticket text,
// summaries or replies.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const metricsLib = require('./metrics.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const DEFAULTS = { dataset: 'eval/dataset.json', holdout: 'eval/holdout.json', thresholds: 'eval/thresholds.json' };
const VALUE_FLAGS = ['split', 'provider', 'dataset', 'holdout', 'thresholds', 'results'];
const LIVE_ENV_NAMES = ['HOST', 'TRIAGE_ALLOW_REMOTE', 'PORT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'TRIAGE_ANTHROPIC_BASE_URL', 'TRIAGE_TIMEOUT_MS', 'TRIAGE_MAX_TOKENS'];
const USAGE = 'usage: node eval/run.js [--split full|tune] [--provider fallback|live] [--dataset <file>] [--holdout <file>] [--thresholds <file>] [--results <file>] [--verbose]';

class RunError extends Error {}          // exit 2; message is a complete, content-free output line
const fail = (line) => { throw new RunError(line); };

/** Pre-scan used only to choose the exit-2 last line when argument parsing itself fails. */
function looksLikeTune(argv) {
  return argv.some((a, i) => a === '--split=tune' || (a === '--split' && argv[i + 1] === 'tune'));
}

/** Parses argv without touching the filesystem or the path module (tune mode must not resolve --holdout). */
function parseArgs(argv) {
  const o = { split: 'full', provider: 'fallback', verbose: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verbose') { o.verbose = true; continue; }
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(a);
    if (!m || !VALUE_FLAGS.includes(m[1])) fail(`usage error: unknown argument ${JSON.stringify(a)}`);
    const name = m[1];
    let value = m[2];
    if (value === undefined) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail(`usage error: --${name} needs a value`);
      value = argv[i + 1];
      i += 1;
    }
    if (value === '') fail(`usage error: --${name} needs a value`);
    if (seen.has(name)) fail(`usage error: --${name} given twice`);
    seen.add(name);
    o[name] = value;
  }
  if (!['full', 'tune'].includes(o.split)) fail('usage error: --split must be full or tune');
  if (!['fallback', 'live'].includes(o.provider)) fail('usage error: --provider must be fallback or live');
  if (o.split === 'tune' && o.provider === 'live') fail('usage error: tune mode is fallback-only (--split tune --provider live is not allowed)');
  return o;
}

/** Resolves a user-given path against cwd; defaults resolve against the project root. */
function locate(given, key, cwd) {
  if (given === undefined) return { abs: path.join(PROJECT_ROOT, DEFAULTS[key]), label: DEFAULTS[key] };
  return { abs: path.resolve(cwd, given), label: given };
}

function readJson(file) {
  let buf;
  try {
    buf = fs.readFileSync(file.abs);
  } catch (e) {
    fail(`file error: ${file.label} ${e && e.code === 'ENOENT' ? 'file_missing' : 'unreadable'}`);
  }
  let doc;
  try {
    doc = JSON.parse(buf.toString('utf8'));
  } catch {
    fail(`file error: ${file.label} invalid_json`);
  }
  return { doc, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** Lazily requires one src module; a missing module is a clear exit-2 error (rules modules arrive in task 11). */
function loadSrc(srcRoot, rel) {
  const abs = path.join(srcRoot, rel);
  const shown = path.relative(PROJECT_ROOT, abs) || abs;
  try {
    return require(abs);
  } catch (e) {
    const code = e && e.code === 'MODULE_NOT_FOUND' ? 'MODULE_NOT_FOUND' : (e && e.name) || 'Error';
    fail(`error: cannot load ${shown} (${code}); executing rows needs the src/ triage modules (use --results <file> to score precomputed results)`);
  }
  return null;
}

function loadExecutionModules(srcRoot) {
  const { validateTicketInput } = loadSrc(srcRoot, 'ticket-input.js');
  const { createTriageService } = loadSrc(srcRoot, path.join('triage', 'service.js'));
  const { detectInjection } = loadSrc(srcRoot, path.join('triage', 'injection.js'));
  const { fallbackAnalyse } = loadSrc(srcRoot, path.join('triage', 'fallback-provider.js'));
  const { redact } = loadSrc(srcRoot, path.join('triage', 'redact.js'));
  for (const [n, f] of [['validateTicketInput', validateTicketInput], ['createTriageService', createTriageService],
    ['detectInjection', detectInjection], ['fallbackAnalyse', fallbackAnalyse], ['redact', redact]]) {
    if (typeof f !== 'function') fail(`error: src module does not export ${n}`);
  }
  return { validateTicketInput, createTriageService, detectInjection, fallbackAnalyse, redact };
}

/** Runs every row sequentially through `service.analyse`; returns id -> response and summed usage. */
async function executeRows(rows, service, validateTicketInput) {
  const byId = new Map();
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (const row of rows) {
    const input = validateTicketInput({ ticket: row.ticket });
    if (!input || input.ok !== true) fail(`dataset error: ${row._label} ${row.id} ticket_input_${(input && input.code) || 'invalid'}`);
    let result;
    try {
      result = await service.analyse(input.ticket);
    } catch (e) {
      fail(`error: row ${row.id} analyse threw ${(e && e.name) || 'Error'}`);
    }
    byId.set(row.id, result && result.response);
    const u = result && result.meta && result.meta.usage;
    if (u && Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens)) {
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
    }
  }
  return { byId, usage };
}

function readResults(file, rows, split) {
  const { doc, sha256 } = readJson(file);
  if (!doc || typeof doc !== 'object' || !['fallback', 'live'].includes(doc.provider) || !Array.isArray(doc.results)) {
    fail(`results error: ${file.label} - shape`);
  }
  if (split === 'tune' && doc.provider !== 'fallback') fail(`results error: ${file.label} - tune_mode_is_fallback_only`);
  const wanted = new Set(rows.map((r) => r.id));
  const byId = new Map();
  for (const [i, item] of doc.results.entries()) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') fail(`results error: ${file.label} #${i} shape`);
    if (!wanted.has(item.id)) continue; // tune mode: results for ids outside dataset.json are ignored
    if (byId.has(item.id)) fail(`results error: ${file.label} ${item.id} duplicate_result`);
    byId.set(item.id, item.response);
  }
  for (const r of rows) if (!byId.has(r.id)) fail(`results error: ${file.label} ${r.id} missing_result`);
  return { provider: doc.provider, byId, sha256 };
}

const f3 = (x) => x.toFixed(3);
const f2 = (x) => x.toFixed(2);
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const status = (l) => (l.pass === null ? 'INFO' : l.pass ? 'PASS' : 'FAIL');
const INJECTION_LINES = ['injection_leak', 'injection_steer', 'attack_success'];

function thresholdText(l) {
  if (l.field === null) return l.scope === 'attack' && !INJECTION_LINES.includes(l.name) ? 'info' : 'reported';
  if (l.field === 'maxFailures') return String(l.bound);
  if (l.field === 'min' || l.field === 'holdoutMin') return `>=${f2(l.bound)}`;
  return `<=${f2(l.bound)}`;
}

function formatLine(l, split) {
  const scope = split === 'tune' && l.scope === 'all' ? 'tune' : l.scope;
  if (INJECTION_LINES.includes(l.name)) {
    let s = `INJECTION ${l.name} ${l.k} failures in ${l.n}`;
    if (l.field === 'maxRate' && l.n > 0) s += ` (rate ${f3(l.k / l.n)})`;
    if (l.k === 0 && l.n > 0) s += ` (95% upper bound ~3/N = ${((3 / l.n) * 100).toFixed(1)}%)`;
    return `${s} threshold=${thresholdText(l)} ${status(l)}`;
  }
  if (l.name === 'truncated_count') return `COUNT truncated ${l.k} in ${l.n} threshold=reported INFO`;
  const value = l.n > 0 ? f3(l.k / l.n) : 'n/a';
  return `METRIC ${l.name} scope=${scope} value=${value} n=${l.n} threshold=${thresholdText(l)} ${status(l)}`;
}

/**
 * @param {string[]} argv
 * @param {{out?:(line:string)=>void, srcRoot?:string, cwd?:string}} [opts]  srcRoot/cwd are test seams
 * @returns {Promise<0|1|2>}
 */
async function main(argv, opts = {}) {
  const rawOut = opts.out || ((line) => process.stdout.write(`${line}\n`));
  let tune = looksLikeTune(argv);
  // Tune mode must never print the substring ECCODE_EVAL (DES-2), not even inside an echoed path or argument.
  const out = (line) => rawOut(tune ? String(line).replace(/ECCODE_EVAL/g, 'ECCODE-EVAL') : String(line));
  try {
    const o = parseArgs(argv);
    tune = o.split === 'tune';
    const code = await run(o, out, opts.srcRoot || DEFAULT_SRC_ROOT, opts.cwd || process.cwd());
    return code;
  } catch (e) {
    if (e instanceof RunError) {
      out(e.message);
      if (e.message.startsWith('usage error')) out(USAGE);
    } else {
      out(`error: internal ${(e && e.name) || 'Error'}`);
    }
    if (tune) rawOut('TUNE_EVAL {"mode":"tune","passed":0,"total":1}');
    else rawOut('ECCODE_EVAL {"passed":0,"total":1}');
    return 2;
  }
}

async function run(o, out, srcRoot, cwd) {
  const tune = o.split === 'tune';
  const datasetFile = locate(o.dataset, 'dataset', cwd);
  const thresholdsFile = locate(o.thresholds, 'thresholds', cwd);
  // Tune mode: o.holdout is never passed to fs or path (DES-2).
  const holdoutFile = tune ? null : locate(o.holdout, 'holdout', cwd);

  const ds = readJson(datasetFile);
  const ho = tune ? null : readJson(holdoutFile);
  const th = readJson(thresholdsFile);

  const files = [{ label: datasetFile.label, kind: 'dataset', doc: ds.doc }];
  if (!tune) files.push({ label: holdoutFile.label, kind: 'holdout', doc: ho.doc });
  const dsErrors = metricsLib.checkDataset(files);
  const thErrors = metricsLib.checkThresholds(th.doc).map((rule) => `dataset error: ${thresholdsFile.label} - ${rule}`);
  const allErrors = [...dsErrors, ...thErrors];
  if (allErrors.length > 0) {
    allErrors.slice(0, -1).forEach((l) => out(l));
    fail(allErrors[allErrors.length - 1]);
  }
  const rows = [];
  for (const f of files) for (const r of f.doc.rows) rows.push({ ...r, _file: f.kind, _label: f.label });

  // Obtain responses: precomputed (--results) or executed.
  let provider = 'fallback';
  let byId;
  let usage = null;
  let liveNotRun = false;
  let modelId = null;
  let resultsInfo = null;
  if (o.results !== undefined) {
    const resultsFile = locate(o.results, 'results', cwd);
    const res = readResults(resultsFile, rows, o.split);
    provider = res.provider;
    byId = res.byId;
    resultsInfo = { label: resultsFile.label, sha256: res.sha256 };
  } else {
    const mods = loadExecutionModules(srcRoot);
    let service = null;
    if (o.provider === 'live') {
      // Live path only: pick the C6.1 names out of process.env (never the whole object).
      const env = {};
      for (const name of LIVE_ENV_NAMES) if (typeof process.env[name] === 'string') env[name] = process.env[name];
      if (!env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY.trim() === '') {
        liveNotRun = true;
      } else {
        const { buildApp } = loadSrc(srcRoot, 'app.js');
        const { createLogger } = loadSrc(srcRoot, 'log.js');
        let app;
        try {
          app = buildApp({ env, log: createLogger(() => {}) });
        } catch (e) {
          fail(`error: configuration invalid (${(e && e.name) || 'Error'}${e && e.name === 'ConfigError' ? `: ${e.message}` : ''})`);
        }
        service = app.service;
        if (service.mode !== 'live') fail('error: --provider live built a non-live service');
        provider = 'live';
        modelId = service.model;
      }
    }
    if (service === null) {
      // Exactly the fallback-mode wiring of app.js (C6.4/C6.5); reads no environment variable.
      service = mods.createTriageService({ provider: null, detectInjection: mods.detectInjection, fallbackAnalyse: mods.fallbackAnalyse, redact: mods.redact });
    }
    const exec = await executeRows(rows, service, mods.validateTicketInput);
    byId = exec.byId;
    if (provider === 'live') usage = exec.usage;
  }

  // Header (E4).
  out(`dataset ${datasetFile.label} sha256 ${ds.sha256}`);
  if (!tune) out(`holdout ${holdoutFile.label} sha256 ${ho.sha256}`);
  out(`thresholds ${thresholdsFile.label} sha256 ${th.sha256}`);
  if (resultsInfo) out(`results ${resultsInfo.label} sha256 ${resultsInfo.sha256} (precomputed, rows not executed)`);
  out(provider === 'live'
    ? `provider live (${modelId ? `model ${modelId}` : 'precomputed model results'}; AI model output)`
    : 'provider fallback (deterministic rules; NOT evidence of model quality)');
  const counts = metricsLib.datasetCounts(rows);
  const benign = rows.filter((r) => r.split !== 'attack');
  if (tune) {
    out('holdout: NOT SCORED (tune mode)');
    out(`rows tune=${benign.length} attack=${counts.attackRows} instructionLike=${counts.instructionLikeBenign}`);
    out('CHECK datasetMinimums NOT CHECKED (tune mode)');
  } else {
    out(`rows benign=${benign.length} attack=${counts.attackRows} (in-family=${counts.inFamilyRows} held-out=${counts.heldOutRows}) holdout=${counts.holdoutRows} instructionLike=${counts.instructionLikeBenign}`);
  }

  const computed = metricsLib.computeMetrics(rows, byId, { live: provider === 'live' });
  const { minimums, lines } = metricsLib.buildChecks({ mode: o.split, section: provider, thresholds: th.doc, metrics: computed, counts });
  for (const c of minimums) out(`CHECK min_${snake(c.key)} value=${c.value} threshold=>=${c.bound} ${c.pass ? 'PASS' : 'FAIL'}`);
  for (const l of lines) {
    out(formatLine(l, o.split));
    if (o.verbose && l.pass === false && l.ids.length > 0) {
      out(`FAILED_ROWS ${l.name} scope=${tune && l.scope === 'all' ? 'tune' : l.scope} ids=${l.ids.join(',')}`);
    }
  }
  if (liveNotRun) out('live: NOT RUN (no ANTHROPIC_API_KEY)');
  if (usage) out(`USAGE input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens}`);

  const enforced = [...minimums.map((c) => c.pass), ...lines.filter((l) => l.pass !== null).map((l) => l.pass)];
  const total = enforced.length;
  const passed = enforced.filter(Boolean).length;
  const ok = total > 0 && passed === total;
  if (tune) {
    out(`RESULT TUNE-ONLY ${ok ? 'PASS' : 'FAIL'} ${passed}/${total} tune checks passed (not a verification result)`);
    out(`TUNE_EVAL ${JSON.stringify({ mode: 'tune', passed, total })}`);
  } else {
    out(`RESULT ${ok ? 'PASS' : 'FAIL'} ${passed}/${total} enforced checks passed`);
    out(`ECCODE_EVAL ${JSON.stringify({ passed, total })}`);
  }
  return ok ? 0 : 1;
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
