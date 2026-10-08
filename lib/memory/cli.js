'use strict';
// `eccode memory ...` subcommands.

const { EccodeError } = require('../util');
const { DEFAULT_CONFIG, learningEnabled } = require('../config');
const { Memory, current, renderAsEvidence } = require('./records');
const { detectEnv } = require('./env');

function parseEnvFlags(list) {
  const out = {};
  for (const kv of list || []) {
    const i = kv.indexOf('=');
    if (i < 1) throw new EccodeError('USAGE', `--env expects key=value (got ${kv})`);
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

const LEARNING_OFF = 'Learning is disabled (ECCODE_LEARNING=off or memory.learning=false)';

function run({ store, config, sub, arg, flags, actor, print, need, numberFlag, loadJsonFile, root }) {
  const cfg = config || DEFAULT_CONFIG;
  const memory = new Memory(store, cfg);
  const learning = learningEnabled(cfg);
  const refuseWhenOff = (what) => {
    if (!learning) throw new EccodeError('LEARNING_DISABLED', `${LEARNING_OFF}: ${what} is not available. Project facts (layer "project") are still recorded.`);
  };
  switch (sub) {
    case 'status': {
      const recs = [...memory.local.all(), ...memory.shared.all()];
      const counts = {};
      for (const r of recs) counts[`${r.scope}/${r.layer}/${r.status}`] = (counts[`${r.scope}/${r.layer}/${r.status}`] || 0) + 1;
      print(flags, `learning: ${learning ? 'on' : 'off'}\n${Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join('\n') || '(no records)'}`, { learning, counts });
      return 0;
    }
    case 'add': {
      const input = loadJsonFile(need(flags.file, '--file'));
      if (input.layer !== 'project') refuseWhenOff(`recording a ${input.layer} lesson`);
      const rec = memory.add(need(actor, '--actor'), { layer: input.layer, content: input.content, scope: flags.scope || 'project', trust: input.trust || 'internal' });
      print(flags, `Recorded ${rec.id} (${rec.layer}, ${rec.status}).${rec.layer !== 'project' ? ' It needs an independent review before it can be trusted.' : ''}`, rec);
      return 0;
    }
    case 'search': {
      const query = arg;
      const found = memory.search(need(query, '<query>'), { layer: learning ? flags.layer : 'project', scope: learning ? flags.scope || 'all' : 'project', includeSuperseded: Boolean(flags['include-superseded']), limit: numberFlag(flags, 'limit', { min: 1, integer: true }) ?? 5 });
      const results = learning ? found : found.filter((r) => r.record.layer === 'project');
      if (!learning && !flags.json) print(flags, `${LEARNING_OFF}: only project facts are searched.`);
      const envOverrides = parseEnvFlags(flags.env);
      const enriched = results.map((r) => ({ ...r, check: flags['check-env'] ? memory.check(r.id, { envOverrides, actor: actor || 'orchestrator' }) : null }));
      if (flags.json) {
        print(flags, enriched.map((r) => ({ id: r.id, score: r.score, components: r.components, status: r.record.status, layer: r.record.layer, title: current(r.record).title, check: r.check })));
      } else {
        print(flags, enriched.length ? enriched.map((r) => `score ${r.score}\n${renderAsEvidence(r.record, r.check)}`).join('\n\n') : 'No matching memory records.');
      }
      return 0;
    }
    case 'show': {
      const rec = memory.get(need(arg, '<id>'));
      if (flags.history || flags.json) print(flags, rec);
      else print(flags, renderAsEvidence(rec) + `\nreviews: ${rec.reviews.map((r) => `${r.decision} by ${r.reviewer} @${r.at}`).join('; ') || 'none'}\nrevisions: ${rec.revisions.length}`);
      return 0;
    }
    case 'list': {
      const recs = [...memory.local.all(), ...memory.shared.all()].filter((r) => (!flags.layer || r.layer === flags.layer) && (!flags.status || r.status === flags.status));
      print(flags, recs.map((r) => `${r.id} [${r.layer}/${r.scope}/${r.status}] ${current(r).title}`).join('\n') || '(empty)', recs.map((r) => ({ id: r.id, layer: r.layer, scope: r.scope, status: r.status, title: current(r).title })));
      return 0;
    }
    case 'review': {
      const rec = memory.review(need(arg, '<id>'), need(actor, '--actor'), { decision: need(flags.decision, '--decision'), notes: need(flags.notes, '--notes') });
      print(flags, `${rec.id} is now ${rec.status}.`, { id: rec.id, status: rec.status });
      return 0;
    }
    case 'revise': {
      const rec = memory.revise(need(arg, '<id>'), need(actor, '--actor'), loadJsonFile(need(flags.file, '--file')), need(flags.reason, '--reason'));
      print(flags, `${rec.id} revised to rev ${rec.revisions.length} (status ${rec.status}).`, { id: rec.id, rev: rec.revisions.length, status: rec.status });
      return 0;
    }
    case 'check': {
      const res = memory.check(need(arg, '<id>'), { envOverrides: parseEnvFlags(flags.env), actor: actor || 'orchestrator' });
      print(flags, `${res.id}: ${res.verdict.toUpperCase()}${res.reasons.length ? `\n- ${res.reasons.join('\n- ')}` : ''}`, res);
      return res.verdict === 'applies' ? 0 : 3;
    }
    case 'supersede': {
      memory.supersede(need(arg, '<oldId>'), need(flags.by, '--by'), need(actor, '--actor'), need(flags.reason, '--reason'));
      print(flags, `${arg} superseded by ${flags.by} (history preserved).`);
      return 0;
    }
    case 'duplicates': {
      const pairs = memory.duplicates(numberFlag(flags, 'threshold', { min: 0 }));
      print(flags, pairs.length ? pairs.map((p) => `${p.a} ~ ${p.b} (${p.similarity})`).join('\n') + '\nConsolidate with: eccode memory supersede <older> --by <newer>' : 'No near-duplicates.', pairs);
      return 0;
    }
    case 'promote': {
      refuseWhenOff('promotion to shared memory');
      const copy = memory.promote(need(arg, '<id>'), need(actor, '--actor'));
      print(flags, `Promoted ${arg} to shared memory as ${copy.id}.`, { sharedId: copy.id });
      return 0;
    }
    case 'assess': {
      refuseWhenOff('assessing a lesson');
      const entry = memory.assess(need(arg, '<id>'), need(actor, '--actor'), { verdict: need(flags.verdict, '--verdict'), reason: need(flags.reason, '--reason'), evidence: flags.evidence || [] });
      print(flags, `Assessment recorded for ${arg}: ${entry.verdict.toUpperCase()} (${entry.evidence.join(', ')}).`, entry);
      return 0;
    }
    case 'cite': {
      memory.cite(need(arg, '<id>'), need(actor, '--actor'), need(flags.context, '--context'));
      print(flags, `Citation recorded for ${arg}.`);
      return 0;
    }
    case 'env': {
      print(flags, detectEnv(root, parseEnvFlags(flags.env)));
      return 0;
    }
    default:
      throw new EccodeError('USAGE', `Unknown memory subcommand "${sub}". Run eccode help.`);
  }
}

module.exports = { run };
