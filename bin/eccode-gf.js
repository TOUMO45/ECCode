#!/usr/bin/env node
'use strict';
// eccode-gf: the command-line face of the Greenfield-Senior layer (lib/greenfield). Exit codes as the base CLI:
// 0 success, 1 usage or internal error, 2 refused by a rule. The frozen bin/eccode.js is not edited; this is a
// separate entry point that calls the same engine through the wrapped operations.
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/cli-args');
const { EccodeError, readJson } = require('../lib/util');

const HELP = `eccode-gf — Greenfield-Senior: one idea to a sealed, reviewed plan

Enforcement: prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles.
This CLI runs the same rules as the eccode MCP tools. The plain eccode CLI is outside the layer, and audit finds anything committed through it.

Start
  init --name <n> --idea <text> [--stack python-fastapi-sqlalchemy-sqlite]
                                   A greenfield project with the group roles and the layer switched on
  status [--json]                  Which G1 stages are registered, whether G1 is sealed, estimates, amendments, messages

G1 (architecture, design, plan: the existing gates, with the stage rules run first)
  validate <gate> --artifact <file> [--artifact ...]      Dry run of the rules; writes nothing
  gate start <gate> --actor <role> [--reviewers a,b]
  gate submit <gate> --actor <role> --artifact <file> ... [--responds-to <review id>] [--notes <text>]
  gate review <gate> --actor <role> --file <review.json>   Approving the plan gate seals G1
  task claim <task> --actor <role>                         Refused until G1 is sealed
  seal --actor <role>                                      Retry the seal if it failed after the plan gate was approved

After the seal
  amend request --actor <role> --contract <path> --reason <text> --message <msg id> --proposed <text>
  amend apply --actor <reviewer> --request <id> --reason <text, 30+ characters>
  message send --actor <role> --to <group,group> --kind <kind> --subject <text> --body <text> [--in-reply-to <id>]
  message list [--from <group>] [--to <group>] [--kind <kind>]
  estimate revise --actor <role> --reason <text> --file <groups.json>
  ownership show                   The ownership map in force, after amendments
  ownership amend --actor <reviewer> --group <g> --to <glob,glob> --reason <text, 30+ characters> --message <msg id>
  task rescope <task> --actor <role> --files <glob,glob> --reason <text>   Refused when a file belongs to another group
  task complete <task> --actor <role> --file <handoff.json>   Refused when the handoff lists a file of another group
  config pin --actor <orchestrator|user> --scope <label> --reason <text>   Pin the guard configuration (behavior, guards, security) by hash
  attribute --base <commit>        Every path changed since the commit must belong to a group that completed a task declaring it; exit 2 otherwise
Slice closure (three recorded review steps, two batteries, accounting)
  close dispatch --actor orchestrator --scope <s> --role <reviewer> --step comprehension|critique|readiness --input <path,path>
  close review --actor <reviewer> --scope <s> --step <step> --dispatch <id> --summary-file <file> [--findings <file.json>] [--verdict go|no-go] [--evidence ev:<id>,path:line]
  close resolve --actor <role> --finding <id> --resolution fixed|withdrawn|deferred [--proof-run ev:<id>] [--reproduction ev:<id>] [--reason <text>] [--limit <id>]
  close battery --actor orchestrator --scope <s> --test "<command>" --base <commit> [--max <n>]
  close status --scope <s>         What closing the scope now would be refused for
  close slice --actor orchestrator|user --scope <s> --accounting <file.json> [--accepted <file.json>]
  preflight [--json]               Which regime protects identity between groups (managed-path or text-level) and the warnings (L-GF-17)
  audit [--json]                   Replay the record and check every rule as an invariant; exit 2 on any error

Global: --root <dir> (or ECCODE_ROOT), --actor <role> (or ECCODE_ACTOR, never for user), --json
`;

function findRoot(flags, { create = false } = {}) {
  if (flags.root && flags.root !== true) return path.resolve(flags.root);
  if (process.env.ECCODE_ROOT) return path.resolve(process.env.ECCODE_ROOT);
  if (create) return process.cwd();
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.eccode'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

function need(value, name) {
  if (value === undefined || value === true || value === '') throw new EccodeError('USAGE', `Missing required ${name}`);
  return value;
}

function print(flags, human, json) {
  if (flags.json) process.stdout.write(`${JSON.stringify(json === undefined ? human : json, null, 2)}\n`);
  else process.stdout.write(`${typeof human === 'string' ? human : JSON.stringify(human, null, 2)}\n`);
}

const list = (v) => (v === undefined || v === true ? undefined : String(v).split(',').map((x) => x.trim()).filter(Boolean));

function main(argv) {
  const args = parseArgs(argv);
  const { flags } = args;
  const [group, sub, arg] = args._;
  if (!group || flags.help || group === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  const actor = flags.actor || (process.env.ECCODE_ACTOR === 'user' ? undefined : process.env.ECCODE_ACTOR);
  const gf = require('../lib/greenfield');

  if (group === 'init') {
    const store = gf.initProject(findRoot(flags, { create: true }), { name: need(flags.name, '--name'), idea: need(flags.idea, '--idea'), stackProfile: flags.stack === undefined ? undefined : flags.stack, actor: actor || 'orchestrator' });
    print(flags, `Initialized a Greenfield-Senior project in ${store.dir}`, { root: store.root });
    return 0;
  }

  const root = findRoot(flags);
  const { openProject } = require('../lib/project');
  const { store, config } = openProject(root);
  store.assertInitialized();

  switch (group) {
    case 'status': {
      const s = gf.status(store);
      print(flags, s.enabled
        ? `Greenfield-Senior (${s.stackProfile}): registered ${s.registered.join(', ') || 'nothing yet'}; ${s.sealed ? `sealed ${s.contractsHash.slice(0, 12)}` : 'not sealed'}; estimate ${s.estimateRegistered ? 'registered' : 'not registered'}; ${s.amendments} amendment(s), ${s.messages} message(s)`
        : 'Not a Greenfield-Senior project (eccode-gf init starts one).', s);
      return 0;
    }
    case 'validate': {
      const r = require('../lib/greenfield').bundle.validateGate(store.root, need(sub, '<gate>'), flags.artifact || [], store.state(), config);
      const ok = r.problems.length === 0;
      print(flags, ok ? `${sub}: every rule holds for ${r.registrations.map((x) => x.stage).join(', ')}` : `${sub}: ${r.problems.length} problem(s)\n${r.problems.map((p) => `- ${p.rule}: ${p.message}`).join('\n')}`, { ok, problems: r.problems, stages: r.registrations.map((x) => x.stage) });
      return ok ? 0 : 2;
    }
    case 'gate': {
      if (!['start', 'submit', 'review'].includes(sub)) throw new EccodeError('USAGE', 'gate start|submit|review <gate>');
      const gateId = need(arg, '<gate>');
      const who = need(actor, '--actor');
      if (sub === 'start') {
        gf.wrap.gateStart(store, config, gateId, who, { reviewers: list(flags.reviewers) });
        print(flags, `Gate ${gateId} started.`, { gate: gateId, started: true });
      } else if (sub === 'submit') {
        const r = gf.wrap.gateSubmit(store, config, gateId, who, { artifacts: flags.artifact || [], respondsTo: flags['responds-to'], notes: flags.notes });
        print(flags, `Submitted ${gateId}: ${r.event.data.submissionId}`, r.event.data);
      } else {
        const review = readJson(path.resolve(need(flags.file, '--file')));
        if (!review) throw new EccodeError('USAGE', `Cannot read the review file ${flags.file}`);
        const { event } = gf.wrap.gateReview(store, config, gateId, who, review);
        require('../lib/gates').archiveReview(store, event.data.reviewId, review);
        const status = store.state().gates[gateId].status;
        print(flags, `Review ${event.data.reviewId} recorded; gate ${gateId} is ${status}.`, { reviewId: event.data.reviewId, gateStatus: status });
      }
      return 0;
    }
    case 'seal': {
      need(actor, '--actor');
      const r = gf.wrap.seal(store, config);
      print(flags, `G1 sealed: ${r.event.data.contractsHash.slice(0, 12)}`, { sealed: true, contractsHash: r.event.data.contractsHash, estimateSeq: r.event.data.estimateSeq });
      return 0;
    }
    case 'task': {
      if (sub === 'rescope') {
        const r = gf.ownership.rescope(store, config, need(arg, '<task>'), need(actor, '--actor'), { files: flags.files, reason: flags.reason });
        print(flags, `Task ${arg} rescoped to ${r.event.data.files.join(', ')}.`, r.event.data);
        return 0;
      }
      if (sub === 'complete') {
        const handoff = readJson(path.resolve(need(flags.file, '--file')));
        if (!handoff) throw new EccodeError('USAGE', `Cannot read the handoff file ${flags.file}`);
        gf.wrap.taskComplete(store, config, need(arg, '<task>'), need(actor, '--actor'), handoff);
        print(flags, `Task ${arg} completed.`, { task: arg, completed: true });
        return 0;
      }
      if (sub !== 'claim') throw new EccodeError('USAGE', 'task claim|rescope|complete <task>');
      const r = gf.wrap.taskClaim(store, config, need(arg, '<task>'), need(actor, '--actor'), {});
      print(flags, `Task ${arg} claimed by ${actor}.`, r.event.data);
      return 0;
    }
    case 'ownership': {
      if (sub === 'show') {
        const d = gf.ownership.describe(store, config);
        print(flags, d.groups ? Object.entries(d.groups).map(([n, g]) => `${n} [${g.roles.join(', ')}]: ${g.globs.join(', ')}${g.denyGlobs.length ? ` (not ${g.denyGlobs.join(', ')})` : ''}`).join('\n') : `No ownership map: ${d.problems.map((p) => p.message).join('; ') || 'not a Greenfield-Senior project'}`, d);
      } else if (sub === 'amend') {
        const r = gf.ownership.amend(store, config, need(actor, '--actor'), { group: flags.group, to: list(flags.to), reason: flags.reason, message: flags.message, ...(flags.from ? { from: list(flags.from) } : {}) });
        print(flags, `Ownership amendment ${r.event.data.id}: ${r.event.data.group} now owns ${r.event.data.to.join(', ')}.`, r.event.data);
      } else throw new EccodeError('USAGE', 'ownership show|amend');
      return 0;
    }
    case 'amend': {
      if (sub === 'request') {
        const r = gf.contracts.requestAmendment(store, config, need(actor, '--actor'), { contract: flags.contract, reason: flags.reason, message: flags.message, proposed: flags.proposed });
        print(flags, `Amendment request ${r.id} recorded for ${r.contract}.`, r);
      } else if (sub === 'apply') {
        const r = gf.contracts.applyAmendment(store, config, need(actor, '--actor'), { request: flags.request, reason: flags.reason });
        print(flags, `Amendment ${r.id} recorded: ${r.contract} ${r.classification}${r.affectedOps.length ? ` (${r.affectedOps.join(', ')})` : ''}.`, r);
      } else throw new EccodeError('USAGE', 'amend request|apply');
      return 0;
    }
    case 'message': {
      if (sub === 'send') {
        const r = gf.messages.send(store, config, need(actor, '--actor'), { to: list(flags.to), kind: flags.kind, subject: flags.subject, body: flags.body, inReplyTo: flags['in-reply-to'], refs: list(flags.refs) });
        print(flags, `Message ${r.id} sent from ${r.from} to ${r.to.join(', ')}.`, r);
      } else if (sub === 'list') {
        const r = gf.messages.list(store, { from: flags.from, to: flags.to, kind: flags.kind });
        print(flags, r.length ? r.map((m) => `${m.id} ${m.from} -> ${m.to.join(',')} [${m.kind}] ${m.subject}`).join('\n') : 'No messages.', r);
      } else throw new EccodeError('USAGE', 'message send|list');
      return 0;
    }
    case 'estimate': {
      if (sub !== 'revise') throw new EccodeError('USAGE', 'estimate revise');
      const groups = readJson(path.resolve(need(flags.file, '--file')));
      if (!groups) throw new EccodeError('USAGE', `Cannot read ${flags.file}`);
      const r = gf.estimate.revise(store, config, need(actor, '--actor'), { reason: flags.reason, groups });
      print(flags, `Estimate revision ${r.id} recorded beside ${r.of}.`, r);
      return 0;
    }
    case 'config': {
      if (sub !== 'pin') throw new EccodeError('USAGE', 'config pin');
      const r = gf.pin.pin(store, config, need(actor, '--actor'), { scope: flags.scope, reason: flags.reason });
      print(flags, `Pinned ${Object.keys(r.event.data.files).length} guard configuration file(s) under scope ${r.event.data.scope}.`, r.event.data);
      return 0;
    }
    case 'attribute': {
      const r = gf.ownership.attribute(store, need(flags.base, '--base'));
      print(flags, r.ok ? `Every changed path since ${flags.base} is attributed to a group that completed a task declaring it (${r.changed.filter((f) => !f.startsWith('.eccode/')).length} path(s)).` : `Attribution FAILED:\n${r.problems.map((p) => `- ${p.rule}: ${p.message}`).join('\n')}`, r);
      return r.ok ? 0 : 2;
    }
    case 'close': {
      const cl = gf.closure;
      const readFileArg = (name) => { const v = readJson(path.resolve(need(flags[name], `--${name}`))); if (v === null || v === undefined) throw new EccodeError('USAGE', `Cannot read --${name} ${flags[name]}`); return v; };
      let r;
      if (sub === 'dispatch') r = cl.recordDispatch(store, config, need(actor, '--actor'), { scope: flags.scope, role: flags.role, step: flags.step, inputs: list(flags.input) || [] }).event.data;
      else if (sub === 'review') {
        const summary = flags['summary-file'] ? fs.readFileSync(path.resolve(flags['summary-file']), 'utf8').trim() : flags.summary;
        r = cl.recordReview(store, config, need(actor, '--actor'), { scope: flags.scope, step: flags.step, dispatch: flags.dispatch, summary, verdict: flags.verdict, findings: flags.findings ? readFileArg('findings') : [], evidence: list(flags.evidence) }).event.data;
      } else if (sub === 'resolve') {
        // The shared argument parser (lib/cli-args.js, frozen) treats --proof as a boolean flag, so a separate value is lost.
        if (flags.proof === true) throw new EccodeError('USAGE', 'give the proof as --proof-run ev:<id> (or --proof=ev:<id>): --proof alone is a boolean flag of the shared argument parser');
        const proof = flags['proof-run'] !== undefined ? flags['proof-run'] : flags.proof;
        r = cl.resolveFinding(store, config, need(actor, '--actor'), { finding: flags.finding, resolution: flags.resolution, proof, reproduction: flags.reproduction, reason: flags.reason, limit: flags.limit }).event.data;
      }
      else if (sub === 'battery') r = cl.runBattery(store, config, need(actor, '--actor'), { scope: flags.scope, test: flags.test, base: flags.base, max: flags.max ? Number(flags.max) : undefined }).event.data;
      else if (sub === 'status') {
        const p = cl.preview(store, config, need(flags.scope, '--scope'));
        const acc = p.accepted ? `\n${p.scope} was accepted with limits (not closed) at seq ${p.accepted.seq}: ${p.accepted.findings} finding(s) recorded as numbered limits (GF-CLOSE-6).` : '';
        print(flags, `${p.ok ? `${p.scope} can be closed on tree ${String(p.treeHash).slice(0, 12)}.` : `${p.scope} cannot be closed yet:\n${p.problems.map((x) => `- ${x.rule}: ${x.message}`).join('\n')}`}${acc}`, p);
        return p.ok ? 0 : 2;
      } else if (sub === 'accept') r = cl.accept(store, config, need(actor, '--actor'), { scope: flags.scope, accepted: readFileArg('accepted') }).event.data;
      else if (sub === 'slice') r = cl.close(store, config, need(actor, '--actor'), { scope: flags.scope, accounting: readFileArg('accounting'), accepted: flags.accepted ? readFileArg('accepted') : [] }).event.data;
      else throw new EccodeError('USAGE', 'close dispatch|review|resolve|battery|status|slice|accept');
      print(flags, `close ${sub}: recorded ${r.id || r.scope}.`, r);
      return 0;
    }
    case 'run': {
      const r = gf.runner.run(store, config, need(actor, '--actor'), { label: flags.label, command: flags.command, purpose: flags.purpose, task: flags.task });
      const moved = `${r.copiedBack.length ? `\ncopied back: ${r.copiedBack.join(', ')}` : ''}${r.discarded.length ? `\ndiscarded (stayed in the copy): ${r.discarded.map((d) => `${d.path} (${d.owner || 'no group'})`).join(', ')}` : ''}`;
      print(flags, `${r.status} (${r.evidence}, exit ${r.exitCode})${r.problems.length ? `\n${r.problems.map((x) => `- ${x.rule}: ${x.message}`).join('\n')}` : ''}${moved}`, r);
      return r.ok ? 0 : 2;
    }
    case 'preflight': {
      const r = gf.preflight.preflight(store.root);
      print(flags, `${r.regime}: profile ${r.profile}, guard ${r.guardWired ? 'wired' : 'not wired'}${r.warnings.length ? `\n${r.warnings.map((w) => `- ${w}`).join('\n')}` : ''}`, r);
      return 0;
    }
    case 'audit': {
      const r = gf.audit.run(store, config);
      const lines = [...r.errors.map((e) => `- ${e.rule}${e.seq ? ` (seq ${e.seq})` : ''}: ${e.message}`), ...r.base.errors.map((e) => `- frozen audit: ${e}`), ...r.base.unreviewed.map((u) => `- frozen audit: ${u.path} ${u.problem} (${u.gate})`)];
      const acc = (r.accepted || []).length ? `\nAccepted with limits, not closed: ${r.accepted.map((a) => `${a.scope} (seq ${a.seq}, ${a.findings} limit(s))`).join(', ')}` : '';
      const warn = (r.warnings || []).length ? `\nWarnings (${r.managedPath.regime} regime):\n${r.warnings.map((w) => `- ${w}`).join('\n')}` : '';
      print(flags, `${r.ok ? `Audit OK${r.enabled ? ' (Greenfield-Senior rules and the frozen checks)' : ' (frozen checks only: not a Greenfield-Senior project)'}.${warn}` : `Audit FAILED:\n${lines.join('\n')}${warn}`}${acc}`, r);
      return r.ok ? 0 : 2;
    }
    default:
      throw new EccodeError('USAGE', `Unknown command "${group}". Run eccode-gf --help.`);
  }
}

function fail(err) {
  if (err instanceof EccodeError) {
    process.stderr.write(`eccode-gf: [${err.code}] ${err.message}\n`);
    process.exitCode = err.code === 'USAGE' ? 1 : 2;
  } else {
    process.stderr.write(`eccode-gf: internal error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { fail(err); }
}

module.exports = { main };
