'use strict';
// The Debugging Lab (Phase 2). On the debug and fix tracks a fix is not
// "edits until the test passes": the engine requires a reproduction it ran,
// hypotheses with predictions, evidence it executed for and against each, a
// confirmed root cause, and a proof on the same reproduction command. Every
// step is an event; every executed command is evidence with its artifact; the
// refuted hypotheses stay in the record and in the handoff.
//
// Enforced here, called from tasks.complete, gates.submit (through
// works.checkTrackRules) and delivery.preconditions:
//   1. no fix without a root cause that names a hypothesis closed `confirmed`
//      on executed, unchallenged `supports` evidence;
//   2. a hypothesis cannot be confirmed from prose: the evidence is a command
//      the engine ran, with its log present and hash-matching;
//   3. the reproduction command is pinned: the proof runs it, and replacing it
//      is the orchestrator's or the user's recorded decision;
//   4. a pre-existing test file changed by a fix must be declared, and the
//      reviewer must acknowledge the declaration;
//   5. after the hypothesis budget (count or time) an escalation is required
//      before another hypothesis;
//   6. refuted hypotheses are kept;
//   7. a trace probe left in the code refuses completion, submission and delivery.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const evidence = require('./evidence');
const { git, gitHead, gitChangedFiles, projectRelative } = require('./project');
const { EccodeError, newId, sha256, sha256File, writeFileAtomic, toPosix, exists, now, isoNow } = require('./util');
const lean = require('./lean');
const bugs = require('./bugs');

const LAB_TRACKS = new Set(['debug', 'fix']);
const VERDICTS = new Set(['supports', 'refutes', 'inconclusive']);
const PROBE_MARKER = 'eccode-trace-probe';
const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];

function normCmd(c) {
  return String(c == null ? '' : c).trim().replace(/\s+/g, ' ');
}

function onLabTrack(state) {
  return Boolean(state.lab && state.work && LAB_TRACKS.has(state.work.track) && state.work.status === 'active');
}

function assertLabTrack(state) {
  if (!state.work) throw new EccodeError('NOT_INITIALIZED', 'No work item: eccode debug "<bug>" or eccode work start --track fix first');
  if (!LAB_TRACKS.has(state.work.track)) throw new EccodeError('TRACK_RULE', `The Debugging Lab runs on debug and fix work items; ${state.work.id} is on the ${state.work.track} track`);
  if (state.work.status !== 'active') throw new EccodeError('INVALID_TRANSITION', `Work item ${state.work.id} is ${state.work.status}`);
}

/** Roles that investigate: the implementation authors (learning-debugger among them). */
function assertInvestigator(config, actor) {
  const allowed = config.roles.phase.authors;
  if (!allowed.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not record Debugging Lab steps; investigators: ${allowed.join(', ')}`);
}

function assertReviewer(config, actor) {
  const allowed = config.roles.phase.reviewers;
  if (!allowed.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not challenge evidence; reviewers: ${allowed.join(', ')}`);
}

function need(value, name, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min) throw new EccodeError('INVALID_INPUT', `${name} is required${min > 1 ? ` (>= ${min} chars)` : ''}`);
  return value.trim();
}

/** The interpreter that runs the project's Python tools: ECCODE_PYTHON, the project's venv, or python3. */
function pythonFor(root, flag) {
  if (flag) return flag;
  if (process.env.ECCODE_PYTHON) return process.env.ECCODE_PYTHON;
  for (const d of ['.venv', 'venv']) {
    for (const p of [path.join(root, d, 'bin', 'python'), path.join(root, d, 'Scripts', 'python.exe')]) if (exists(p)) return p;
  }
  return 'python3';
}

/** What the environment was when the bug was reproduced: no hostnames, no usernames, no values. */
function fingerprint(root, python) {
  const ver = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
    return r.status === 0 ? `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0] : null;
  };
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    python: ver(python || pythonFor(root), ['--version']),
    gitHead: gitHead(root),
    // Which variables are set, never their values.
    envHash: sha256(Object.keys(process.env).sort().join('\n')).slice(0, 16),
  };
}

// ---------------------------------------------------------------- repro

/**
 * Run the reproduction and pin it. The command runs as reproduction evidence
 * (the debug track's existing path), so there is one executed artifact; the
 * repro.recorded event references it. A command that passes reproduces
 * nothing and is refused (its run stays in the record as a check).
 */
function recordRepro(store, config, actor, { command, cwd, task, timeoutMs, replace = false, reason, python } = {}) {
  const cmd = need(command, 'the reproduction command', 1);
  const pre = store.state();
  assertLabTrack(pre);
  if (replace) {
    if (!['orchestrator', 'user'].includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', 'Replacing the pinned reproduction is a decision of the orchestrator or the user (--actor orchestrator|user --replace --reason "<why>")');
    need(reason, '--reason', 10);
  } else {
    assertInvestigator(config, actor);
    if (pre.lab.repro) throw new EccodeError('REPRO_PINNED', `The reproduction is pinned to ${JSON.stringify(pre.lab.repro.command)} (${pre.lab.repro.id}). The proof must run that command; to change it, the orchestrator or the user records eccode debug repro --replace --reason "<why>" -- <command>`);
  }
  const ev = evidence.runCommand(store, actor, { label: 'repro', command: cmd, cwd, task, purpose: 'reproduction', timeoutMs, extra: { repro: true } });
  if (ev.integrity) throw new EccodeError('INTEGRITY', `The reproduction run failed the integrity window (${ev.integrity.join('; ')}); not pinned`);
  if (ev.exitCode === 0) throw new EccodeError('REPRO_PASSED', `The command passed (exit 0), so it reproduces nothing; it is recorded as a check (ev:${ev.id}), not as the reproduction. Write a test or command that fails for the reported symptom.`);
  const data = {
    id: newId('rp'),
    evidence: ev.id,
    command: ev.command,
    cwd: ev.cwd,
    fingerprint: fingerprint(store.root, python),
    exitCode: ev.exitCode,
    logSha256: ev.logSha256,
    failing: true,
    task: task || null,
    replaces: replace && pre.lab.repro ? pre.lab.repro.id : null,
    reason: replace ? reason.trim() : null,
  };
  const { event } = store.commit('repro.recorded', actor, data, (state) => {
    assertLabTrack(state);
    if (!replace && state.lab.repro) throw new EccodeError('REPRO_PINNED', `A reproduction was pinned while this one ran (${state.lab.repro.id})`);
  });
  return { repro: event.data, evidence: ev };
}

// ---------------------------------------------------------- hypotheses

function budgetProblem(state, config) {
  const lab = state.lab;
  const lastEscalation = lab.escalations[lab.escalations.length - 1];
  const since = lastEscalation ? lastEscalation.at : '';
  const spent = Object.values(lab.hypotheses).filter((h) => ['refuted', 'withdrawn'].includes(h.status) && h.closedAt > since);
  if (spent.length >= config.lab.hypothesisBudget) {
    return `${spent.length} hypotheses refuted or withdrawn (budget ${config.lab.hypothesisBudget}) since ${lastEscalation ? 'the last escalation' : 'the investigation began'}`;
  }
  const from = [lab.repro && lab.repro.at, since].filter(Boolean).sort().pop();
  if (from) {
    const minutes = (now().getTime() - new Date(from).getTime()) / 60000;
    if (minutes >= config.lab.timeBudgetMinutes) return `${Math.round(minutes)} minutes since ${lastEscalation ? 'the last escalation' : 'the reproduction'} (budget ${config.lab.timeBudgetMinutes})`;
  }
  return null;
}

function openHypothesis(store, config, actor, { statement, ifTrue, ifFalse } = {}) {
  const s = need(statement, 'the hypothesis statement', 10);
  const t = need(ifTrue, '--if-true (the observation if the hypothesis holds)', 5);
  const f = need(ifFalse, '--if-false (the observation if it does not)', 5);
  if (normCmd(t) === normCmd(f)) throw new EccodeError('INVALID_INPUT', 'A hypothesis is falsifiable only when --if-true and --if-false predict different observations');
  assertInvestigator(config, actor);
  let id;
  const { event } = store.commit('hypothesis.opened', actor, { statement: s, ifTrue: t, ifFalse: f }, (state) => {
    assertLabTrack(state);
    if (!state.lab.repro) throw new EccodeError('REPRO_REQUIRED', 'Reproduce first: eccode debug repro --actor <you> -- <command that fails for the symptom>, then hypothesize');
    const over = budgetProblem(state, config);
    if (over) {
      throw new EccodeError('LAB_BUDGET', `Hypothesis budget spent: ${over}. More blind attempts are not allowed; record an escalation first (eccode debug escalate --kind rescope|ask-user --reason "<what to change or ask>" --actor <you>), or ask the orchestrator to.`, {
        refuted: Object.values(state.lab.hypotheses).filter((h) => h.status === 'refuted').map((h) => `${h.id}: ${h.statement}`),
      });
    }
    id = `h${Object.keys(state.lab.hypotheses).length + 1}`;
    return { id };
  });
  return event.data;
}

/** Run a discriminating command for a hypothesis; the verdict may be given now or marked later. */
function testHypothesis(store, config, actor, { hypothesis, command, verdict, note, cwd, task, timeoutMs } = {}) {
  const cmd = need(command, 'the command to run', 1);
  if (verdict !== undefined && verdict !== null && !VERDICTS.has(verdict)) throw new EccodeError('INVALID_INPUT', 'verdict must be supports, refutes or inconclusive');
  assertInvestigator(config, actor);
  const pre = store.state();
  assertLabTrack(pre);
  const h = pre.lab.hypotheses[hypothesis];
  if (!h) throw new EccodeError('NOT_FOUND', `Unknown hypothesis ${hypothesis}`);
  if (h.status !== 'open') throw new EccodeError('INVALID_TRANSITION', `Hypothesis ${hypothesis} is ${h.status}`);
  const ev = evidence.runCommand(store, actor, { label: `hypothesis ${hypothesis}`, command: cmd, cwd, task, purpose: 'check', timeoutMs, extra: { hypothesis } });
  return recordHypothesisEvidence(store, config, actor, { hypothesis, evidence: ev.id, verdict: verdict || 'pending', note });
}

/**
 * The one path to a hypothesis.evidence event: it names an evidence run of
 * kind command that the engine executed for this hypothesis (the run carries
 * the hypothesis id) with its log present and hash-matching. Nothing pasted
 * can satisfy that.
 */
function recordHypothesisEvidence(store, config, actor, { hypothesis, evidence: evId, verdict, note, trace } = {}) {
  const id = newId('he');
  const { event } = store.commit('hypothesis.evidence', actor, { id, hypothesis, evidence: evId, verdict: verdict || 'pending', note: note || null, ...(trace ? { trace } : {}) }, (state) => {
    assertLabTrack(state);
    const h = state.lab.hypotheses[hypothesis];
    if (!h) throw new EccodeError('NOT_FOUND', `Unknown hypothesis ${hypothesis}`);
    if (h.status !== 'open') throw new EccodeError('INVALID_TRANSITION', `Hypothesis ${hypothesis} is ${h.status}`);
    const why = executedReason(state, store.root, evId, hypothesis);
    if (why) throw new EccodeError('EVIDENCE_NOT_EXECUTED', `Hypothesis evidence must be a command the engine ran for ${hypothesis}: ${why}`);
    return { command: state.evidence[evId].command, exitCode: state.evidence[evId].exitCode, logSha256: state.evidence[evId].logSha256 };
  });
  return event.data;
}

/** Why an evidence id is not an executed run for this hypothesis; null when it is. */
function executedReason(state, root, evId, hypothesis) {
  const ev = state.evidence[evId];
  if (!ev) return `ev:${evId} does not exist in the record`;
  if (ev.kind !== 'command') return `ev:${evId} is of kind ${ev.kind}, not an executed command`;
  if (ev.hypothesis !== hypothesis) return `ev:${evId} was not run for ${hypothesis}${ev.hypothesis ? ` (it was run for ${ev.hypothesis})` : ''}`;
  if (!root) return null; // no tree to read: the record's own consistency is all that can be checked
  if (!ev.log || !exists(path.join(root, ev.log))) return `the log of ev:${evId} (${ev.log}) is missing`;
  const text = fs.readFileSync(path.join(root, ev.log), 'utf8');
  if (sha256(text.split('\n').slice(3).join('\n')) !== ev.logSha256) return `the log of ev:${evId} no longer matches its recorded hash`;
  return null;
}

/** Mark the verdict of evidence recorded as pending (after reading the artifact). */
function markEvidence(store, config, actor, { evidence: heId, verdict, note } = {}) {
  if (!VERDICTS.has(verdict)) throw new EccodeError('INVALID_INPUT', 'verdict must be supports, refutes or inconclusive');
  assertInvestigator(config, actor);
  return store.commit('hypothesis.marked', actor, { evidence: heId, verdict, note: note || null }, (state) => {
    assertLabTrack(state);
    const e = state.lab.evidence[heId];
    if (!e) throw new EccodeError('NOT_FOUND', `Unknown hypothesis evidence ${heId}`);
    if (e.verdict !== 'pending') throw new EccodeError('INVALID_TRANSITION', `${heId} is already marked ${e.verdict}; evidence is marked once (a reviewer may challenge it)`);
    if (e.challenged) throw new EccodeError('INVALID_TRANSITION', `${heId} was challenged by ${e.challenged.by}; it cannot be marked`);
  }).event.data;
}

function challengeEvidence(store, config, actor, { evidence: heId, reason } = {}) {
  assertReviewer(config, actor);
  const r = need(reason, '--reason', 10);
  return store.commit('hypothesis.challenged', actor, { evidence: heId, reason: r }, (state) => {
    assertLabTrack(state);
    const e = state.lab.evidence[heId];
    if (!e) throw new EccodeError('NOT_FOUND', `Unknown hypothesis evidence ${heId}`);
    if (e.challenged) throw new EccodeError('INVALID_TRANSITION', `${heId} is already challenged`);
    return { hypothesis: e.hypothesis };
  }).event.data;
}

/** Hypothesis evidence that supports its hypothesis, unchallenged, and executed by the engine. */
function validSupports(state, root, h) {
  return (h.evidence || [])
    .map((id) => state.lab.evidence[id])
    .filter((e) => e && e.verdict === 'supports' && !e.challenged && !executedReason(state, root, e.evidence, h.id));
}

function closeHypothesis(store, config, actor, { hypothesis, status } = {}) {
  if (!['confirmed', 'refuted', 'withdrawn'].includes(status)) throw new EccodeError('INVALID_INPUT', '--status must be confirmed, refuted or withdrawn');
  assertInvestigator(config, actor);
  return store.commit('hypothesis.closed', actor, { hypothesis, status }, (state) => {
    assertLabTrack(state);
    const h = state.lab.hypotheses[hypothesis];
    if (!h) throw new EccodeError('NOT_FOUND', `Unknown hypothesis ${hypothesis}`);
    if (h.status !== 'open') throw new EccodeError('INVALID_TRANSITION', `Hypothesis ${hypothesis} is already ${h.status}`);
    const all = h.evidence.map((id) => state.lab.evidence[id]).filter(Boolean);
    if (status === 'confirmed') {
      const ok = validSupports(state, store.root, h);
      if (!ok.length) {
        const pending = all.filter((e) => e.verdict === 'pending').length;
        throw new EccodeError('EVIDENCE_REQUIRED', `Hypothesis ${hypothesis} cannot be confirmed from prose: it needs at least one executed, unchallenged piece of evidence marked supports (eccode debug hypothesis test ${hypothesis} --supports --actor <you> -- <command>)${pending ? `; ${pending} recorded run(s) are still unmarked (eccode debug hypothesis mark <id> --supports|--refutes)` : ''}`);
      }
      return { evidence: ok.map((e) => e.id) };
    }
    if (status === 'refuted') {
      const against = all.filter((e) => e.verdict === 'refutes' && !e.challenged && !executedReason(state, store.root, e.evidence, h.id));
      if (!against.length) throw new EccodeError('EVIDENCE_REQUIRED', `Hypothesis ${hypothesis} is refuted by evidence, not by a change of mind: run a command and mark it --refutes, or close it --status withdrawn (withdrawn hypotheses count toward the budget too)`);
      return { evidence: against.map((e) => e.id) };
    }
    return { evidence: [] };
  }).event.data;
}

function escalate(store, config, actor, { kind, reason } = {}) {
  if (!['rescope', 'ask-user'].includes(kind)) throw new EccodeError('INVALID_INPUT', '--kind must be rescope or ask-user');
  const r = need(reason, '--reason', 10);
  if (actor !== 'orchestrator' && !config.roles.phase.authors.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not escalate the investigation`);
  return store.commit('lab.escalated', actor, { kind, reason: r }, (state) => {
    assertLabTrack(state);
    const lab = state.lab;
    const refuted = Object.values(lab.hypotheses).filter((h) => h.status === 'refuted').length;
    const withdrawn = Object.values(lab.hypotheses).filter((h) => h.status === 'withdrawn').length;
    const from = lab.repro ? new Date(lab.repro.at).getTime() : null;
    return { refuted, withdrawn, elapsedMinutes: from ? Math.round((now().getTime() - from) / 60000) : null };
  }).event.data;
}

// ---------------------------------------------------------- root cause

function parseLocation(root, loc) {
  const m = /^(.+?):(\d+)$/.exec(String(loc).trim());
  if (!m) throw new EccodeError('INVALID_INPUT', `${loc} is not a file:line location`);
  const rel = projectRelative(root, m[1]);
  if (!exists(path.join(root, rel))) throw new EccodeError('NOT_FOUND', `${rel} does not exist`);
  return `${rel}:${Number(m[2])}`;
}

function declareRootCause(store, config, actor, { hypothesis, locations, explanation, whyReproFails } = {}) {
  assertInvestigator(config, actor);
  const expl = need(explanation, '--explain (the causal explanation)', 20);
  const why = need(whyReproFails, '--why-repro-fails (how the cause produces the reproduced failure)', 10);
  const list = [].concat(locations || []).flatMap((l) => String(l).split(',')).map((l) => l.trim()).filter(Boolean);
  if (!list.length) throw new EccodeError('INVALID_INPUT', '--at <file:line>[,<file:line>] names where the cause is');
  const locs = list.map((l) => parseLocation(store.root, l));
  return store.commit('rootcause.declared', actor, { hypothesis, locations: locs, explanation: expl, whyReproFails: why }, (state) => {
    assertLabTrack(state);
    if (!state.lab.repro) throw new EccodeError('REPRO_REQUIRED', 'No reproduction is pinned (eccode debug repro)');
    const h = state.lab.hypotheses[hypothesis];
    if (!h) throw new EccodeError('NOT_FOUND', `Unknown hypothesis ${hypothesis}`);
    if (h.status !== 'confirmed') throw new EccodeError('HYPOTHESIS_NOT_CONFIRMED', `Hypothesis ${hypothesis} is ${h.status}; a root cause names a confirmed hypothesis`);
    if (!validSupports(state, store.root, h).length) throw new EccodeError('EVIDENCE_REQUIRED', `Hypothesis ${hypothesis} has no valid supporting evidence left (challenged, or its artifact is gone)`);
    return { evidence: validSupports(state, store.root, h).map((e) => e.id) };
  }).event.data;
}

/** Why no fix may be submitted yet, or null: a confirmed, evidence-backed root cause exists. */
function rootCauseProblem(state, root = null) {
  const lab = state.lab;
  if (!lab.repro) return 'lab: no reproduction is pinned. Run eccode debug repro --actor <owner> -- "<command that fails for the symptom>" before any fix.';
  if (!lab.rootCause) {
    const open = Object.values(lab.hypotheses).filter((h) => h.status === 'open').length;
    return `lab: no root cause declared. Open hypotheses with predictions (eccode debug hypothesis add), test each with an executed command (eccode debug hypothesis test), close the confirmed one, then eccode debug rootcause --hypothesis <id> --at <file:line> --explain "..." --why-repro-fails "..."${open ? ` (${open} hypothesis(es) still open)` : ''}`;
  }
  const h = lab.hypotheses[lab.rootCause.hypothesis];
  if (!h || h.status !== 'confirmed') return `lab: the root cause names ${lab.rootCause.hypothesis}, which is ${h ? h.status : 'unknown'}, not confirmed`;
  if (!validSupports(state, root, h).length) return `lab: the root cause's hypothesis ${h.id} has no valid executed supporting evidence (challenged by a reviewer, or its artifact changed); declare it again on evidence that holds`;
  return null;
}

// ---------------------------------------------------------- trace probes

const PROBE = {
  py: (id, expr) => `__import__("sys").stderr.write("ECCODE_TRACE ${id} " + repr(${expr}) + "\\n")  # ${PROBE_MARKER} ${id}`,
  js: (id, expr) => `process.stderr.write("ECCODE_TRACE ${id} " + JSON.stringify(${expr}) + "\\n"); // ${PROBE_MARKER} ${id}`,
};

function probeRecoveryFile(root) {
  return path.join(root, '.eccode', 'cache', 'trace-restore.json');
}

/** Put back a file a killed trace left probed; returns its path or null. */
function recoverProbe(root) {
  const f = probeRecoveryFile(root);
  if (!exists(f)) return null;
  const { file, content } = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(path.join(root, file), Buffer.from(content, 'base64'));
  fs.rmSync(f, { force: true });
  return file;
}

/**
 * A temporary probe that logs an expression's value during the reproduction,
 * recorded as hypothesis evidence with the observed values, then reverted.
 * The probe runs before the statement at `at`; the expression must be valid
 * in that scope.
 */
function trace(store, config, actor, { hypothesis, at, expr, task, timeoutMs } = {}) {
  assertInvestigator(config, actor);
  const e = need(expr, '--expr', 1);
  const pre = store.state();
  assertLabTrack(pre);
  if (!pre.lab.repro) throw new EccodeError('REPRO_REQUIRED', 'A trace probe runs the pinned reproduction: eccode debug repro first');
  const h = pre.lab.hypotheses[hypothesis];
  if (!h) throw new EccodeError('NOT_FOUND', `Unknown hypothesis ${hypothesis}`);
  if (h.status !== 'open') throw new EccodeError('INVALID_TRANSITION', `Hypothesis ${hypothesis} is ${h.status}`);
  const [rel, lineNo] = parseLocation(store.root, at).split(/:(?=\d+$)/);
  const line = Number(lineNo);
  const lang = /\.py$/.test(rel) ? 'py' : /\.(js|cjs|mjs)$/.test(rel) ? 'js' : null;
  if (!lang) throw new EccodeError('LAB_UNSUPPORTED', `Trace probes are built for Python and JavaScript files; ${rel} is neither (docs/limits.md)`);
  const abs = path.join(store.root, rel);
  const recovered = recoverProbe(store.root);
  const original = fs.readFileSync(abs);
  const lines = original.toString('utf8').split('\n');
  if (line < 1 || line > lines.length) throw new EccodeError('INVALID_INPUT', `${rel} has ${lines.length} lines; line ${line} does not exist`);
  const indent = (lines[line - 1].match(/^[ \t]*/) || [''])[0];
  const heId = newId('he');
  const probe = `${indent}${PROBE[lang](heId, e)}`;
  const probed = [...lines.slice(0, line - 1), probe, ...lines.slice(line - 1)].join('\n');
  fs.mkdirSync(path.dirname(probeRecoveryFile(store.root)), { recursive: true });
  fs.writeFileSync(probeRecoveryFile(store.root), JSON.stringify({ file: rel, content: original.toString('base64') }));
  let ev;
  try {
    fs.writeFileSync(abs, probed);
    if (require('./mutate').parses(rel, probed) === false) {
      throw new EccodeError('INVALID_INPUT', `A probe before ${rel}:${line} does not parse (the line is inside an expression or a block header); name a statement line in the scope where ${JSON.stringify(e)} is valid`);
    }
    ev = evidence.runCommand(store, actor, { label: `trace ${hypothesis} ${rel}:${line}`, command: pre.lab.repro.command, cwd: pre.lab.repro.cwd === '.' ? undefined : pre.lab.repro.cwd, task, purpose: 'check', timeoutMs, extra: { hypothesis, trace: { file: rel, line, expr: e } } });
  } finally {
    fs.writeFileSync(abs, original);
    fs.rmSync(probeRecoveryFile(store.root), { force: true });
  }
  if (sha256File(abs) !== sha256(original)) throw new EccodeError('INTEGRITY', `${rel} could not be restored after the trace; restore it from git`);
  const log = fs.readFileSync(path.join(store.root, ev.log), 'utf8');
  const values = [];
  // Test runners may prefix forwarded stderr (node --test writes "# " before it).
  for (const m of log.matchAll(new RegExp(`ECCODE_TRACE ${heId} ([^\\n]*)`, 'g'))) values.push(m[1].trimEnd());
  const data = recordHypothesisEvidence(store, config, actor, { hypothesis, evidence: ev.id, verdict: 'pending', note: `trace ${rel}:${line} ${e}`, trace: { file: rel, line, expr: e, values: values.slice(0, 200), observed: values.length, recovered } });
  return { ...data, values };
}

/** Files among `files` that still contain a trace probe marker. */
function probeLeftovers(root, files) {
  const out = [];
  for (const f of files || []) {
    const abs = path.join(root, f);
    if (!exists(abs) || !fs.statSync(abs).isFile()) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes(PROBE_MARKER)) out.push(f);
  }
  return out;
}

// ------------------------------------------------------- localization

/** Pytest arguments of a reproduction command, or null when it is not a pytest run. */
function pytestArgs(command) {
  const m = /^(?:(?:uv|poetry|pdm|hatch|pipenv)\s+run\s+|python3?\s+-m\s+|\S*\/python3?\s+-m\s+)?pytest(?:\s+(.*))?$/.exec(normCmd(command));
  if (!m) return null;
  return (m[1] || '').split(' ').filter(Boolean);
}

/** The test paths (files or directories) among pytest arguments. */
function testPaths(args) {
  return args.filter((a) => !a.startsWith('-')).map((a) => a.split('::')[0]);
}

function ochiai(ef, ep, nf) {
  const d = Math.sqrt((ef + nf) * (ef + ep));
  return d ? ef / d : 0;
}

/**
 * Spectrum-based fault localization: the failing reproduction and the
 * passing tests run once under coverage with one context per test; each line
 * gets the Ochiai score of its spectrum. Python (pytest + coverage.py) only.
 */
function localizeSbfl(store, config, actor, { tests, top, python, task, timeoutMs } = {}) {
  assertInvestigator(config, actor);
  const pre = store.state();
  assertLabTrack(pre);
  if (!pre.lab.repro) throw new EccodeError('REPRO_REQUIRED', 'SBFL runs the pinned reproduction with the passing tests: eccode debug repro first');
  const reproArgs = pytestArgs(pre.lab.repro.command);
  if (!reproArgs) throw new EccodeError('LAB_UNSUPPORTED', `SBFL needs a pytest reproduction; ${JSON.stringify(pre.lab.repro.command)} is not one (JavaScript localization is not built: docs/limits.md)`);
  const root = store.root;
  const py = pythonFor(root, python);
  const probe = spawnSync(py, ['-c', 'import coverage, pytest'], { encoding: 'utf8', timeout: 20000 });
  if (probe.status !== 0) throw new EccodeError('NOT_FOUND', `${py} lacks coverage or pytest (${(probe.stderr || probe.error && probe.error.message || '').trim().split('\n').pop()}). Install them in the project's environment, or point ECCODE_PYTHON (or --python) at one that has them.`);
  const extra = [].concat(tests || []).flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean);
  for (const t of extra) if (!exists(path.join(root, t.split('::')[0]))) throw new EccodeError('NOT_FOUND', `--tests ${t} does not exist`);
  const defaults = extra.length ? [] : [...new Set(testPaths(reproArgs).map((p) => (exists(path.join(root, p)) && fs.statSync(path.join(root, p)).isFile() ? path.dirname(p) : p)))];
  const passing = extra.length ? extra : defaults;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-sbfl-'));
  const out = path.join(work, 'spectrum.json');
  const script = path.join(__dirname, '..', 'scripts', 'lab', 'sbfl.py');
  const q = (a) => (/^[\w./:@+\[\]=,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  const command = [q(py), q(script), '--work', q(work), '--out', q(out), '--', ...reproArgs.map(q), ...passing.filter((p) => !reproArgs.includes(p)).map(q)].join(' ');
  let ev;
  let spectrum;
  try {
    ev = evidence.runCommand(store, actor, { label: 'localize: sbfl', command, task, purpose: 'check', timeoutMs: timeoutMs || 1200000, extra: { localization: 'sbfl' } });
    if (!exists(out)) throw new EccodeError('LAB_FAILED', `The spectrum run produced no data (ev:${ev.id}, exit ${ev.exitCode}):\n${ev.outputTail}`);
    spectrum = JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const failedTests = Object.entries(spectrum.tests).filter(([, s]) => s === 'failed').map(([k]) => k);
  const passedTests = Object.entries(spectrum.tests).filter(([, s]) => s === 'passed').map(([k]) => k);
  const isFailed = (ctx) => failedTests.some((k) => k === ctx || k.endsWith(`.${ctx}`));
  const isPassed = (ctx) => passedTests.some((k) => k === ctx || k.endsWith(`.${ctx}`));
  const scored = [];
  for (const [file, perLine] of Object.entries(spectrum.lines)) {
    const rel = toPosix(path.isAbsolute(file) ? path.relative(root, file) : file);
    if (rel.startsWith('..') || lean.TEST.test(rel) || !bugs.isCode(rel)) continue;
    for (const [line, contexts] of Object.entries(perLine)) {
      const ef = new Set(contexts.filter(isFailed)).size;
      const ep = new Set(contexts.filter(isPassed)).size;
      if (!ef) continue;
      scored.push({ file: rel, line: Number(line), ef, ep, score: ochiai(ef, ep, failedTests.length - ef) });
    }
  }
  // Ties: a line more failing tests reach ranks above one fewer passing tests reach.
  scored.sort((a, b) => b.score - a.score || b.ef - a.ef || a.ep - b.ep || a.file.localeCompare(b.file) || a.line - b.line);
  const k = Number(top || config.lab.topSuspects);
  const suspects = scored.slice(0, k).map((s) => ({ ...s, score: Math.round(s.score * 1000) / 1000 }));
  const id = newId('loc');
  const artifactRel = `.eccode/lab/${id}.json`;
  const artifact = { id, method: 'sbfl', command, failingTests: failedTests, passingTests: passedTests.length, linesScored: scored.length, ranking: scored.slice(0, 200) };
  const text = JSON.stringify(artifact, null, 2) + '\n';
  writeFileAtomic(path.join(root, artifactRel), text);
  const data = {
    id, method: 'sbfl', suspects, evidence: ev.id, command, tests: passing,
    totals: { failing: failedTests.length, passing: passedTests.length, collected: spectrum.collected, linesScored: scored.length },
    status: failedTests.length ? 'ranked' : 'no-failing-test',
    artifact: artifactRel, artifactSha256: sha256(text),
  };
  store.commit('localization.result', actor, data, (state) => assertLabTrack(state));
  return data;
}

/**
 * git bisect run with the pinned reproduction, in a detached worktree so the
 * working tree is never touched; uncommitted test files ride along so a new
 * regression test can be the reproduction. Records the first bad commit and
 * its diff as the artifact.
 */
function bisect(store, config, actor, { good, bad, task, timeoutMs } = {}) {
  assertInvestigator(config, actor);
  const pre = store.state();
  assertLabTrack(pre);
  if (!pre.lab.repro) throw new EccodeError('REPRO_REQUIRED', 'Bisect runs the pinned reproduction: eccode debug repro first');
  const root = store.root;
  const goodSha = good && git(root, ['rev-parse', '--verify', `${good}^{commit}`]);
  if (!goodSha) throw new EccodeError('INVALID_INPUT', `--good <ref> must name a commit where the reproduction passes${good ? ` (${good} is unknown)` : ''}`);
  const badRef = bad || 'HEAD';
  const badSha = git(root, ['rev-parse', '--verify', `${badRef}^{commit}`]);
  if (!badSha) throw new EccodeError('INVALID_INPUT', `Unknown --bad ${badRef}`);
  if (goodSha === badSha) throw new EccodeError('INVALID_INPUT', '--good and --bad name the same commit');
  const top = git(root, ['rev-parse', '--show-toplevel']);
  const prefix = git(root, ['rev-parse', '--show-prefix']) || '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-bisect-'));
  const wt = path.join(tmp, 'bisect');
  if (git(top, ['worktree', 'add', '--detach', '--quiet', wt, badSha]) === null) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new EccodeError('GIT_FAILED', `Could not create a worktree at ${badRef}`);
  }
  const headBefore = gitHead(root);
  let ev;
  let first = null;
  let ends = { good: null, bad: null };
  let problem = null;
  try {
    const wtRoot = path.join(wt, prefix);
    // The new regression test (uncommitted) is the reproduction: copy the changed test files in.
    for (const f of (gitChangedFiles(root, 'HEAD') || []).map(toPosix).filter((f) => lean.TEST.test(f) && exists(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile())) {
      fs.mkdirSync(path.dirname(path.join(wtRoot, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(wtRoot, f));
    }
    for (const d of DEP_DIRS) {
      if (exists(path.join(root, d)) && !exists(path.join(wtRoot, d))) fs.symlinkSync(path.join(root, d), path.join(wtRoot, d), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const repro = pre.lab.repro.command;
    const sq = (c) => `'${c.replace(/'/g, "'\\''")}'`;
    // The reproduction is checked at both ends first: it must pass at --good
    // and fail at --bad, and it must be runnable at all (exit 126/127 is a
    // missing program, which would read as "bad" at every commit).
    const probe = (ref, name) => `git checkout -q ${ref} && sh -c ${sq(repro)}; echo "ECCODE_${name}_EXIT=$?"`;
    const command = `${probe(goodSha, 'GOOD')}; ${probe(badSha, 'BAD')}; git bisect start ${badSha} ${goodSha} && git bisect run sh -c ${sq(repro)}`;
    ev = evidence.runCommand(store, actor, { label: 'localize: bisect', command, task, purpose: 'check', timeoutMs: timeoutMs || 1800000, externalCwd: wtRoot, cwdLabel: `bisect worktree ${goodSha.slice(0, 12)}..${badSha.slice(0, 12)}`, extra: { localization: 'bisect' } });
    const log = fs.readFileSync(path.join(root, ev.log), 'utf8');
    git(wt, ['bisect', 'reset']);
    const exitOf = (name) => { const x = new RegExp(`ECCODE_${name}_EXIT=(\\d+)`).exec(log); return x ? Number(x[1]) : null; };
    ends = { good: exitOf('GOOD'), bad: exitOf('BAD') };
    if ([ends.good, ends.bad].some((x) => x === 126 || x === 127)) {
      problem = `the reproduction command is not runnable in the worktree (exit ${ends.good === 127 || ends.bad === 127 ? 127 : 126}: a program on the command line is missing or not executable there); write it as the project's interpreter would run it (python -m pytest …)`;
    } else if (ends.good !== 0) problem = `the reproduction does not pass at --good ${goodSha.slice(0, 12)} (exit ${ends.good}); bisect needs a known good commit`;
    else if (ends.bad === 0) problem = `the reproduction passes at --bad ${badSha.slice(0, 12)} (exit 0); it must fail there`;
    else {
      const m = /^([0-9a-f]{40}) is the first bad commit/m.exec(log);
      if (m) first = m[1];
    }
  } finally {
    git(top, ['worktree', 'remove', '--force', wt]);
    git(top, ['worktree', 'prune']);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (gitHead(root) !== headBefore) throw new EccodeError('INTEGRITY', 'bisect moved the working tree HEAD; this must never happen');
  const id = newId('loc');
  const artifactRel = `.eccode/lab/${id}.diff`;
  const subject = first ? git(root, ['log', '-1', '--format=%s', first]) : null;
  const text = first ? `${git(root, ['show', '--stat', '-p', '--format=commit %H%nAuthor: (redacted)%nDate: %ad%n%n    %s%n', first]) || ''}\n` : `bisect found no first bad commit (ev:${ev.id}, exit ${ev.exitCode})${problem ? `: ${problem}` : ''}\n`;
  writeFileAtomic(path.join(root, artifactRel), text);
  const data = {
    id, method: 'bisect', good: goodSha, bad: badSha, evidence: ev.id, ends,
    suspects: first ? [{ commit: first, subject }] : [],
    status: first ? 'found' : 'not-found',
    ...(problem ? { problem } : {}),
    artifact: artifactRel, artifactSha256: sha256(text),
  };
  store.commit('localization.result', actor, data, (state) => assertLabTrack(state));
  return data;
}

// -------------------------------------------------------- test edits

/**
 * Pre-existing test files (present at the claim base) whose existing lines a
 * fix changed or removed. A new test file, or a test appended to an existing
 * file (additions only), is the regression test and is free; rewriting an
 * existing assertion is how a "fix" makes a test agree with the bug, so it
 * must be declared and acknowledged.
 */
function changedExistingTests(root, base, changed) {
  const out = [];
  for (const f of (changed || []).map(toPosix)) {
    if (!lean.TEST.test(f) || f.startsWith('.eccode/')) continue;
    if (!base || git(root, ['cat-file', '-e', `${base}:${f}`]) === null) continue;
    const stat = git(root, ['diff', '--numstat', base, '--', f]);
    if (stat === null) continue;
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(stat);
    const deleted = m ? (m[2] === '-' ? 1 : Number(m[2])) : (exists(path.join(root, f)) ? 0 : 1);
    if (deleted > 0 || !exists(path.join(root, f))) out.push(f);
  }
  return out;
}

/** Completion problems of the Lab for a claimed task on a debug or fix track. */
function completionProblems(state, root, task, handoff, changedSinceClaim) {
  if (!onLabTrack(state)) return [];
  const problems = [];
  const changed = (changedSinceClaim || []).map(toPosix).filter((f) => !f.startsWith('.eccode/'));
  const code = changed.filter((f) => bugs.isCode(f) && !lean.TEST.test(f));
  if (code.length) {
    const rc = rootCauseProblem(state, root);
    if (rc) problems.push(rc);
  }
  const declared = new Map((Array.isArray(handoff.testChanges) ? handoff.testChanges : []).filter((t) => t && typeof t.file === 'string').map((t) => [toPosix(path.normalize(t.file)), t]));
  const base = task.claim && task.claim.baseCommit;
  for (const f of changedExistingTests(root, base, changed)) {
    if (!declared.has(f)) problems.push(`lab: ${f} is a test file that existed before the fix, and the fix changed or removed lines of it; declare it in handoff.testChanges [{file, reason}] (the reviewer must acknowledge it). Fix the bug, not the test: a new test file, or a test added to an existing file, needs no declaration.`);
  }
  const probes = probeLeftovers(root, changed);
  if (probes.length) problems.push(`lab: a trace probe is still in ${probes.join(', ')} (${PROBE_MARKER}); eccode debug trace reverts its probes, so this one was written by hand. Remove it.`);
  return problems;
}

/**
 * Track rules of the Lab, checked when the last gate is submitted (through
 * works.checkTrackRules): root cause present and valid, the proof on the
 * pinned command, no probe in any changed file.
 */
function trackProblems(state, root) {
  if (!onLabTrack(state)) return [];
  const problems = [];
  const rc = rootCauseProblem(state, root);
  if (rc) problems.push(rc);
  if (root) {
    const changed = (gitChangedFiles(root, state.work.baseCommit) || []).filter((f) => !f.startsWith('.eccode/'));
    const probes = probeLeftovers(root, changed);
    if (probes.length) problems.push(`lab: a trace probe is still in ${probes.join(', ')} (${PROBE_MARKER}); remove it`);
  }
  return problems;
}

/** The reviewer's acknowledgement of declared test changes in this phase's tasks. */
function reviewProblems(state, gateId, review) {
  if (!onLabTrack(state) || !gateId.startsWith('phase:') || review.decision !== 'approve') return [];
  const phase = gateId.slice('phase:'.length);
  const declared = [];
  for (const t of Object.values(state.tasks).filter((x) => x.phase === phase && x.status === 'done' && x.handoffId)) {
    const h = state.handoffs[t.handoffId];
    for (const tc of (h && Array.isArray(h.testChanges) ? h.testChanges : [])) if (tc && tc.file) declared.push({ task: t.id, file: toPosix(path.normalize(tc.file)) });
  }
  if (!declared.length) return [];
  const acked = new Set((Array.isArray(review.acknowledgedTestChanges) ? review.acknowledgedTestChanges : []).filter((a) => a && typeof a.file === 'string').map((a) => toPosix(path.normalize(a.file))));
  return declared.filter((d) => !acked.has(d.file)).map((d) => `task ${d.task} changed the existing test ${d.file}; approval must acknowledge it in review.acknowledgedTestChanges [{file, verdict: "legitimate", reason}] after checking that the test was wrong, not the code`);
}

// ------------------------------------------------------------ report

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** The Lab section of the final handoff, built from events only. */
function reportLines(state) {
  const lab = state.lab;
  if (!lab || (!lab.repro && !Object.keys(lab.hypotheses).length)) return [];
  const lines = ['## Debugging Lab', ''];
  if (lab.repro) {
    lines.push(`**Reproduction (pinned):** \`${mdEscape(lab.repro.command)}\` failed with exit ${lab.repro.exitCode} (ev:${lab.repro.evidence}); environment ${lab.repro.fingerprint.platform}/${lab.repro.fingerprint.node}${lab.repro.fingerprint.python ? `, ${lab.repro.fingerprint.python}` : ''}${lab.repro.replaces ? `; replaced ${lab.repro.replaces} (${mdEscape(lab.repro.reason)})` : ''}.`, '');
  }
  const hs = Object.values(lab.hypotheses);
  if (hs.length) {
    lines.push('| Hypothesis | Status | Statement | If true | If false | Evidence (verdict, ev) |', '|---|---|---|---|---|---|');
    for (const h of hs) {
      const evs = h.evidence.map((id) => lab.evidence[id]).filter(Boolean).map((e) => `${e.verdict}${e.challenged ? ' (challenged)' : ''}: ev:${e.evidence}${e.trace ? ` trace ${e.trace.file}:${e.trace.line}` : ''}`);
      lines.push(`| ${h.id} | ${h.status} | ${mdEscape(h.statement)} | ${mdEscape(h.ifTrue)} | ${mdEscape(h.ifFalse)} | ${mdEscape(evs.join('; ') || '—')} |`);
    }
    lines.push('');
  }
  for (const l of lab.localizations) {
    if (l.method === 'sbfl') lines.push(`**Localization (SBFL, Ochiai; ${l.totals.failing} failing, ${l.totals.passing} passing tests; ev:${l.evidence}):** ${l.suspects.map((s) => `${s.file}:${s.line} (${s.score})`).join(', ') || 'no suspect'}.`, '');
    if (l.method === 'bisect') lines.push(`**Bisect ${l.good.slice(0, 12)}..${l.bad.slice(0, 12)} (ev:${l.evidence}):** ${l.suspects.length ? `first bad commit ${l.suspects[0].commit.slice(0, 12)} — ${mdEscape(l.suspects[0].subject)}` : 'no first bad commit found'} (${l.artifact}).`, '');
  }
  if (lab.rootCause) lines.push(`**Root cause (${lab.rootCause.hypothesis}, declared by ${lab.rootCause.by}):** ${mdEscape(lab.rootCause.explanation)} At ${lab.rootCause.locations.join(', ')}. Why the reproduction fails: ${mdEscape(lab.rootCause.whyReproFails)}`, '');
  if (lab.escalations.length) lines.push(`**Escalations:** ${lab.escalations.map((e) => `${e.kind} after ${e.refuted} refuted (${mdEscape(e.reason)})`).join('; ')}.`, '');
  return lines;
}

/** Human-readable state of the Lab for `eccode debug show`. */
function show(state) {
  const lab = state.lab;
  const out = [];
  out.push(lab.repro ? `Reproduction: ${lab.repro.command} (exit ${lab.repro.exitCode}, ev:${lab.repro.evidence}, ${lab.repro.id})` : 'Reproduction: none pinned (eccode debug repro)');
  for (const h of Object.values(lab.hypotheses)) {
    out.push(`${h.id} [${h.status}] ${h.statement}`);
    out.push(`    if true: ${h.ifTrue} | if false: ${h.ifFalse}`);
    for (const id of h.evidence) {
      const e = lab.evidence[id];
      if (e) out.push(`    ${e.id} ${e.verdict}${e.challenged ? ` (challenged by ${e.challenged.by}: ${e.challenged.reason})` : ''}: ${e.command || (e.trace && `trace ${e.trace.file}:${e.trace.line}`)} → exit ${e.exitCode} (ev:${e.evidence})${e.trace && e.trace.values ? ` values: ${e.trace.values.slice(0, 5).join(' | ')}` : ''}`);
    }
  }
  for (const l of lab.localizations) out.push(`localization ${l.method} (${l.id}): ${l.suspects.map((s) => (s.commit ? `${s.commit.slice(0, 12)} ${s.subject}` : `${s.file}:${s.line} ${s.score}`)).join(', ') || 'nothing ranked'}`);
  out.push(lab.rootCause ? `Root cause: ${lab.rootCause.hypothesis} at ${lab.rootCause.locations.join(', ')}: ${lab.rootCause.explanation}` : 'Root cause: not declared');
  for (const e of lab.escalations) out.push(`escalation: ${e.kind} (${e.reason})`);
  return out.join('\n');
}

module.exports = {
  LAB_TRACKS, PROBE_MARKER, VERDICTS,
  onLabTrack, normCmd, pythonFor, fingerprint,
  recordRepro, openHypothesis, testHypothesis, recordHypothesisEvidence, markEvidence, challengeEvidence, closeHypothesis, escalate, declareRootCause,
  trace, probeLeftovers, recoverProbe, localizeSbfl, bisect, pytestArgs, ochiai,
  rootCauseProblem, completionProblems, trackProblems, reviewProblems, changedExistingTests, validSupports, executedReason, budgetProblem,
  reportLines, show,
};
