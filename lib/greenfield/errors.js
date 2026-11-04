'use strict';
// A refusal by a Greenfield-Senior rule: code GF_RULE, a readable list in the message, the structured
// problems in details.problems ([{ rule, message, path? }]).
const { EccodeError } = require('../util');

function ruleError(problems) {
  const list = problems.map((p) => `${p.rule}: ${p.message}`);
  return new EccodeError('GF_RULE', `Greenfield rule${problems.length > 1 ? 's' : ''} refused this:\n- ${list.join('\n- ')}`, { problems });
}

module.exports = { ruleError };
