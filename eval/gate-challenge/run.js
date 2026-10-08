#!/usr/bin/env node
'use strict';
// R3 gate challenge: deliberately submit an incomplete design and a defective
// implementation to the ECCode gates, and show rejection, correction and
// successful re-review.
//
//   node eval/gate-challenge/run.js --toolkits <dir> --out <dir> [--budget-usd 5] [--timeout-min 25]
//
// Who does what (recorded in <out>/steps.json):
//   - The driver (this script) acts as the orchestrator and, for the PLANTED
//     defective v1 artifacts only, submits them as the author role. It also
//     runs scripted engine probes (cheap, no model): out-of-order start, missing
//     sections, self-approval, approval without evidence, stale artifact.
//   - Every review, and every CORRECTION, is performed by a real, fresh Claude
//     Code session running the ECCode role (`--agent eccode:<role>`) in the
//     sandbox. Reviewers get no hint about the planted defects; authors get the
//     rejection findings, exactly as the orchestrator skill hands them over.
// The ground truth (fixtures/../ground-truth.json) is never visible to a session.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SBX, trialEnv, prepareState, dropToken, spawnInSandbox } = require('../harness/sandbox-env');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const toolkits = path.resolve(arg('toolkits'));
const out = path.resolve(arg('out'));
const budget = arg('budget-usd', '5');
const timeoutMin = Number(arg('timeout-min', '25'));
const FIX = path.join(__dirname, 'fixtures');
const toolkit = path.join(toolkits, 'eccode');
const work = path.join(out, 'work');
const stateDir = path.join(out, 'state');
const CLI = path.join(toolkit, 'bin', 'eccode.js');
const steps = [];
let tokenState = null;

fs.mkdirSync(work, { recursive: true });
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: work, encoding: 'utf8', ...opts });
sh('git', ['init', '-q']);
sh('git', ['-c', 'user.email=driver@acme.test', '-c', 'user.name=driver', 'commit', '-q', '--allow-empty', '-m', 'start']);

const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  fs.writeFileSync(path.join(work, rel), text);
};
const copy = (from, rel) => write(rel, fs.readFileSync(path.join(FIX, from), 'utf8'));

/** Run the eccode CLI as the driver; record the outcome as a step. */
function cli(label, args, { expectRefusal = null } = {}) {
  // --root must come before a `-- <command>` separator or it would become part of the command.
  const sep = args.indexOf('--');
  const full = sep === -1 ? [...args, '--root', work] : [...args.slice(0, sep), '--root', work, ...args.slice(sep)];
  const r = sh(process.execPath, [CLI, ...full]);
  const refused = r.status === 2;
  const rec = { label, command: `eccode ${args.join(' ')}`, exit: r.status, refused, output: (r.stdout + r.stderr).trim().slice(0, 900) };
  if (expectRefusal) {
    rec.expectedRefusal = expectRefusal;
    rec.ok = refused && new RegExp(expectRefusal).test(r.stdout + r.stderr);
  } else rec.ok = r.status === 0;
  steps.push(rec);
  console.log(`${rec.ok ? 'ok  ' : 'FAIL'} ${label}${expectRefusal ? ` (refused: ${rec.output.split('\n')[0].slice(0, 100)})` : ''}`);
  return { ...r, rec };
}

function review(ok, extra = {}) {
  return { decision: ok ? 'approve' : 'changes_requested', summary: 'scripted engine probe', criteria: [{ id: 'C1', description: 'probe', met: ok, evidence: extra.evidence || [] }], findings: ok ? [] : [{ id: 'P1', severity: 'blocking', title: 'probe', detail: 'probe', recommendation: 'probe' }] };
}

/** One fresh role session in the sandbox. Returns the final text, cost and transcript path. */
async function roleSession(label, role, prompt) {
  prepareState('C1', stateDir);
  const env = trialEnv('C1');
  const transcript = path.join(out, `${label}.jsonl`);
  const args = ['-p', prompt, '--agent', `eccode:${role}`, '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5-5', '--max-budget-usd', budget, '--permission-mode', 'bypassPermissions', '--plugin-dir', `${SBX}/toolkit`, '--append-system-prompt', 'This is an unattended run. No human answers questions. Record your work with the eccode CLI as your role, then report briefly.'];
  const started = Date.now();
  await new Promise((resolve) => {
    const child = spawnInSandbox({ work, state: stateDir, toolkit, env, cmd: 'claude', args, stdout: fs.openSync(transcript, 'w'), stderr: fs.openSync(path.join(out, `${label}.err`), 'w') });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMin * 60000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  tokenState = stateDir;
  let result = null;
  let session = null;
  let hookDenials = 0;
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
    try {
      const j = JSON.parse(l);
      if (j.type === 'result') result = j;
      if (j.type === 'system' && j.subtype === 'init') session = j.session_id;
      if (j.type === 'user' && JSON.stringify(j.message || '').includes('permissionDecision') ) hookDenials++;
    } catch {}
  }
  const rec = { label, role, sessionId: session, costUsd: result && result.total_cost_usd, wallMin: Math.round((Date.now() - started) / 600) / 100, text: String((result && result.result) || '').slice(-1500) };
  steps.push({ label: `session:${label}`, session: rec });
  console.log(`session ${label} (${role}) ${rec.sessionId} $${rec.costUsd} ${rec.wallMin}min`);
  return rec;
}

const reviewPrompt = (gate, role) => `CLI: eccode (on PATH). The project is the current directory. A submission for gate "${gate}" is on record (eccode gate show ${gate}). You are the independent reviewer for it. Inspect the submitted artifacts and the evidence yourself, re-run whatever checks you need, and record your decision with eccode gate review ${gate} --actor ${role} --file <your review.json> (write the JSON under .eccode/reviews/drafts/). Report the review id and your decision.`;

const lastReviewId = (gate) => JSON.parse(fs.readFileSync(path.join(work, '.eccode', 'state.json'), 'utf8')).gates[gate].reviews.slice(-1)[0];
const reviewOf = (id) => JSON.parse(fs.readFileSync(path.join(work, '.eccode', 'state.json'), 'utf8')).reviews[id];
const gateStatus = (gate) => JSON.parse(fs.readFileSync(path.join(work, '.eccode', 'state.json'), 'utf8')).gates[gate].status;

/**
 * Review a submitted gate with a fresh reviewer session. While the reviewer
 * requests changes, a fresh author session revises against the findings and
 * resubmits (--responds-to), and a fresh reviewer re-reviews, up to maxRounds.
 */
async function reviewLoop(gate, { reviewerRole, authorRole, artifact, label, maxRounds = 3, authorExtra = '' }) {
  for (let round = 1; round <= maxRounds; round++) {
    await roleSession(`review-${label}-${round}`, reviewerRole, reviewPrompt(gate, reviewerRole));
    const id = lastReviewId(gate);
    const rv = id && reviewOf(id);
    steps.push({ label: `${gate} review ${round}`, reviewId: id, decision: rv && rv.decision, findings: rv && (rv.findings || []).map((f) => ({ id: f.id, severity: f.severity, title: f.title })), resolvedFindings: rv && rv.resolvedFindings, gate: gateStatus(gate) });
    if (gateStatus(gate) !== 'changes_requested') return gateStatus(gate);
    const findings = (rv.findings || []).map((f) => `- ${f.id} [${f.severity}] ${f.title}: ${f.detail} Recommendation: ${f.recommendation}`).join('\n');
    await roleSession(`revise-${label}-${round}`, authorRole, `CLI: eccode (on PATH). The project is the current directory. Your submission for gate "${gate}" was rejected by review ${id}. Open findings:\n${findings}\n\nRevise ${artifact} so that it addresses every finding, then resubmit with eccode gate submit ${gate} --actor ${authorRole} --artifact ${artifact} --responds-to ${id}. ${authorExtra}Report what you changed.`);
    if (gateStatus(gate) !== 'submitted') return gateStatus(gate);
  }
  return gateStatus(gate);
}

(async () => {
  // The review-iteration limit is a documented per-project setting (default 3). A strict reviewer can
  // keep asking for more, so this fixture allows 5 rounds; run 4 of the challenge (kept as evidence)
  // shows the default limit escalating the gate to the user after 3 rejections.
  fs.mkdirSync(path.join(work, '.eccode'), { recursive: true });
  const { DEFAULT_CONFIG } = require(path.join(toolkit, 'lib', 'config'));
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.limits.maxReviewIterations = 5;
  fs.writeFileSync(path.join(work, '.eccode', 'config.json'), JSON.stringify(cfg, null, 2));
  cli('init (delivery profile)', ['init', '--name', 'Notes Vault', '--idea', 'A private notes API: each user creates, lists, reads and deletes only their own notes.']);

  // ---- Engine probes: dependent gates cannot start early -----------------------------------------
  cli('probe: design cannot start before architecture is approved', ['gate', 'start', 'design', '--actor', 'orchestrator'], { expectRefusal: 'GATE_BLOCKED|approved' });

  // ---- Architecture: a sound brief, reviewed blind ----------------------------------------------
  cli('architecture: start', ['gate', 'start', 'architecture', '--actor', 'orchestrator']);
  copy('brief.md', '.eccode/artifacts/brief.md');
  cli('architecture: submit (product-architect)', ['gate', 'submit', 'architecture', '--actor', 'product-architect', '--artifact', '.eccode/artifacts/brief.md']);
  const archStatus = await reviewLoop('architecture', { reviewerRole: 'architecture-reviewer', authorRole: 'product-architect', artifact: '.eccode/artifacts/brief.md', label: 'architecture' });
  if (archStatus !== 'approved') {
    console.log(`architecture ended as ${archStatus}; stopping.`);
    return finish(1);
  }

  // ---- Design: INCOMPLETE ---------------------------------------------------------------------------
  cli('design: start', ['gate', 'start', 'design', '--actor', 'orchestrator']);
  copy('design-missing-sections.md', '.eccode/artifacts/design.md');
  cli('design v0 (no Security / Testing Strategy headings): engine refuses the submission', ['gate', 'submit', 'design', '--actor', 'technical-designer', '--artifact', '.eccode/artifacts/design.md'], { expectRefusal: 'MISSING_SECTIONS|missing required sections' });
  copy('design-v1.md', '.eccode/artifacts/design.md');
  cli('design v1 (all headings, hollow content): submit', ['gate', 'submit', 'design', '--actor', 'technical-designer', '--artifact', '.eccode/artifacts/design.md']);
  write('.eccode/drafts/probe-review.json', JSON.stringify(review(true, { evidence: ['artifact:.eccode/artifacts/design.md'] })));
  cli('probe: the design author cannot approve their own design', ['gate', 'review', 'design', '--actor', 'technical-designer', '--file', path.join(work, '.eccode/drafts/probe-review.json')], { expectRefusal: 'REVIEW_REJECTED|not an authorized reviewer|author' });
  write('.eccode/drafts/probe-review.json', JSON.stringify(review(true, { evidence: [] })));
  cli('probe: approval without evidence is refused', ['gate', 'review', 'design', '--actor', 'technical-reviewer', '--file', path.join(work, '.eccode/drafts/probe-review.json')], { expectRefusal: 'REVIEW_REJECTED|evidence' });

  const designStatus = await reviewLoop('design', { reviewerRole: 'technical-reviewer', authorRole: 'technical-designer', artifact: '.eccode/artifacts/design.md', label: 'design', authorExtra: 'Check the revised design against the approved brief (.eccode/artifacts/brief.md). ' });
  if (designStatus !== 'approved') {
    console.log(`design ended as ${designStatus}; stopping before the plan.`);
    return finish(1);
  }

  // ---- Plan (scripted, blind-reviewed) ---------------------------------------------------------
  cli('plan: start', ['gate', 'start', 'plan', '--actor', 'orchestrator']);
  write('.eccode/artifacts/plan.json', JSON.stringify({
    phases: [{ id: 'core', name: 'Core API', goal: 'Implement the notes API and its tests', acceptanceCriteria: ['AC1-AC6 hold', 'AC7: automated tests cover AC1-AC6'] }],
    tasks: [{ id: 'api', phase: 'core', title: 'Implement notes API with tests', owner: 'backend-engineer', dependencies: [], inputs: ['.eccode/artifacts/brief.md', '.eccode/artifacts/design.md'], outputs: ['src/server.js', 'src/store.js', 'test/notes.test.js'], files: ['src/**', 'test/**', 'package.json'], acceptanceCriteria: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7'], verification: { method: 'run the test suite', command: 'node --test' } }],
  }, null, 2));
  cli('plan: submit (delivery-lead)', ['gate', 'submit', 'plan', '--actor', 'delivery-lead', '--artifact', '.eccode/artifacts/plan.json']);
  const planStatus = await reviewLoop('plan', { reviewerRole: 'technical-reviewer', authorRole: 'delivery-lead', artifact: '.eccode/artifacts/plan.json', label: 'plan', authorExtra: 'The work is small: keep the plan as ONE phase "core" with ONE task "api" owned by backend-engineer (files src/**, test/**, package.json) and address the findings inside that structure (acceptance criteria, inputs, verification command, task description). Validate with eccode plan validate before resubmitting. ' });
  if (planStatus !== 'approved') {
    console.log(`plan ended as ${planStatus}; stopping.`);
    return finish(1);
  }

  // ---- Implementation: DEFECTIVE -----------------------------------------------------------------
  cli('probe: a task cannot be claimed before its phase gate starts', ['task', 'claim', 'api', '--actor', 'backend-engineer'], { expectRefusal: 'GATE_BLOCKED|start it first|Phase gate' });
  cli('phase: start', ['gate', 'start', 'phase:core', '--actor', 'orchestrator']);
  cli('task: claim (backend-engineer)', ['task', 'claim', 'api', '--actor', 'backend-engineer']);
  copy('v1-src/server.js', 'src/server.js');
  copy('v1-src/store.js', 'src/store.js');
  copy('v1-test/notes.test.js', 'test/notes.test.js');
  copy('package.json', 'package.json');
  cli('evidence: test run (the planted tests pass)', ['evidence', 'run', '--actor', 'backend-engineer', '--label', 'node --test', '--task', 'api', '--', 'node', '--test']);
  const evList = JSON.parse(sh(process.execPath, [CLI, 'evidence', 'list', '--json', '--root', work]).stdout);
  const evId = evList[evList.length - 1].id;
  write('.eccode/drafts/handoff.json', JSON.stringify({ from: 'backend-engineer', to: 'delivery-lead', task: 'api', objective: 'Implement the notes API', context: 'Per approved brief and design', inputs: ['.eccode/artifacts/design.md'], expectedOutput: 'Working API with tests', acceptanceCriteria: ['AC1-AC7'], completedWork: 'Endpoints and tests implemented; test suite passes.', filesChanged: ['src/server.js', 'src/store.js', 'test/notes.test.js', 'package.json'], evidence: [`ev:${evId}`], remainingIssues: [], nextAction: 'phase review' }));
  cli('task: complete with handoff', ['task', 'complete', 'api', '--actor', 'backend-engineer', '--handoff', path.join(work, '.eccode/drafts/handoff.json')]);
  cli('phase: submit (delivery-lead)', ['gate', 'submit', 'phase:core', '--actor', 'delivery-lead']);
  // Review / correct loop for the phase: the corrections are real backend-engineer sessions.
  for (let round = 1; round <= 3; round++) {
    await roleSession(`review-phase-${round}`, 'security-reviewer', reviewPrompt('phase:core', 'security-reviewer'));
    const rid = lastReviewId('phase:core');
    const rv = reviewOf(rid);
    steps.push({ label: `phase review ${round}`, reviewId: rid, decision: rv && rv.decision, findings: rv && (rv.findings || []).map((f) => ({ id: f.id, severity: f.severity, title: f.title })), resolvedFindings: rv && rv.resolvedFindings, gate: gateStatus('phase:core') });
    if (gateStatus('phase:core') !== 'changes_requested') break;
    const findings = (rv.findings || []).map((f) => `- ${f.id} [${f.severity}] ${f.title}: ${f.detail} Recommendation: ${f.recommendation}`).join('\n');
    cli(`task: reset for rework after review ${round} (orchestrator)`, ['task', 'reset', 'api', '--actor', 'orchestrator', '--reason', `review ${rid} found blocking defects`]);
    await roleSession(`fix-implementation-${round}`, 'backend-engineer', `CLI: eccode (on PATH). The project is the current directory. Phase "core" was rejected by review ${rid}. Open findings:\n${findings}\n\nTask "api" has been reset. Claim it (eccode task claim api --actor backend-engineer), fix every finding in the code AND add automated tests that would have caught each defect, run the tests with eccode evidence run --actor backend-engineer --label <label> --task api -- node --test, complete the task with a handoff (start from eccode template handoff), then resubmit the phase as an implementer with eccode gate submit phase:core --actor backend-engineer --responds-to ${rid}. Report what you changed.`);
    if (gateStatus('phase:core') !== 'submitted') break;
  }
  finish(0);
})();

function finish(code) {
  if (tokenState) dropToken(tokenState);
  const audit = sh(process.execPath, [CLI, 'audit', '--root', work]);
  const st = JSON.parse(fs.readFileSync(path.join(work, '.eccode', 'state.json'), 'utf8'));
  const truth = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground-truth.json'), 'utf8'));
  const textOf = (id) => {
    const r = st.reviews[id];
    return r ? JSON.stringify([r.summary, r.findings, r.criteria]).toLowerCase() : '';
  };
  const detection = (stage, gate) => {
    if (!st.gates[gate]) return [];
    const firstRejection = (st.gates[gate].reviews || []).find((id) => st.reviews[id].decision !== 'approve');
    const txt = firstRejection ? textOf(firstRejection) : '';
    return truth[stage].map((d) => ({ id: d.id, defect: d.defect, mentionedInFirstRejection: d.keywords.some((k) => txt.includes(k.toLowerCase())) }));
  };
  const summary = {
    finishedAt: new Date().toISOString(),
    gates: Object.fromEntries(Object.values(st.gates).map((g) => [g.id, { status: g.status, iterations: g.iterations, reviews: g.reviews.map((id) => ({ id, reviewer: st.reviews[id].reviewer, decision: st.reviews[id].decision })) }])),
    rejectedByEngine: st.rejectedReviews.length,
    probes: steps.filter((s) => s.expectedRefusal).map((s) => ({ label: s.label, refused: s.refused, matchedExpected: s.ok })),
    detection: { design: detection('design', 'design'), implementation: detection('implementation', 'phase:core') },
    sessions: steps.filter((s) => s.session).map((s) => ({ ...s.session, text: undefined })),
    totalCostUsd: steps.filter((s) => s.session).reduce((a, s) => a + (s.session.costUsd || 0), 0),
    auditOk: audit.status === 0,
    audit: audit.stdout.trim(),
    complete: Object.values(st.gates).filter((g) => ['design', 'plan', 'phase:core'].includes(g.id)).every((g) => g.status === 'approved'),
  };
  fs.writeFileSync(path.join(out, 'steps.json'), JSON.stringify(steps, null, 2));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(code);
}
