'use strict';
// Runs ONE edit of the caller's choosing (never a seed) through an engine tree's behavior diff on a Mealie
// checkout and summarizes what differs. It is how the noise floor and the reach of a detector version are
// measured before a freeze: a comment-only edit must give zero unexplained differences, a behaviour edit
// must give differences on the operations that show it.
//   node bench/pilot/hb2/edit-check.js --tree <engine tree> --mealie <checkout> --file <path> --find <text|@PREPEND> --replace <text>
//        [--commit <sha>] [--runs <n baseline runs, default 2>] [--json <summary.json>]
// With more baseline runs the summary also lists the paths that differ between baseline runs of the SAME tree:
// the intrinsic nondeterminism of the application under the configuration.
// Needs NLTK_DATA for Mealie. Prints one summary; the checkout is restored.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REGISTERED_COMMIT = '753325676331cf8df48cae7c64ce634f2cb693cb';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

function main() {
  const tree = path.resolve(arg('--tree', ''));
  const mealie = path.resolve(arg('--mealie', ''));
  const file = arg('--file');
  const find = arg('--find');
  const replace = arg('--replace', '');
  if (!arg('--tree') || !arg('--mealie') || !file || find === undefined) {
    process.stderr.write('usage: edit-check.js --tree <engine tree> --mealie <checkout> --file <path> --find <text|@PREPEND> --replace <text> [--commit sha] [--json out]\n');
    return 2;
  }
  const commit = arg('--commit', REGISTERED_COMMIT);
  const runner = require(path.join(tree, 'bench/pilot/phase2-hb/run.js'));
  const config = require(path.join(tree, 'bench/pilot/phase2-hb/config.js'));
  const cli = (args) => spawnSync(process.execPath, [path.join(tree, 'bin/eccode.js'), ...args, '--json'], { cwd: mealie, encoding: 'utf8', maxBuffer: 1 << 28 });
  runner.clean(mealie, commit);
  try {
    const init = cli(['init', '--name', 'edit-check', '--idea', 'edit check', '--track', 'fix', '--actor', 'orchestrator']);
    if (init.status !== 0) throw new Error(`init failed: ${(init.stderr || init.stdout).slice(0, 300)}`);
    config.write(mealie, tree);
    const target = path.join(mealie, file);
    const text = fs.readFileSync(target, 'utf8');
    if (find === '@PREPEND') fs.writeFileSync(target, `${replace}\n${text}`);
    else {
      if (text.split(find).length - 1 !== 1) throw new Error(`${file}: the anchor occurs ${text.split(find).length - 1} times`);
      fs.writeFileSync(target, text.replace(find, replace));
    }
    const route = cli(['behavior', 'route', '--actor', 'backend-engineer']);
    const routing = JSON.parse(route.stdout.slice(route.stdout.indexOf('{')));
    if (routing.decision !== 'run') {
      process.stdout.write(`routing: ${routing.decision} (no public surface reached)\n`);
      return 0;
    }
    const d = cli(['behavior', 'diff', '--actor', 'backend-engineer', '--runs', String(arg('--runs', '2')), '--timeout', '1800']);
    const json = d.stdout.indexOf('{') >= 0 ? JSON.parse(d.stdout.slice(d.stdout.indexOf('{'))) : null;
    if (!json) throw new Error(`the diff produced no result (exit ${d.status}): ${(d.stderr || '').slice(-300)}`);
    const art = JSON.parse(fs.readFileSync(path.join(mealie, json.artifact), 'utf8'));
    const byTarget = {};
    const byPath = {};
    for (const x of art.differences) {
      byTarget[x.target] = (byTarget[x.target] || 0) + 1;
      for (const p of x.paths) byPath[p.path] = (byPath[p.path] || 0) + 1;
    }
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
    const flaky = {};
    for (const n of art.nondeterministic || []) for (const p of n.paths) flaky[p] = (flaky[p] || 0) + 1;
    const summary = { probes: json.probes, executed: json.executed, dropped: json.dropped, differences: art.differences.length, unexplained: json.unexplained, coverage: json.coverage, joinedOperations: (art.joinedOperations || []).length, targetsWithDifferences: Object.keys(byTarget).length, topTargets: top(byTarget, 8), topPaths: top(byPath, 8), nondeterministicProbes: (art.nondeterministic || []).length, nondeterministicPaths: top(flaky, 12), notes: (art.notes || []).slice(0, 3) };
    process.stdout.write(`probes=${summary.probes} executed=${summary.executed} dropped=${summary.dropped} joined=${summary.joinedOperations} differences=${summary.differences} unexplained=${summary.unexplained} coverage=${summary.coverage}\n`);
    process.stdout.write(`targets with differences: ${summary.targetsWithDifferences} ${JSON.stringify(summary.topTargets)}\ntop differing paths: ${JSON.stringify(summary.topPaths)}\n`);
    process.stdout.write(`nondeterministic between baseline runs: ${summary.nondeterministicProbes} probe(s) ${JSON.stringify(summary.nondeterministicPaths)}\n`);
    if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(summary, null, 2) + '\n');
    return 0;
  } finally {
    runner.clean(mealie, commit);
  }
}

if (require.main === module) {
  try { process.exit(main()); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
