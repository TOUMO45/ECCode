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
  const r = sh(process.execPath, [CLI, ...args, '--root', work]);
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

(async () => {
  cli('init (delivery profile)', ['init', '--name', 'Notes Vault', '--idea', 'A private notes API: each user creates, lists, reads and deletes only their own notes.']);

  // ---- Engine probes: dependent gates cannot start early -----------------------------------------
  cli('probe: design cannot start before architecture is approved', ['gate', 'start', 'design', '--actor', 'orchestrator'], { expectRefusal: 'GATE_BLOCKED|approved' });

  // ---- Architecture: a sound brief, reviewed blind ----------------------------------------------
  cli('architecture: start', ['gate', 'start', 'architecture', '--actor', 'orchestrator']);
  copy('brief.md', '.eccode/artifacts/brief.md');
  cli('architecture: submit (product-architect)', ['gate', 'submit', 'architecture', '--actor', 'product-architect', '--artifact', '.eccode/artifacts/brief.md']);
  const arch = await roleSession('review-architecture', 'architecture-reviewer', reviewPrompt('architecture', 'architecture-reviewer'));
  steps.push({ label: 'architecture gate status', status: gateStatus('architecture'), note: 'a sound brief; a rejection here would be a reviewer false positive' });
  if (gateStatus('architecture') !== 'approved') {
    console.log('architecture not approved; the challenge continues only if approved. Stopping.');
    return finish(1);
  }

  // ---- Design: INCOMPLETE ---------------------------------------------------------------------------
  cli('design: start', ['gate', 'start', 'design', '--actor', 'orchestrator']);
  copy('design-missing-sections.md', '.eccode/artifacts/design.md');
  cli('design v0 (no Security / Testing Strategy headings): engine refuses the submission', ['gate', 'submit', 'design', '--actor', 'technical-designer', '--artifact', '.eccode/artifacts/design.md'], { expectRefusal: 'MISSING_SECTIONS|missing required sections' });
  copy('design-v1.md', '.eccode/artifacts/design.md');
  cli('design v1 (all headings, hollow content): submit', ['gate', 'submit', 'design', '--actor', 'technical-designer', '--artifact', '.eccode/artifacts/design.md']);
  write('probe-review.json', JSON.stringify(review(true, { evidence: ['artifact:.eccode/artifacts/design.md'] })));
  cli('probe: the design author cannot approve their own design', ['gate', 'review', 'design', '--actor', 'technical-designer', '--file', path.join(work, 'probe-review.json')], { expectRefusal: 'REVIEW_REJECTED|not an authorized reviewer|author' });
  write('probe-review.json', JSON.stringify(review(true, { evidence: [] })));
  cli('probe: approval without evidence is refused', ['gate', 'review', 'design', '--actor', 'technical-reviewer', '--file', path.join(work, 'probe-review.json')], { expectRefusal: 'REVIEW_REJECTED|evidence' });

  const d1 = await roleSession('review-design-1', 'technical-reviewer', reviewPrompt('design', 'technical-reviewer'));
  const d1Review = reviewOf(lastReviewId('design'));
  steps.push({ label: 'design review 1', decision: d1Review && d1Review.decision, findings: d1Review && d1Review.findings, gate: gateStatus('design') });

  // ---- Design: CORRECTION by a real technical-designer session --------------------------------
  if (gateStatus('design') === 'changes_requested') {
    const findings = (d1Review.findings || []).map((f) => `- ${f.id} [${f.severity}] ${f.title}: ${f.detail} Recommendation: ${f.recommendation}`).join('\n');
    await roleSession('revise-design', 'technical-designer', `CLI: eccode (on PATH). The project is the current directory. Your design for gate "design" was rejected by review ${lastReviewId('design')}. Open findings:\n${findings}\n\nRevise .eccode/artifacts/design.md so that it addresses every finding against the approved brief (.eccode/artifacts/brief.md), then resubmit with eccode gate submit design --actor technical-designer --artifact .eccode/artifacts/design.md --responds-to ${lastReviewId('design')}. Report what you changed.`);
    if (gateStatus('design') === 'submitted') {
      await roleSession('review-design-2', 'technical-reviewer', reviewPrompt('design', 'technical-reviewer'));
      const d2Review = reviewOf(lastReviewId('design'));
      steps.push({ label: 'design review 2 (after correction)', decision: d2Review && d2Review.decision, resolvedFindings: d2Review && d2Review.resolvedFindings, gate: gateStatus('design') });
    }
  }
  if (gateStatus('design') !== 'approved') {
    console.log(`design ended as ${gateStatus('design')}; stopping before the plan.`);
    return finish(1);
  }

  // ---- Plan (scripted, blind-reviewed) ---------------------------------------------------------
  cli('plan: start', ['gate', 'start', 'plan', '--actor', 'orchestrator']);
  write('.eccode/artifacts/plan.json', JSON.stringify({
    phases: [{ id: 'core', name: 'Core API', goal: 'Implement the notes API and its tests', acceptanceCriteria: ['AC1-AC5 hold', 'AC6: automated tests cover AC1-AC5'] }],
    tasks: [{ id: 'api', phase: 'core', title: 'Implement notes API with tests', owner: 'backend-engineer', dependencies: [], inputs: ['.eccode/artifacts/brief.md', '.eccode/artifacts/design.md'], outputs: ['src/server.js', 'src/store.js', 'test/notes.test.js'], files: ['src/**', 'test/**', 'package.json'], acceptanceCriteria: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6'], verification: { method: 'run the test suite', command: 'node --test' } }],
  }, null, 2));
  cli('plan: submit (delivery-lead)', ['gate', 'submit', 'plan', '--actor', 'delivery-lead', '--artifact', '.eccode/artifacts/plan.json']);
  await roleSession('review-plan', 'technical-reviewer', reviewPrompt('plan', 'technical-reviewer'));
  if (gateStatus('plan') !== 'approved') {
    console.log(`plan ended as ${gateStatus('plan')}; stopping.`);
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
  write('handoff.json', JSON.stringify({ from: 'backend-engineer', to: 'delivery-lead', task: 'api', objective: 'Implement the notes API', context: 'Per approved brief and design', inputs: ['.eccode/artifacts/design.md'], expectedOutput: 'Working API with tests', acceptanceCriteria: ['AC1-AC6'], completedWork: 'Endpoints and tests implemented; test suite passes.', filesChanged: ['src/server.js', 'src/store.js', 'test/notes.test.js', 'package.json'], evidence: [`ev:${evId}`], remainingIssues: [], nextAction: 'phase review' }));
  cli('task: complete with handoff', ['task', 'complete', 'api', '--actor', 'backend-engineer', '--handoff', path.join(work, 'handoff.json')]);
  cli('phase: submit (delivery-lead)', ['gate', 'submit', 'phase:core', '--actor', 'delivery-lead']);
  await roleSession('review-phase-1', 'security-reviewer', reviewPrompt('phase:core', 'security-reviewer'));
  const p1 = reviewOf(lastReviewId('phase:core'));
  steps.push({ label: 'phase review 1', decision: p1 && p1.decision, findings: p1 && p1.findings, gate: gateStatus('phase:core') });

  // ---- Implementation: CORRECTION by a real backend-engineer session ------------------------------
  if (gateStatus('phase:core') === 'changes_requested') {
    const rid = lastReviewId('phase:core');
    const findings = (p1.findings || []).map((f) => `- ${f.id} [${f.severity}] ${f.title}: ${f.detail} Recommendation: ${f.recommendation}`).join('\n');
    cli('task: reset for rework (orchestrator)', ['task', 'reset', 'api', '--actor', 'orchestrator', '--reason', `review ${rid} found blocking defects`]);
    await roleSession('fix-implementation', 'backend-engineer', `CLI: eccode (on PATH). The project is the current directory. Phase "core" was rejected by review ${rid}. Open findings:\n${findings}\n\nTask "api" has been reset. Claim it (eccode task claim api --actor backend-engineer), fix every finding in the code AND add automated tests that would have caught each defect, run the tests with eccode evidence run --actor backend-engineer --label <label> --task api -- node --test, complete the task with a handoff (the handoff JSON schema is in schemas/handoff.schema.json of the toolkit, and your agent instructions describe it), then resubmit the phase: eccode gate submit phase:core --actor delivery-lead is the delivery-lead's job, so as an implementer use --actor backend-engineer with --responds-to ${rid}. Report what you changed.`);
    if (gateStatus('phase:core') === 'submitted') {
      await roleSession('review-phase-2', 'security-reviewer', reviewPrompt('phase:core', 'security-reviewer'));
      const p2 = reviewOf(lastReviewId('phase:core'));
      steps.push({ label: 'phase review 2 (after correction)', decision: p2 && p2.decision, resolvedFindings: p2 && p2.resolvedFindings, gate: gateStatus('phase:core') });
    }
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
