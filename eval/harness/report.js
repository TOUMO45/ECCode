#!/usr/bin/env node
'use strict';
// Aggregate a run into results/summary.json and results/report.md, computing
// every metric and target verdict exactly as predeclared in suite/targets.json.
//
//   node eval/harness/report.js --run <runDir> --out <dir> [--split holdout]

const fs = require('fs');
const path = require('path');
const { listTasks } = require('./lib');

function argv(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const run = path.resolve(argv('run'));
const outDir = path.resolve(argv('out'));
const split = argv('split', 'holdout');
const targets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'suite', 'targets.json'), 'utf8'));
const tasks = new Map(listTasks().map((t) => [t.id, t]));
const CONDS = ['C0', 'C1', 'C2'];

function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const money = (x) => `$${(Math.round(x * 100) / 100).toFixed(2)}`;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function loadTrials() {
  const base = path.join(run, 'trials', split);
  const out = [];
  if (!fs.existsSync(base)) return out;
  for (const cond of fs.readdirSync(base)) {
    for (const task of fs.readdirSync(path.join(base, cond))) {
      for (const rep of fs.readdirSync(path.join(base, cond, task))) {
        const f = path.join(base, cond, task, rep, 'attempt', 'result.json');
        if (fs.existsSync(f)) out.push(JSON.parse(fs.readFileSync(f, 'utf8')));
      }
    }
  }
  return out;
}

/** Tags each condition received QA feedback about during training. */
function fedBackTags() {
  const out = {};
  for (const cond of CONDS) {
    const f = path.join(run, 'training', `${cond}.json`);
    const tags = new Set();
    if (fs.existsSync(f)) {
      for (const rec of JSON.parse(fs.readFileSync(f, 'utf8'))) {
        if (!rec.fedBack) continue;
        for (const t of rec.fedBack.traps || []) tags.add(`trap:${t}`);
        for (const o of rec.fedBack.org || []) tags.add(`org:${o}`);
      }
    }
    out[cond] = tags;
  }
  return out;
}

function relationOf(r) {
  const t = tasks.get(r.task);
  return (t && t.relation) || r.relation || null;
}

function metrics(trials, fed) {
  const orgAll = trials.flatMap((r) => r.grade.orgChecks || []);
  const disc = trials.reduce((a, r) => ({ passed: a.passed + (r.grade.discoverable ? r.grade.discoverable.passed : 0), total: a.total + (r.grade.discoverable ? r.grade.discoverable.total : 0) }), { passed: 0, total: 0 });
  const successes = trials.filter((r) => r.grade.success).length;
  const costs = trials.map((r) => r.costUsd || 0);
  const repeated = trials.filter((r) => [...(r.grade.failedTraps || []).map((t) => `trap:${t}`), ...(r.grade.failedOrg || []).map((o) => `org:${o}`)].some((tag) => fed.has(tag)));
  return {
    n: trials.length,
    successes,
    successRate: trials.length ? successes / trials.length : 0,
    successCI: wilson(successes, trials.length),
    orgPassed: orgAll.filter((c) => c.ok).length,
    orgTotal: orgAll.length,
    orgPassRate: orgAll.length ? orgAll.filter((c) => c.ok).length / orgAll.length : null,
    discoverablePassRate: disc.total ? disc.passed / disc.total : null,
    regressions: trials.filter((r) => (r.grade.regressions || []).length).length,
    repeatedMistakes: repeated.length,
    interventions: trials.filter((r) => r.intervention && r.intervention.needed).length,
    meanCost: mean(costs),
    totalCost: costs.reduce((s, x) => s + x, 0),
    costPerSuccess: successes ? costs.reduce((s, x) => s + x, 0) / successes : Infinity,
    meanWallMin: mean(trials.map((r) => r.wallMs / 60000)),
    meanAgentDispatches: mean(trials.map((r) => r.agentDispatches || 0)),
  };
}

function verdicts(M) {
  const g = (c, set) => M[set][c];
  const res = [];
  const add = (id, met, detail, informative = true) => res.push({ id, met: Boolean(met) && informative, detail, informative });
  const R = (c) => g(c, 'REL');
  add('L1', R('C2').orgPassRate !== null && R('C1').orgPassRate !== null && R('C2').orgPassRate - R('C1').orgPassRate >= 0.4, `orgPassRate REL: C2 ${pct(R('C2').orgPassRate || 0)} vs C1 ${pct(R('C1').orgPassRate || 0)} (need +40 pp)`);
  add('L2', R('C2').repeatedMistakes <= 0.5 * R('C1').repeatedMistakes, `repeated mistakes REL: C2 ${R('C2').repeatedMistakes} vs C1 ${R('C1').repeatedMistakes} (need C2 <= half, C1 >= 3)`, R('C1').repeatedMistakes >= 3);
  add('L3', R('C2').successRate - R('C1').successRate >= 0.25, `success REL: C2 ${pct(R('C2').successRate)} vs C1 ${pct(R('C1').successRate)} (need +25 pp)`);
  add('L4', g('C2', 'DEC').successes >= g('C1', 'DEC').successes - 1, `decoy successes: C2 ${g('C2', 'DEC').successes}/${g('C2', 'DEC').n} vs C1 ${g('C1', 'DEC').successes}/${g('C1', 'DEC').n} (need C2 >= C1 - 1)`);
  add('L5', R('C2').meanCost <= 1.5 * R('C1').meanCost, `mean cost REL: C2 ${money(R('C2').meanCost)} vs C1 ${money(R('C1').meanCost)} (need <= 1.5x)`);
  const A = (c) => g(c, 'ALL');
  add('E1', A('C2').successRate - A('C0').successRate >= 0.2, `success ALL: C2 ${pct(A('C2').successRate)} vs C0 ${pct(A('C0').successRate)} (need +20 pp)`);
  add('E2', A('C2').regressions <= A('C0').regressions, `regression trials ALL: C2 ${A('C2').regressions} vs C0 ${A('C0').regressions}`);
  add('E3', A('C2').interventions <= A('C0').interventions && A('C2').interventions <= 2, `interventions ALL: C2 ${A('C2').interventions} vs C0 ${A('C0').interventions} (need <= C0 and <= 2)`);
  add('E4', A('C2').costPerSuccess <= 3 * A('C0').costPerSuccess, `cost per success ALL: C2 ${money(A('C2').costPerSuccess)} vs C0 ${money(A('C0').costPerSuccess)} (need <= 3x)`);
  const claims = [
    { id: 'O1', met: A('C1').discoverablePassRate - A('C0').discoverablePassRate >= 0.05, detail: `discoverable AC pass ALL: C1 ${pct(A('C1').discoverablePassRate || 0)} vs C0 ${pct(A('C0').discoverablePassRate || 0)} (claim needs +5 pp)` },
    { id: 'O2', met: A('C1').regressions <= A('C0').regressions, detail: `regression trials ALL: C1 ${A('C1').regressions} vs C0 ${A('C0').regressions}` },
    { id: 'O3', met: null, detail: `mean cost C1/C0 = ${(A('C1').meanCost / (A('C0').meanCost || 1)).toFixed(2)}x; mean wall time C1/C0 = ${(A('C1').meanWallMin / (A('C0').meanWallMin || 1)).toFixed(2)}x` },
  ];
  return { mandatory: res, claims };
}

function main() {
  const trials = loadTrials();
  const fed = fedBackTags();
  const M = {};
  for (const set of ['ALL', 'REL', 'DEC']) {
    M[set] = {};
    for (const c of CONDS) {
      const pick = trials.filter((r) => r.condition === c && (set === 'ALL' || (set === 'REL' ? relationOf(r) === 'related' : relationOf(r) === 'decoy')));
      M[set][c] = metrics(pick, fed[c]);
    }
  }
  const v = verdicts(M);
  const perTask = {};
  for (const r of trials) {
    const k = `${r.task}|${r.condition}`;
    (perTask[k] = perTask[k] || []).push(r);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const toolkits = fs.existsSync(path.join(run, 'toolkits', 'toolkits.json')) ? JSON.parse(fs.readFileSync(path.join(run, 'toolkits', 'toolkits.json'), 'utf8')) : null;
  const training = Object.fromEntries(CONDS.map((c) => [c, fs.existsSync(path.join(run, 'training', `${c}.json`)) ? JSON.parse(fs.readFileSync(path.join(run, 'training', `${c}.json`), 'utf8')) : []]));
  const summary = { generatedAt: new Date().toISOString(), split, toolkits, fedBackTags: Object.fromEntries(CONDS.map((c) => [c, [...fed[c]]])), metrics: M, verdicts: v, allMandatoryMet: v.mandatory.every((x) => x.met), trials: trials.map((r) => ({ task: r.task, condition: r.condition, rep: r.rep, relation: relationOf(r), success: r.grade.success, ac: `${r.grade.acPassed}/${r.grade.acTotal}`, failed: r.grade.failed, regressions: r.grade.regressions, costUsd: r.costUsd, wallMin: Math.round(r.wallMs / 600) / 100, agentDispatches: r.agentDispatches, intervention: r.intervention })), training };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  const L = [];
  L.push('# ECCode evaluation results (R7)', '');
  L.push(`Generated ${summary.generatedAt} from \`${path.relative(process.cwd(), run) || run}\`. Toolkits: ECCode \`${toolkits ? toolkits.eccode.commit.slice(0, 12) : '?'}\`, ECC \`${toolkits ? toolkits.ecc.commit.slice(0, 12) : '?'}\`. Targets were predeclared in \`eval/suite/targets.json\`.`, '');
  L.push('## Target verdicts', '', '| Target | Met | Detail |', '|---|---|---|');
  for (const x of v.mandatory) L.push(`| ${x.id} | ${x.met ? '✅ met' : x.informative ? '❌ not met' : '❌ not informative'} | ${x.detail} |`);
  L.push('', '**Claims (orchestration alone, C1 vs C0):**', '', '| Claim | Holds | Detail |', '|---|---|---|');
  for (const x of v.claims) L.push(`| ${x.id} | ${x.met === null ? 'n/a' : x.met ? 'yes' : 'no'} | ${x.detail} |`);
  L.push('', `All mandatory targets met: **${summary.allMandatoryMet ? 'YES' : 'NO'}**`, '');
  L.push('## Aggregates', '');
  for (const set of ['ALL', 'REL', 'DEC']) {
    L.push(`### ${set}`, '', '| Condition | n | Success (95% CI) | Org-rule checks | Discoverable AC | Regression trials | Repeated mistakes | Interventions | Mean cost | Cost/success | Mean wall min | Mean dispatches |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of CONDS) {
      const m = M[set][c];
      L.push(`| ${c} | ${m.n} | ${m.successes}/${m.n} = ${pct(m.successRate)} (${pct(m.successCI[0])}–${pct(m.successCI[1])}) | ${m.orgTotal ? `${m.orgPassed}/${m.orgTotal}` : '–'} | ${m.discoverablePassRate === null ? '–' : pct(m.discoverablePassRate)} | ${m.regressions} | ${m.repeatedMistakes} | ${m.interventions} | ${money(m.meanCost)} | ${Number.isFinite(m.costPerSuccess) ? money(m.costPerSuccess) : '∞'} | ${m.meanWallMin.toFixed(1)} | ${m.meanAgentDispatches.toFixed(1)} |`);
    }
    L.push('');
  }
  L.push('## Per task (successes / repeats, mean cost)', '', '| Task | Relation | C0 | C1 | C2 |', '|---|---|---|---|---|');
  for (const t of [...new Set(trials.map((r) => r.task))].sort()) {
    const cell = (c) => {
      const rs = perTask[`${t}|${c}`] || [];
      return rs.length ? `${rs.filter((r) => r.grade.success).length}/${rs.length} · ${money(mean(rs.map((r) => r.costUsd || 0)))}` : '–';
    };
    L.push(`| ${t} | ${(tasks.get(t) || {}).relation || ''} | ${cell('C0')} | ${cell('C1')} | ${cell('C2')} |`);
  }
  L.push('', '## Unsuccessful trials', '');
  for (const r of trials.filter((x) => !x.grade.success).sort((a, b) => (a.task + a.condition < b.task + b.condition ? -1 : 1))) {
    L.push(`- **${r.task} · ${r.condition} · r${r.rep}**: failed ${r.grade.failed.map((f) => `\`${f.split(' ')[0]}\``).join(', ') || '(visible tests)'}${r.grade.regressions.length ? `; regressions ${r.grade.regressions.join(', ')}` : ''}${r.intervention.needed ? `; intervention: ${r.intervention.reasons.join('; ')}` : ''}`);
  }
  L.push('', '## Training', '');
  for (const c of CONDS) {
    L.push(`- **${c}:** ${training[c].map((rec) => `${rec.task} ${rec.attempt && rec.attempt.success ? 'passed first time' : `feedback on ${(rec.fedBack ? [...rec.fedBack.traps.map((t) => `trap:${t}`), ...rec.fedBack.org.map((o) => `org:${o}`)] : []).join(', ') || 'checks'} → ${rec.feedback ? (rec.feedback.success ? 'fixed' : 'still failing') : 'n/a'}`}`).join('; ') || 'no training records'}`);
  }
  fs.writeFileSync(path.join(outDir, 'report.md'), L.join('\n') + '\n');
  console.log(L.slice(0, 20).join('\n'));
}

main();
