#!/usr/bin/env node
const REPO = require('path').resolve(__dirname, '../../../..');
'use strict';
// Probe F5a-main-session-actor-user
// Claim under test: an agent running in the MAIN session (no agent_type) can
// pass --actor user to the eccode CLI; the guard hook does not deny it, and the
// engine's user-reserved operations (gate reopen, risk accepted, rework past
// the cap, reset of an escalated task, rebuild --force, improve adopt) accept
// the literal string 'user' with no further proof that a human is present.
//
// Standalone. Requires engine modules by absolute path. Self-cleaning.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = REPO + '';
const H = require(`${ROOT}/tests/helpers.js`);
const gates = require(`${ROOT}/lib/gates`);
const tasks = require(`${ROOT}/lib/tasks`);
const runs = require(`${ROOT}/lib/runs`);
const rework = require(`${ROOT}/lib/rework`);
const evidence = require(`${ROOT}/lib/evidence`);
const { Store } = require(`${ROOT}/lib/store`);
const { init } = require(`${ROOT}/lib/project`);
const { loadConfig } = require(`${ROOT}/lib/config`);
const { Memory } = require(`${ROOT}/lib/memory/records`);
const improve = require(`${ROOT}/lib/memory/improve`);

const GUARD = `${ROOT}/scripts/hooks/guard.js`;
const BIN = `${ROOT}/bin/eccode.js`;
const PROBE_CMD = `node ${BIN} gate reopen architecture --actor user --resolution "operator says so"`;

const tmpDirs = [];
const out = { probe: 'F5a-main-session-actor-user', steps: {} };

// Environment seen by every spawned guard/CLI: no ambient actor, no sequential mode, hooks on.
const CLEAN_ENV = { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_ROOT: '', ECCODE_HOOKS: '', ECCODE_TEST: '', ECCODE_NOW: '' };

function codeOf(fn) {
  try {
    const r = fn();
    return { ok: true, result: r };
  } catch (err) {
    return { ok: false, code: err.code || err.name, message: err.message };
  }
}

/** Run scripts/hooks/guard.js as Claude Code would for a PreToolUse event. stdin is a pipe, never a TTY. */
function guard(payload) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: CLEAN_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  const parsed = res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
  return { exit: res.status, stderr: res.stderr.trim(), decision: parsed ? parsed.permissionDecision : 'allow (no output: guard has no opinion)', reason: parsed ? parsed.permissionDecisionReason : null };
}

function track(ctx) {
  tmpDirs.push(ctx.dir);
  return ctx;
}

/** Drive the architecture gate to 'escalated' (two rejections with maxReviewIterations=2). */
function escalateArchitecture(ctx) {
  const { dir, store, config } = ctx;
  gates.startGate(store, config, 'architecture', 'orchestrator');
  H.write(dir, '.eccode/artifacts/brief.md', H.ARCH_MD);
  gates.submit(store, config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  let { event } = gates.recordReview(store, config, 'architecture', 'architecture-reviewer', H.rejection('F1'));
  H.write(dir, '.eccode/artifacts/brief.md', H.ARCH_MD + '\nrev2\n');
  gates.submit(store, config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'], respondsTo: event.data.reviewId });
  gates.recordReview(store, config, 'architecture', 'architecture-reviewer', H.rejection('F2'));
  return store.state().gates.architecture;
}

/** A change-profile project that has been delivered once (mirrors tests/rework.test.js deliveredProject). */
function deliveredProject(configOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-probe-f5a-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  const store = init(dir, { name: 'Fix totals', idea: 'Invoice totals are wrong when a shipping fee is present', profile: 'change' });
  if (configOverrides) {
    const file = path.join(dir, '.eccode', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(configOverrides)) cfg[k] = { ...cfg[k], ...v };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  }
  const config = loadConfig(dir);
  gates.startGate(store, config, 'plan', 'orchestrator');
  H.write(dir, '.eccode/artifacts/plan.json', JSON.stringify(H.samplePlan(), null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', H.approval([['artifact:.eccode/artifacts/plan.json']]));
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    H.write(dir, file, `// ${id}\n`);
    tasks.complete(store, config, id, owner, H.handoffFor(id, owner, [H.passCheck(store, owner).id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const ev = H.passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', H.approval([[`ev:${ev.id}`]]));
  require(`${ROOT}/lib/delivery`).deliver(store, 'orchestrator');
  return { dir, store, config };
}

/** Lines in bin/ and lib/ that decide a user-only operation (so the report is tied to the current code). */
function scanUserChecks() {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/USER_AUTH_REQUIRED|!== 'user'|=== 'user'|!== USER\b|'orchestrator', 'user'|'user', 'orchestrator'/.test(line)) hits.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 150)}`);
        });
      }
    }
  };
  walk(`${ROOT}/lib`);
  walk(`${ROOT}/bin`);
  walk(`${ROOT}/scripts/hooks`);
  return hits;
}

try {
  // ------------------------------------------------------------------ Step 1: the guard, main session, no agent_type
  const p1 = track(H.tmpProject({ configOverrides: { limits: { maxReviewIterations: 2 } } }));
  const mainPayload = { cwd: p1.dir, tool_name: 'Bash', tool_input: { command: PROBE_CMD } }; // no agent_type: main session
  const g1 = guard(mainPayload);
  // Contrast: the identical command from a subagent, and from a non-ECCode agent type.
  const g1sub = guard({ ...mainPayload, agent_type: 'eccode:technical-reviewer' });
  const g1other = guard({ ...mainPayload, agent_type: 'general-purpose' });
  out.steps.guard_main_session = {
    payload: { tool_name: 'Bash', agent_type: '(absent)', command: PROBE_CMD },
    decision: g1.decision,
    reason: g1.reason,
    guard_stderr: g1.stderr,
    contrast_subagent_technical_reviewer: { decision: g1sub.decision, reason: g1sub.reason },
    contrast_agent_type_general_purpose: { decision: g1other.decision, reason: g1other.reason },
  };
  // Every other user-reserved CLI command from the main session: does the guard deny any of them?
  const userCmds = {
    risk_update_accepted: `node ${BIN} risk update --id R1 --status accepted --actor user`,
    rework_open: `node ${BIN} rework open --actor user --reason "defect found after delivery" --files 'src/**' --owner backend-engineer`,
    task_reset_escalated: `node ${BIN} task reset api --actor user --reason "re-scope the task"`,
    rebuild_force: `node ${BIN} rebuild --force --actor user`,
    improve_adopt: `node ${BIN} improve adopt imp-abc-00abcdef --actor user`,
    gate_reopen_verification: `node ${BIN} gate reopen verification --actor user --resolution "hotfix needed after delivery"`,
  };
  out.steps.guard_other_user_commands_main_session = Object.fromEntries(Object.entries(userCmds).map(([k, cmd]) => [k, guard({ cwd: p1.dir, tool_name: 'Bash', tool_input: { command: cmd } }).decision]));

  // ------------------------------------------------------------------ Step 2: run the guard-approved command for real
  const esc = escalateArchitecture(p1);
  const cli = spawnSync(process.execPath, [BIN, 'gate', 'reopen', 'architecture', '--actor', 'user', '--resolution', 'operator says so'], {
    cwd: p1.dir, encoding: 'utf8', env: CLEAN_ENV, stdio: ['ignore', 'pipe', 'pipe'], // stdin closed: no TTY, no prompt possible
  });
  const after = new Store(p1.dir).state();
  const lastEv = new Store(p1.dir).readEvents().pop();
  out.steps.cli_reopen_as_user = {
    gate_before: esc.status,
    exit: cli.status,
    stdout: cli.stdout.trim(),
    stderr: cli.stderr.trim(),
    gate_after: after.gates.architecture.status,
    open_findings_after: after.gates.architecture.openFindings.map((f) => f.id),
    last_event: { type: lastEv.type, actor: lastEv.actor, resolution: lastEv.data.resolution },
    // Every ECCODE_* variable the CLI could have consulted as proof of a human (none exist: the CLI reads only ECCODE_ROOT/ACTOR/TEST/NOW/HOOKS/SEQUENTIAL_ROLES/UNATTENDED/LEARNING/SHARED_MEMORY).
    eccode_env_seen_by_cli: Object.fromEntries(Object.entries(CLEAN_ENV).filter(([k]) => k.startsWith('ECCODE_'))),
  };

  // ------------------------------------------------------------------ Step 3: in-process gates.reopenGate, waive all
  const p2 = track(H.tmpProject({ configOverrides: { limits: { maxReviewIterations: 2 } } }));
  escalateArchitecture(p2);
  const r3deny = codeOf(() => gates.reopenGate(p2.store, 'architecture', 'orchestrator', 'Proceed with narrower scope'));
  const r3user = codeOf(() => gates.reopenGate(p2.store, 'architecture', 'user', 'Agent-typed resolution; no human present', { waive: 'all' }));
  const g2 = p2.store.state().gates.architecture;
  out.steps.reopenGate_in_process = {
    as_orchestrator: { code: r3deny.code, message: r3deny.message },
    as_user: { ok: r3user.ok, code: r3user.code, gate_status: g2.status, open_findings: g2.openFindings.map((f) => f.id), waived: (g2.waivedFindings || []).map((f) => `${f.id} by ${f.waivedBy}`) },
  };

  // ------------------------------------------------------------------ Step 4: runs.recordRisk status accepted
  runs.recordRisk(p2.store, 'product-architect', { id: 'R1', title: 'Prompt injection', severity: 'critical' });
  const r4deny = codeOf(() => runs.recordRisk(p2.store, 'orchestrator', { id: 'R1', status: 'accepted' }));
  const r4user = codeOf(() => runs.recordRisk(p2.store, 'user', { id: 'R1', status: 'accepted' }));
  out.steps.recordRisk_accepted = {
    as_orchestrator: { code: r4deny.code, message: r4deny.message },
    as_user: { ok: r4user.ok, code: r4user.code, risk_after: p2.store.state().risks.R1 },
  };

  // ------------------------------------------------------------------ Step 5: rework.openRework past limits.maxReworks
  const p3 = deliveredProject({ limits: { maxReworks: 1 } });
  const base = { reason: 'QA found a defect after delivery', files: ['src/**'], owner: 'backend-engineer' };
  rework.openRework(p3.store, p3.config, 'orchestrator', base);
  tasks.claim(p3.store, p3.config, 'rework-1', 'backend-engineer');
  H.write(p3.dir, 'src/server/a.js', '// fixed\n');
  tasks.complete(p3.store, p3.config, 'rework-1', 'backend-engineer', H.handoffFor('rework-1', 'backend-engineer', [H.passCheck(p3.store, 'backend-engineer').id], ['src/server/a.js']));
  gates.submit(p3.store, p3.config, 'phase:rework-1', 'delivery-lead');
  gates.recordReview(p3.store, p3.config, 'phase:rework-1', 'technical-reviewer', H.approval([[`ev:${H.passCheck(p3.store, 'technical-reviewer').id}`]]));
  const r5deny = codeOf(() => rework.openRework(p3.store, p3.config, 'orchestrator', base));
  const r5user = codeOf(() => rework.openRework(p3.store, p3.config, 'user', base));
  const st5 = p3.store.state();
  out.steps.openRework_past_cap = {
    maxReworks: p3.config.limits.maxReworks,
    as_orchestrator_second: { code: r5deny.code, message: r5deny.message },
    as_user_second: { ok: r5user.ok, code: r5user.code, id: r5user.ok ? r5user.result.id : null, gate_status: r5user.ok ? st5.gates[r5user.result.gate].status : null, reworks_recorded: (st5.reworks || []).length },
  };

  // ------------------------------------------------------------------ Step 6: tasks.reset of an escalated task
  const p4 = track(H.tmpProject({ configOverrides: { limits: { maxTaskRetries: 1 } } }));
  H.approveThroughPlan(p4);
  gates.startGate(p4.store, p4.config, 'phase:core', 'orchestrator');
  tasks.claim(p4.store, p4.config, 'api', 'backend-engineer');
  tasks.fail(p4.store, p4.config, 'api', 'backend-engineer', 'first attempt failed');
  tasks.claim(p4.store, p4.config, 'api', 'backend-engineer');
  tasks.fail(p4.store, p4.config, 'api', 'backend-engineer', 'second attempt failed');
  const beforeReset = p4.store.state().tasks.api.status;
  const r6deny = codeOf(() => tasks.reset(p4.store, 'api', 'orchestrator', 're-scope the task'));
  const r6user = codeOf(() => tasks.reset(p4.store, 'api', 'user', 'agent-typed user decision'));
  out.steps.taskReset_escalated = {
    status_before: beforeReset,
    as_orchestrator: { code: r6deny.code, message: r6deny.message },
    as_user: { ok: r6user.ok, code: r6user.code, status_after: p4.store.state().tasks.api.status },
  };

  // ------------------------------------------------------------------ Step 7: store.rebuildSnapshot --force on a rolled-back log
  const p5 = track(H.tmpProject());
  const log = path.join(p5.dir, '.eccode/events.jsonl');
  runs.recordRisk(p5.store, 'product-architect', { id: 'R1', title: 'a', severity: 'low' });
  const older = fs.readFileSync(log, 'utf8');
  runs.recordRisk(p5.store, 'product-architect', { id: 'R2', title: 'b', severity: 'low' });
  fs.writeFileSync(log, older); // the log was rolled back behind state.json
  const r7plain = codeOf(() => p5.store.rebuildSnapshot());
  const r7deny = codeOf(() => p5.store.rebuildSnapshot({ force: true, actor: 'orchestrator' }));
  const r7user = codeOf(() => p5.store.rebuildSnapshot({ force: true, actor: 'user' }));
  const last7 = p5.store.readEvents().pop();
  out.steps.rebuildForce_rolled_back_log = {
    without_force: { code: r7plain.code },
    as_orchestrator: { code: r7deny.code, message: r7deny.message },
    as_user: { ok: r7user.ok, code: r7user.code, last_event: { type: last7.type, actor: last7.actor }, audit_ok: p5.store.audit().ok },
  };

  // ------------------------------------------------------------------ Step 8: improve.adopt (requireUserForAdoption=true by default)
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-probe-shared-'));
  tmpDirs.push(shared);
  process.env.ECCODE_SHARED_MEMORY = shared;
  const p6 = track(H.tmpProject());
  const mem = new Memory(p6.store, p6.config);
  H.write(p6.dir, 'check.js', 'process.exit(require("fs").existsSync("fixed") ? 0 : 1)\n');
  const repro = evidence.runCommand(p6.store, 'learning-debugger', { label: 'repro', command: 'node check.js', purpose: 'reproduction' });
  H.write(p6.dir, 'fixed', 'yes');
  const fix = evidence.runCommand(p6.store, 'learning-debugger', { label: 'fix verified', command: 'node check.js' });
  const l = mem.add('learning-debugger', {
    layer: 'debugging',
    content: {
      title: 'JSON body parse fails on missing content-type',
      problem: 'POST /api/triage returned 500 when clients omitted the Content-Type header.',
      symptoms: ['HTTP 500 on POST without content-type'],
      component: 'api/server',
      environment: { node: '>=18' },
      fingerprint: 'api-json-parse-500',
      reproduction: { steps: ['POST without header'], evidence: [`ev:${repro.id}`] },
      rootCause: { explanation: 'The handler parsed the body unconditionally.', evidence: [`ev:${repro.id}`] },
      failedAttempts: [{ approach: 'Wrap only JSON.parse in try/catch', whyFailed: 'Empty bodies still crashed downstream' }],
      solution: { description: 'Validate content-type and parse defensively.', tradeoffs: 'Rejects lenient clients.' },
      verification: { evidence: [`ev:${fix.id}`], regressionTest: 'node check.js' },
      sources: [{ title: 'Node.js JSON.parse docs', url: 'https://nodejs.org/api/', checkedAt: '2026-10-07' }],
      appliesWhen: ['Node HTTP handlers parsing JSON request bodies'],
      notApplicableWhen: ['Frameworks that already enforce content-type'],
      confidence: 'high',
      tags: ['json', 'http', '500'],
    },
  });
  mem.review(l.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the failing check after the fix: passes.' });
  H.write(p6.dir, 'skills/checklist.md', '# Review checklist\n- tests pass\n');
  H.write(p6.dir, 'eval.js', 'const t=require("fs").readFileSync("skills/checklist.md","utf8");const cases=[/tests pass/.test(t),/content-type/i.test(t)];console.log("ECCODE_EVAL "+JSON.stringify({passed:cases.filter(Boolean).length,total:cases.length}));\n');
  const prop = improve.propose(p6.store, p6.config, mem, 'learning-debugger', {
    title: 'Add content-type check to review checklist',
    observation: 'Two reviews missed missing content-type validation.',
    lessons: [l.id],
    target: 'skills/checklist.md',
    change: { type: 'append', content: '- request content-type validated before parsing\n' },
    rationale: 'Lesson shows 500s from unvalidated bodies.',
    evaluation: { command: 'node eval.js', cases: 'checklist coverage cases' },
  });
  improve.evaluate(p6.store, 'learning-debugger', prop.id, 'baseline');
  improve.evaluate(p6.store, 'learning-debugger', prop.id, 'candidate');
  improve.review(p6.store, 'technical-reviewer', prop.id, 'approve', 'Candidate passes 2/2 vs 1/2 baseline; change is additive.');
  const r8deny = codeOf(() => improve.adopt(p6.store, p6.config, 'orchestrator', prop.id));
  const r8user = codeOf(() => improve.adopt(p6.store, p6.config, 'user', prop.id));
  out.steps.improveAdopt = {
    requireUserForAdoption: p6.config.improvement.requireUserForAdoption,
    as_orchestrator: { code: r8deny.code, message: r8deny.message },
    as_user: { ok: r8user.ok, code: r8user.code, status: r8user.ok ? r8user.result.status : null, adoptedBy: r8user.ok ? r8user.result.adoptedBy : null },
  };

  // ------------------------------------------------------------------ Verdict
  out.user_reserved_checks_in_current_code = scanUserChecks();
  out.human_presence_mechanisms_found = {
    tty_check: /isTTY/.test(fs.readFileSync(BIN, 'utf8')) || /isTTY/.test(fs.readFileSync(GUARD, 'utf8')),
    token_or_delegation_record: scanUserChecks().some((l) => /token|delegat/i.test(l)),
    note: 'The only identity binding is guard.js roleOf(input.agent_type): absent agent_type => role null => actor "user" passes.',
  };
  const guardAllowed = out.steps.guard_main_session.decision.startsWith('allow');
  const cliWorked = cli.status === 0 && after.gates.architecture.status === 'in_progress' && lastEv.actor === 'user';
  const engineAccepts = r3user.ok && r4user.ok && r5user.ok && r6user.ok && r7user.ok && r8user.ok;
  out.reproduces = Boolean(guardAllowed && cliWorked && engineAccepts);
  out.decisionPoint = 'scripts/hooks/guard.js:66-67 roleOf() returns null when agent_type is absent, so checkBash() at guard.js:270-275 only applies the "main session may not act as an agent ROLE" rule (user is not in ROLES) and allows --actor user; the engine then trusts the string at lib/gates.js:349 reopenGate, lib/runs.js:149 recordRisk, lib/rework.js:46/68 openRework, lib/tasks.js:385 reset, lib/store.js:212 rebuildSnapshot, lib/memory/improve.js:192 adopt.';
} catch (err) {
  out.reproduces = false;
  out.unexpected_error = { code: err.code, message: err.message, stack: (err.stack || '').split('\n').slice(0, 6).join(' | ') };
} finally {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

process.stdout.write(JSON.stringify(out) + '\n');
