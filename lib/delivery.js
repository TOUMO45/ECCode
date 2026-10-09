'use strict';
// Final verified handoff. Delivery is refused unless every gate is approved,
// every task is done, the event chain is intact, every reviewed file is
// still byte-identical to the version its last approval covered, nothing else
// in the release tree changed since the first approved submission's commit,
// the working tree is clean, and no risk of a blocking severity is open.

const path = require('path');
const { execFileSync } = require('child_process');
const { EccodeError, sha256, sha256File, exists, writeFileAtomic, writeJson, matchesAny } = require('./util');
const { pendingRedelivery, nextDeliveryIndex } = require('./rework');
const { gitHead, treeDigest } = require('./project');
const { loadConfig, DEFAULT_CONFIG } = require('./config');
const { owns, filesChangedByTask } = require('./tasks');
const { Store } = require('./store');

/**
 * `task => files` across every completion the record holds for it (lib/tasks.js filesChangedByTask). The
 * snapshot's `task.filesChanged` is the latest handoff only: after `task reset` the rework handoff lists
 * just what the rework changed, so judged from the snapshot alone a deletion made by the first attempt
 * became "deleted after approval" and the first attempt's files lost their in-flight attribution (TK-1).
 */
function taskFilesReader(state, root) {
  const byTask = filesChangedByTask(new Store(root).readEvents());
  return (t) => [...new Set([...(t.filesChanged || []), ...(byTask.get(t.id) || [])])];
}

function gitOut(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** sha256 of a working-tree file; a marker for a missing or unreadable one (never equal to a real hash). */
function fileDigest(root, rel) {
  const abs = path.join(root, rel);
  try {
    return exists(abs) ? sha256File(abs) : 'deleted';
  } catch {
    return 'unreadable';
  }
}

/**
 * Every working-tree change git reports (`git status --porcelain -z`, untracked files listed one by
 * one), as `{ status, path, from }` with project-relative posix paths (a project may sit in a
 * subdirectory of its repository). null when git is unavailable.
 */
function workingTreeStatus(root) {
  const out = gitOut(root, ['status', '--porcelain', '--untracked-files=all', '-z', '--', '.']);
  if (out === null) return null;
  const prefix = (gitOut(root, ['rev-parse', '--show-prefix']) || '').trim();
  const rel = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const fields = out.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const status = f.slice(0, 2).trim();
    const entry = { status, path: rel(f.slice(3)) };
    if (/^[RC]/.test(status)) entry.from = rel(fields[++i] || ''); // -z lists the new path first, then the old one
    entries.push(entry);
  }
  return entries;
}

/**
 * Digest of the working tree a submission or delivery was made on: sha256 of HEAD plus the sorted
 * `<status> <path> <sha256>` lines of every change `git status --porcelain` reports outside .eccode/.
 * Two trees with the same commit and the same uncommitted changes have the same digest. null without git.
 */
function submissionTreeDigest(root) {
  // The content digest of the source tree (lib/project.js treeDigest): git blob ids of every file's working
  // bytes outside .eccode/, independent of HEAD, the index and status codes.
  return treeDigest(root);
}

const KINDS = { A: 'added', C: 'added', M: 'modified', T: 'modified', U: 'modified', D: 'deleted', R: 'renamed' };

/** `git diff --name-status -z` output as `{ kind, path, from }` entries. */
function parseNameStatus(out) {
  const fields = out.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const kind = KINDS[code[0]] || 'modified';
    if (/^[RC]/.test(code)) entries.push({ kind, from: fields[++i], path: fields[++i] });
    else entries.push({ kind, path: fields[++i] });
  }
  return entries;
}

function releaseConfig(root, config) {
  const release = config && config.release ? config.release : loadConfig(root).release;
  return { ...DEFAULT_CONFIG.release, ...release };
}

/** Not part of the release tree: the record, and the generated paths config.release.ignore names. */
function excluded(p, ignore) {
  return p.startsWith('.eccode/') || matchesAny(p, ignore);
}

/**
 * Files git shows changed since the FIRST approved gate's submission commit, the baseline of the reviewed work
 * (committed or not, including untracked files), that no review covers: not pinned by an approved gate (those
 * are hash-checked by the caller), not a deletion an approved phase's task recorded, not work in flight (files
 * owned or changed by the tasks of a phase whose gate is not approved yet), not in config.release.ignore. A
 * new file already submitted to a later, not-yet-approved gate with its current content is `pending` there,
 * like a modified one. The baseline is the earliest approved commit, not the latest: a file committed between
 * two approvals and listed by neither would otherwise drop out of the diff as soon as the later gate was
 * approved on a later commit. Entries are reported against the latest approved gate (the approval they
 * postdate). Records whose submissions carry no commit (older engines) are not judged: nothing was pinned,
 * so nothing can have changed since.
 */
function releaseTreeChanges(state, root, { latest, pendingSubs, ignore, filesOf = taskFilesReader(state, root) }) {
  let gateId = null; // the latest approved gate: what the changes are reported against
  let recent = null; // its submission: a rename since then is reported as one, with its old path
  let baseline = null; // the earliest approved submission with a commit: where the diff starts
  for (const id of state.gateOrder) {
    const g = state.gates[id];
    if (g.status !== 'approved') continue;
    const s = g.submissions.find((x) => x.id === g.approvedSubmission);
    if (s && s.commit) {
      [gateId, recent] = [id, s];
      if (!baseline) baseline = s;
    }
  }
  if (!baseline) return [];
  const diff = gitOut(root, ['diff', '--name-status', '-M', '-z', '--relative', baseline.commit]);
  const untracked = gitOut(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (diff === null || untracked === null) {
    return [{ path: '(release tree)', gate: gateId, problem: `cannot be compared with the first approved submission's commit ${baseline.commit}: git does not know it (the history was rewritten, or the record was moved to another repository)` }];
  }
  // A file the reviewed work added and a later edit renamed is "added" against the baseline; against the
  // latest approved commit it is the rename it is, so that view supplies the old path.
  const sinceRecent = recent.commit === baseline.commit ? diff : gitOut(root, ['diff', '--name-status', '-M', '-z', '--relative', recent.commit]) || '';
  const renamed = new Map(parseNameStatus(sinceRecent).filter((e) => e.kind === 'renamed').map((e) => [e.path, e.from]));
  const allTasks = Object.values(state.tasks || {});
  const phaseApproved = (t) => state.gates[`phase:${t.phase}`] && state.gates[`phase:${t.phase}`].status === 'approved';
  const inFlight = allTasks.filter((t) => !phaseApproved(t));
  const reviewedDeletions = new Set(allTasks.filter(phaseApproved).flatMap(filesOf));
  const entries = [
    ...parseNameStatus(diff).map((e) => (e.kind !== 'deleted' && renamed.has(e.path) ? { kind: 'renamed', from: renamed.get(e.path), path: e.path } : e)),
    ...untracked.split('\0').filter(Boolean).map((p) => ({ kind: 'added', path: p })),
  ];
  const out = [];
  for (const e of entries) {
    const p = e.path;
    if (excluded(p, ignore) || latest.has(p)) continue;
    if (inFlight.some((t) => owns(t.files, p) || filesOf(t).includes(p))) continue;
    if (e.kind === 'deleted' && reviewedDeletions.has(p)) continue;
    const entry = { path: p, ...(e.from ? { from: e.from } : {}), gate: gateId, problem: `${e.kind} after approval` };
    const current = e.kind === 'deleted' ? null : fileDigest(root, p);
    const pending = current && pendingSubs.find((s) => s.artifacts.some((a) => a.path === p && a.sha256 === current));
    if (pending) {
      entry.pending = pending.gate;
      entry.problem += `; the new version is submitted for review in ${pending.gate}`;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Files whose current content differs from their most recent approved version. A file that is gone is
 * only a problem if no later approved phase (a rework, say) recorded the deletion among the files its
 * task changed: that deletion was part of reviewed work. A modified file whose current hash a later,
 * not-yet-approved gate has already submitted for review is flagged `pending` with that gate: it is in
 * the normal flow (e.g. the verification submission carries the final versions), not an unreviewed
 * edit. Delivery treats every entry as a blocker; `eccode audit` reports pending ones as warnings.
 * Beyond the pinned files, every other change in the release tree since the first approved submission's
 * commit is reported too (see releaseTreeChanges). `config` defaults to the project's configuration.
 */
function unreviewedChanges(state, root, config) {
  const latest = new Map(); // path -> {sha256, gate, index}
  const pendingSubs = []; // latest submission of every gate still under review
  state.gateOrder.forEach((gateId, index) => {
    const g = state.gates[gateId];
    if (g.status !== 'approved') {
      if (g.submissions.length) pendingSubs.push({ gate: gateId, artifacts: g.submissions[g.submissions.length - 1].artifacts });
      return;
    }
    const sub = g.submissions.find((s) => s.id === g.approvedSubmission);
    for (const a of sub.artifacts) latest.set(a.path, { sha256: a.sha256, gate: gateId, at: g.approvedAt, index });
  });
  const filesOf = taskFilesReader(state, root);
  const deletedInReviewedWork = (p, fromIndex) =>
    state.gateOrder.slice(fromIndex + 1).some((gateId) => {
      if (!gateId.startsWith('phase:') || state.gates[gateId].status !== 'approved') return false;
      const phase = gateId.slice('phase:'.length);
      return Object.values(state.tasks || {}).some((t) => t.phase === phase && filesOf(t).includes(p));
    });
  const changed = [];
  for (const [p, info] of latest) {
    const abs = path.join(root, p);
    if (!exists(abs)) {
      if (!deletedInReviewedWork(p, info.index)) changed.push({ path: p, gate: info.gate, problem: 'deleted after approval' });
      continue;
    }
    const current = sha256File(abs);
    if (current === info.sha256) continue;
    const entry = { path: p, gate: info.gate, problem: 'modified after approval' };
    const pending = pendingSubs.find((s) => s.artifacts.some((a) => a.path === p && a.sha256 === current));
    if (pending) {
      entry.pending = pending.gate;
      entry.problem = `modified after approval; the new version is submitted for review in ${pending.gate}`;
    }
    changed.push(entry);
  }
  const { ignore } = releaseConfig(root, config);
  const reported = new Set(changed.map((c) => c.path));
  for (const c of releaseTreeChanges(state, root, { latest, pendingSubs, ignore, filesOf })) if (!reported.has(c.path)) changed.push(c);
  return changed;
}

function userEventSummary(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'gate.reopened':
      return `${d.gate} reopened: ${d.resolution}`;
    case 'risk.recorded':
      return `${d.id} ${d.status}${d.title ? `: ${d.title}` : ''}`;
    case 'decision.recorded':
      return `${d.title}: ${d.decision}`;
    case 'task.reset':
      return `${d.task} reset: ${d.reason}`;
    case 'improvement.adopted':
      return `${d.id} adopted (${d.target} v${d.version})`;
    case 'improvement.rolled_back':
      return `${d.id} rolled back: ${d.reason}`;
    case 'rework.opened':
      return `rework ${d.id || ''} opened: ${d.reason}`;
    case 'record.rollback_accepted':
      return 'a rolled-back event log was accepted as the record';
    default:
      return JSON.stringify(d).slice(0, 160);
  }
}

/** Risks whose severity config.release.blockRiskSeverities names and that nobody mitigated, accepted (user) or closed. */
function blockingRisks(state, config) {
  const severities = config.release.blockRiskSeverities;
  return Object.values(state.risks).filter((r) => r.status === 'open' && severities.includes(r.severity));
}

function preconditions(store, config = loadConfig(store.root)) {
  const state = store.state();
  const problems = [];
  for (const id of state.gateOrder) {
    if (state.gates[id].status !== 'approved') problems.push(`gate ${id} is ${state.gates[id].status}`);
  }
  // An approved plan always has phases and tasks; none means nothing was implemented
  // (e.g. a plan submission interrupted before its import was approved by an older engine).
  if (!state.plan || !state.plan.phases.length) problems.push('the approved plan has no phases');
  if (!Object.keys(state.tasks).length) problems.push('the approved plan has no tasks');
  for (const t of Object.values(state.tasks)) if (t.status !== 'done') problems.push(`task ${t.id} is ${t.status}`);
  const audit = store.audit();
  if (!audit.ok) problems.push(...audit.errors.map((e) => `audit: ${e}`));
  const changes = unreviewedChanges(state, store.root, config);
  for (const c of changes) problems.push(`${c.path} ${c.problem} (${c.gate})`);
  if (changes.length) {
    problems.push('every file listed above must be reviewed (submit it with a rework or the next gate), restored to its reviewed content, or, for generated files, listed in release.ignore (.eccode/config.json) before delivery');
  }
  // The release is a commit: an uncommitted change could still be reverted or altered after the handoff.
  const status = workingTreeStatus(store.root);
  if (status) {
    const dirty = status.map((e) => e.path).filter((p) => !excluded(p, releaseConfig(store.root, config).ignore));
    if (dirty.length) problems.push(`uncommitted changes: ${dirty.join(', ')}; commit or revert them, the delivery pins the release tree`);
  }
  for (const r of Object.values(state.runs)) if (r.status === 'running') problems.push(`run ${r.id} (${r.agent}) is still open`);
  for (const r of blockingRisks(state, config)) {
    problems.push(`${r.id} [${r.severity}] is open: mitigate it (eccode risk update --id ${r.id} --status mitigated --mitigation "<how>" --actor <role>) or have the user accept it (eccode risk update --id ${r.id} --status accepted --actor user, run by the user)`);
  }
  return { state, problems, audit };
}

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Who accepted a risk and when: the user's `risk.recorded` event with status accepted (the latest one). */
function acceptance(risk, events) {
  const ev = (events || []).filter((e) => e.type === 'risk.recorded' && e.data && e.data.id === risk.id && e.data.status === 'accepted').pop();
  return ev ? { by: ev.actor, at: ev.ts } : { by: risk.updatedBy, at: risk.updatedAt };
}

function buildReport(state, audit, { metrics, events, release } = {}) {
  const lines = [];
  const p = state.project;
  lines.push(`# Final Handoff — ${p.name}`, '');
  lines.push(`**Idea:** ${p.idea}`, '');
  lines.push(`Generated by \`eccode deliver\` from the event-sourced project record (${audit.events} events, hash chain verified). Everything in the "Verified" sections below is backed by recorded evidence; anything else is listed under limitations.`, '');
  if (release) {
    lines.push(`**Release commit:** \`${release.commit}\` (working tree clean outside \`.eccode/\`; tree digest \`${release.tree}\`). Every file in it is either older than the first reviewed submission or was pinned by an approved review.`, '');
  }

  lines.push('## Gate approvals', '', '| Gate | Authors | Approved by | Review iterations | Approved at |', '|---|---|---|---|---|');
  for (const id of state.gateOrder) {
    const g = state.gates[id];
    lines.push(`| ${id} | ${g.authors.join(', ')} | ${g.approvedBy} | ${g.iterations} rejected before approval | ${g.approvedAt} |`);
  }

  const rejected = state.rejectedReviews;
  const allReviews = Object.values(state.reviews);
  const changeReqs = allReviews.filter((r) => r.decision === 'changes_requested');
  lines.push('', '## Review history', '');
  lines.push(`- Reviews recorded: ${allReviews.length} (${changeReqs.length} requested changes)`);
  lines.push(`- Reviews refused by gate rules (e.g. self-approval, missing evidence): ${rejected.length}`);
  const findings = changeReqs.flatMap((r) => r.findings.filter((f) => ['blocking', 'major'].includes(f.severity)).map((f) => ({ ...f, gate: r.gate })));
  if (findings.length) {
    lines.push('', '| Gate | Finding | Severity | Title |', '|---|---|---|---|');
    for (const f of findings) lines.push(`| ${f.gate} | ${f.id} | ${f.severity} | ${mdEscape(f.title)} |`);
  }

  if (Object.keys(state.tasks).length) {
    lines.push('', '## Tasks', '', '| Task | Phase | Owner | Attempts | Completed by |', '|---|---|---|---|---|');
    for (const t of Object.values(state.tasks)) lines.push(`| ${t.id} | ${t.phase} | ${t.owner} | ${t.attempts} | ${t.completedBy} |`);
  }

  const cmds = Object.values(state.evidence).filter((e) => e.kind === 'command');
  lines.push('', '## Verified by executed checks', '', '| Evidence | Label | Command | Exit | By | Purpose |', '|---|---|---|---|---|---|');
  for (const e of cmds) lines.push(`| ${e.id} | ${mdEscape(e.label)} | \`${mdEscape(e.command)}\` | ${e.exitCode} | ${e.recordedBy} | ${e.purpose} |`);

  const decisions = Object.values(state.decisions);
  if (decisions.length) {
    lines.push('', '## Decisions', '');
    for (const d of decisions) lines.push(`- **${d.title}** — ${d.decision}. _Rationale:_ ${d.rationale}${d.lessons && d.lessons.length ? ` _Lessons:_ ${d.lessons.join(', ')}` : ''}`);
  }
  if (state.citations.length) {
    lines.push('', '## Memory lessons that influenced work', '');
    for (const c of state.citations) lines.push(`- ${c.lesson} → ${c.context} (${c.by})`);
  }

  // Every action the engine reserves for the user, listed so a reader can check each one against
  // the conversation (or an operator note): the record shows what was entered, not who typed it.
  const userEvents = (events || []).filter((e) => e.actor === 'user' || (e.data && e.data.onBehalfOf === 'user'));
  if (userEvents.length) {
    lines.push('', '## User decisions (recorded with `--actor user`, or under a delegation)', '');
    lines.push('Events recorded as the user were confirmed by a person at a terminal (engine 0.3.0 and later: `--actor user` needs a TTY; the test suite switch ECCODE_TEST=1 is the only other path). Events marked "under delegation" were recorded by an agent spending a bounded delegation the user granted (`eccode delegate grant`). Records written by earlier engine versions carry no such proof: whoever ran the CLI entered them.', '');
    for (const e of userEvents) {
      const via = e.actor !== 'user' ? ` (by ${e.actor} under delegation ${e.data.delegation || '?'})` : '';
      lines.push(`- #${e.seq} ${e.ts} \`${e.type}\` ${mdEscape(userEventSummary(e))}${via}`);
    }
  }

  const risks = Object.values(state.risks);
  lines.push('', '## Risks', '');
  if (!risks.length) lines.push('- None recorded.');
  for (const r of risks) {
    const acc = r.status === 'accepted' ? acceptance(r, events) : null;
    lines.push(`- **${r.id}** [${r.severity}, ${r.status}] ${r.title}${r.mitigation ? ` — mitigation: ${r.mitigation}` : ''}${acc ? ` — accepted by ${acc.by} at ${acc.at}` : ''}`);
  }
  const accepted = risks.filter((r) => r.status === 'accepted');
  if (accepted.length) {
    lines.push('', `Accepted risks (a user decision, recorded with \`--actor user\`; see "User decisions"): ${accepted.map((r) => `${r.id} (accepted by ${acceptance(r, events).by} at ${acceptance(r, events).at})`).join(', ')}`);
  }

  lines.push('', '## Cost and runtime (as reported to the record)', '');
  lines.push(`- Agent runs: ${Object.keys(state.runs).length}; runtime ${state.totals.runtimeMinutes} min; tokens ${state.totals.tokens}; cost $${state.totals.costUsd}`);
  const interrupted = Object.values(state.runs).filter((r) => r.status === 'interrupted');
  if (interrupted.length) lines.push(`- Interrupted runs recovered: ${interrupted.length}`);
  if (metrics) {
    lines.push('', '## Workflow metrics', '');
    for (const [k, v] of Object.entries(metrics)) lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }

  const failed = cmds.filter((e) => e.status === 'failed' && e.purpose !== 'reproduction');
  lines.push('', '## Limitations and unverified items', '');
  lines.push('- Agent identities in the record are asserted by the caller; the Claude Code guard hook binds them to the running subagent type where the harness reports it.');
  lines.push('- Cost figures are only as accurate as the usage reported when runs were closed.');
  if (failed.length) lines.push(`- Failed checks remain in the record (superseded by later passing runs): ${failed.map((e) => e.id).join(', ')}`);
  const openRisks = risks.filter((r) => r.status === 'open');
  if (openRisks.length) lines.push(`- Open risks carried forward: ${openRisks.map((r) => r.id).join(', ')}`);
  return lines.join('\n') + '\n';
}

/**
 * Produce the final handoff. `config` comes from the CLI; library callers may omit it and the project's
 * configuration is loaded. The release commit and tree digest are recorded when git is available.
 */
function deliver(store, actor, { metrics, config } = {}) {
  if (actor !== 'delivery-lead' && actor !== 'orchestrator') {
    throw new EccodeError('ROLE_NOT_ALLOWED', 'Delivery is performed by delivery-lead or the orchestrator');
  }
  const cfg = config || loadConfig(store.root);
  const { state, problems, audit } = preconditions(store, cfg);
  if (state.delivery && !pendingRedelivery(state)) throw new EccodeError('ALREADY_DELIVERED', `Already delivered at ${state.delivery.at}`);
  if (problems.length) {
    throw new EccodeError('DELIVERY_BLOCKED', `Delivery refused:\n- ${problems.join('\n- ')}`, { problems });
  }
  const commit = gitHead(store.root);
  const tree = commit ? submissionTreeDigest(store.root) : null;
  const release = commit && tree ? { commit, tree } : null;
  const events = store.readEvents();
  const report = buildReport(state, audit, { metrics, events, release });
  const n = nextDeliveryIndex(state);
  const suffix = n === 1 ? '' : `-${n}`;
  const rel = `.eccode/delivery/final-handoff${suffix}.md`;
  writeFileAtomic(path.join(store.root, rel), report);
  writeJson(path.join(store.root, `.eccode/delivery/final-handoff${suffix}.json`), {
    project: state.project,
    release,
    gates: state.gateOrder.map((id) => ({ id, approvedBy: state.gates[id].approvedBy, iterations: state.gates[id].iterations })),
    evidence: Object.values(state.evidence).map((e) => ({ id: e.id, label: e.label, status: e.status, exitCode: e.exitCode, recordedBy: e.recordedBy })),
    risks: Object.values(state.risks).map((r) => ({ id: r.id, severity: r.severity, status: r.status, ...(r.status === 'accepted' ? { accepted: acceptance(r, events) } : {}) })),
    totals: state.totals,
    auditEvents: audit.events,
  });
  store.commit('delivery.completed', actor, { report: rel, summary: `${state.gateOrder.length} gates approved`, ...(release || {}) });
  return release ? { report: rel, commit } : { report: rel };
}

module.exports = { deliver, preconditions, unreviewedChanges, buildReport, submissionTreeDigest, workingTreeStatus, blockingRisks };
