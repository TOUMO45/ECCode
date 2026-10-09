'use strict';
const REPO = require('path').resolve(__dirname, '../../../..');
// Probe F5b: can a project with an OPEN critical (or high) risk be delivered?
// Reproduces the "happy path" of tests/resume-delivery.test.js, records open
// critical/high risks, then calls delivery.deliver (library) and `eccode deliver` (CLI).
// Does not modify the repository. Temp projects live under os.tmpdir() and are removed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = REPO + '';
const gates = require(`${ROOT}/lib/gates`);
const tasks = require(`${ROOT}/lib/tasks`);
const runs = require(`${ROOT}/lib/runs`);
const delivery = require(`${ROOT}/lib/delivery`);
const { DEFAULT_CONFIG } = require(`${ROOT}/lib/config`);
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor, approval } = require(`${ROOT}/tests/helpers`);

// --- copied from tests/resume-delivery.test.js ---------------------------------
function completePhase(ctx) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    const ev = passCheck(store, owner);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [ev.id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${ev.id}`]]));
}

function verify(ctx) {
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'] });
  const ev = passCheck(store, 'security-reviewer', 'full suite rerun');
  gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${ev.id}`, 'artifact:.eccode/artifacts/verification.md']]));
}
// ------------------------------------------------------------------------------

function deliverable() {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  completePhase(ctx);
  verify(ctx);
  return ctx;
}

function errInfo(err) {
  return { code: err.code, message: err.message, problems: err.details && err.details.problems };
}

function reportFacts(dir, rel) {
  const text = fs.readFileSync(path.join(dir, rel), 'utf8');
  const lines = text.split('\n');
  const risksIdx = lines.indexOf('## Risks');
  const risksSection = risksIdx >= 0 ? lines.slice(risksIdx + 2, lines.indexOf('', risksIdx + 2)) : [];
  const openLine = lines.find((l) => l.startsWith('- Open risks carried forward:')) || null;
  return { risksSection, openRisksLine: openLine, mentionsBlockOrRefuse: /refus|block/i.test(text.split('## Risks')[1] || '') };
}

const result = { probe: 'F5b-open-critical-risk-delivery', library: {}, cli: {}, config: {} };
const cleanup = [];

try {
  // 1. Library path: open critical + open high risk, then delivery.deliver.
  {
    const ctx = deliverable();
    cleanup.push(ctx.dir);
    runs.recordRisk(ctx.store, 'delivery-lead', { id: 'RISK-X', title: 'Data loss on restart', severity: 'critical', status: 'open' });
    runs.recordRisk(ctx.store, 'delivery-lead', { id: 'RISK-Y', title: 'Auth bypass on stale token', severity: 'high', status: 'open' });
    const before = ctx.store.state().risks;
    result.library.risksBeforeDeliver = Object.values(before).map((r) => ({ id: r.id, severity: r.severity, status: r.status }));
    result.library.preconditionProblems = delivery.preconditions(ctx.store).problems; // what deliver() checks
    try {
      const res = delivery.deliver(ctx.store, 'delivery-lead');
      const st = ctx.store.state();
      result.library.delivered = true;
      result.library.report = res.report;
      result.library.stateDelivery = st.delivery;
      result.library.risksAfterDeliver = Object.values(st.risks).map((r) => ({ id: r.id, severity: r.severity, status: r.status }));
      result.library.reportFacts = reportFacts(ctx.dir, res.report);
      result.library.auditOk = ctx.store.audit().ok;
      result.library.lastEvent = ctx.store.readEvents().slice(-1)[0].type;
    } catch (err) {
      result.library.delivered = false;
      result.library.refusal = errInfo(err);
    }
  }

  // 2. CLI path: a fresh deliverable project with only an open critical risk, delivered via `eccode deliver`.
  {
    const ctx = deliverable();
    cleanup.push(ctx.dir);
    const bin = path.join(ROOT, 'bin', 'eccode.js');
    const cli = (...args) => spawnSync(process.execPath, [bin, ...args, '--root', ctx.dir], { encoding: 'utf8' });
    const add = cli('risk', 'add', '--id', 'RISK-X', '--title', 'Data loss on restart', '--severity', 'critical', '--actor', 'delivery-lead');
    result.cli.riskAdd = { status: add.status, stdout: add.stdout.trim(), stderr: add.stderr.trim() };
    const del = cli('deliver', '--actor', 'delivery-lead', '--json');
    result.cli.deliver = { status: del.status, stdout: del.stdout.trim().slice(0, 400), stderr: del.stderr.trim().slice(0, 400) };
    result.cli.delivered = del.status === 0;
    const st = ctx.store.state();
    result.cli.stateDelivery = st.delivery || null;
    result.cli.riskAfter = st.risks['RISK-X'] ? { severity: st.risks['RISK-X'].severity, status: st.risks['RISK-X'].status } : null;
    if (st.delivery) result.cli.reportFacts = reportFacts(ctx.dir, st.delivery.report);
  }

  // 3. Config: any release / risk policy setting?
  const flat = [];
  (function walk(o, prefix) { for (const [k, v] of Object.entries(o)) { const key = prefix ? `${prefix}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key); else flat.push(key); } })(DEFAULT_CONFIG, '');
  result.config.keysMatchingRiskReleasePolicy = flat.filter((k) => /risk|release|deliver|policy|severity/i.test(k));
  result.config.topLevelKeys = Object.keys(DEFAULT_CONFIG);

  // 4. Does lib/delivery.js source reference risks anywhere outside report rendering?
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delivery.js'), 'utf8').split('\n');
  result.deliverySourceRiskLines = src.map((l, i) => ({ line: i + 1, text: l.trim() })).filter((x) => /risk/i.test(x.text)).map((x) => `${x.line}: ${x.text.slice(0, 110)}`);
} finally {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
}

const reproduces = result.library.delivered === true && result.cli.delivered === true;
result.reproduces = reproduces;
result.decisionPoint = 'lib/delivery.js:80-96 preconditions() builds the blocker list (gates, plan, tasks, audit, unreviewed changes, open runs) and never consults state.risks; lib/delivery.js:185 deliver() only throws DELIVERY_BLOCKED when that list is non-empty. Open risks are merely rendered at lib/delivery.js:174-175.';
process.stdout.write(JSON.stringify(result) + '\n');
process.exit(0);
