'use strict';
// H2-3 reproduction (security-reviewer, S2 critique). Run from inside the reviewer's copy of the tree.
// Design 18.5: "When a scope does not close, the owner may accept it with limits instead ... The engine refuses it
// unless the actor is `user`; the tree is clean ...; the scope is neither closed nor already accepted; the list holds
// every open finding of the scope (a finding of any review of the scope without a valid resolution) exactly once,
// ... and nothing else; and no listed finding is blocking." The GF-CLOSE-6 row says the same. A scope that does not
// close because its readiness review on the closing tree is a no-go (which stands, D2-3) has no finding at all (a
// readiness review carries none), so the list that holds every open finding of it is the empty list. The code adds a
// refusal the documents do not state ("an acceptance lists at least one open finding (a scope with none is closed, not
// accepted)"), which is also untrue for this scope: it has no open finding and is not closable.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ROOT = process.cwd();
const X = require(path.join(ROOT, 'tests/fixtures/gf/close'));
const closure = require(path.join(ROOT, 'lib/greenfield/closure'));
const { closeProject, battery, threeSteps } = X;

test('H2-3: a scope that does not close and has no open finding is accepted by the user with the list of its open findings (none)', () => {
  const ctx = closeProject();
  const b1 = battery(ctx);
  threeSteps(ctx, { readiness: { verdict: 'no-go', evidence: [b1.evidence] } });
  battery(ctx);
  const p = closure.preview(ctx.store, ctx.config, 'S2');
  assert.strictEqual(p.ok, false, 'precondition: the scope does not close (its readiness no-go stands)');
  let err = null;
  try { closure.accept(ctx.store, ctx.config, 'user', { scope: 'S2', accepted: [] }); } catch (e) { err = e; }
  assert.strictEqual(err, null, `the documented rule's conditions all hold (user, clean tree, neither closed nor accepted, every open finding listed: none, none blocking), yet the acceptance is refused: ${err && err.message}`);
});
