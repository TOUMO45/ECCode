'use strict';
// `eccode improve ...` subcommands.

const { EccodeError } = require('../util');
const { Memory } = require('./records');
const improve = require('./improve');

function run({ store, config, sub, arg, flags, rest, actor, print, need, loadJsonFile }) {
  store.assertInitialized();
  switch (sub) {
    case 'propose': {
      const prop = improve.propose(store, config, new Memory(store, config), need(actor, '--actor'), loadJsonFile(need(flags.file, '--file')));
      print(flags, `Proposal ${prop.id} recorded for ${prop.target}. Next: evaluate baseline and candidate.`, prop);
      return 0;
    }
    case 'evaluate': {
      const prop = improve.evaluate(store, need(actor, '--actor'), need(arg, '<id>'), need(flags.variant, '--variant'), rest && rest.length ? rest.join(' ') : null);
      const e = prop.evaluation[flags.variant];
      print(flags, `${flags.variant}: ${e.passed}/${e.total} (exit ${e.exitCode}, ev:${e.evidence}). Status ${prop.status}.${prop.status === 'evaluated' ? ` Verdict: ${improve.verdict(prop).reason}` : ''}`, prop);
      return 0;
    }
    case 'review': {
      const prop = improve.review(store, need(actor, '--actor'), need(arg, '<id>'), need(flags.decision, '--decision'), need(flags.notes, '--notes'));
      print(flags, `Proposal ${prop.id} ${prop.status}.`, prop);
      return 0;
    }
    case 'adopt': {
      const prop = improve.adopt(store, config, need(actor, '--actor'), need(arg, '<id>'));
      print(flags, `Adopted ${prop.id} as ${prop.target} v${prop.version}. Rollback: eccode improve rollback ${prop.id} --reason ...`, prop);
      return 0;
    }
    case 'rollback': {
      const prop = improve.rollback(store, need(actor, '--actor'), need(arg, '<id>'), need(flags.reason, '--reason'), { regression: Boolean(flags.regression) });
      print(flags, `Rolled back ${prop.id}; ${prop.target} restored.`, prop);
      return 0;
    }
    case 'list': {
      const props = improve.list(store);
      print(flags, props.map((p) => `${p.id} [${p.status}] ${p.target} — ${p.title}`).join('\n') || '(none)', props);
      return 0;
    }
    default:
      throw new EccodeError('USAGE', `Unknown improve subcommand "${sub}"`);
  }
}

module.exports = { run };
