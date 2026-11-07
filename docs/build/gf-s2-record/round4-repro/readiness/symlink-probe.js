'use strict';
// Plan Review Focus 3 (a filesChanged path through a symlinked directory). Reports, for a backend completion that
// lists app/link/x.js where app/link -> web: what the hook says about the write, what GF-OWN-3 says about the listed
// path, and what GF-OWN-4 attribution says about the tree. Exit 0 when the ownership breach is caught by at least the
// hook (managed path) AND by attribution (no hook); it prints the GF-OWN-3 outcome as a fact either way.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const TREE = path.resolve(process.argv[2]);
const R = (rel) => require(path.join(TREE, rel));
const sample = R('tests/fixtures/gf/sample');
const { gfProject, run, WRAPPED } = R('tests/fixtures/gf/flow');
const wrap = R('lib/greenfield/wrap');
const ownershipOps = R('lib/greenfield/ownership-ops');
const GUARD = path.join(TREE, 'scripts/hooks/guard.js');

const ctx = gfProject();
run(ctx, sample.build(), WRAPPED);
wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
wrap.taskClaim(ctx.store, ctx.config, 's0-contracts', 'integration-engineer');
ctx.store.commit('task.claimed', 'backend-engineer', { task: 's0-app', runId: null });
fs.mkdirSync(path.join(ctx.dir, 'web'), { recursive: true });
fs.mkdirSync(path.join(ctx.dir, 'app'), { recursive: true });
fs.symlinkSync(path.join(ctx.dir, 'web'), path.join(ctx.dir, 'app', 'link'), 'dir');

const res = spawnSync(process.execPath, [GUARD], {
  input: JSON.stringify({ cwd: ctx.dir, tool_name: 'Write', agent_type: 'eccode:backend-engineer', tool_input: { file_path: path.join(ctx.dir, 'app/link/x.js'), content: 'x' } }),
  encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.dir, ECCODE_ACTOR: '' },
});
const hook = res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : { permissionDecision: 'allow' };
console.log(`hook (GF-OWN-2) on backend Write app/link/x.js: ${hook.permissionDecision} :: ${hook.permissionDecisionReason || ''}`);

fs.writeFileSync(path.join(ctx.dir, 'web/x.js'), 'x'); // the write as it lands with the hook off
const own3 = ownershipOps.completionCheck(ctx.store, 'backend-engineer', { filesChanged: ['app/main.py', 'app/link/x.js'] });
console.log(`GF-OWN-3 completionCheck(backend, [app/main.py, app/link/x.js]): ${own3.length ? own3.map((p) => `${p.rule}: ${p.message}`).join('; ') : 'no problem (judged on the lexical path)'}`);

const at = ownershipOps.attribute(ctx.store, 'HEAD');
const webHit = at.problems.find((p) => /web\/x\.js/.test(p.message));
console.log(`GF-OWN-4 attribute --base HEAD: ${webHit ? `${webHit.rule}: ${webHit.message}` : 'web/x.js not reported'}`);

const ok = hook.permissionDecision === 'deny' && Boolean(webHit);
console.log(ok ? 'caught by the hook and by attribution' : 'NOT caught by both');
process.exit(ok ? 0 : 1);
