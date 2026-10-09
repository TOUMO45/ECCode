'use strict';
// Confirmation probes for 1fcda26: link operands reaching a record only through existing-link chains,
// relative paths, dangling links, a subdirectory cwd, and quoted/flag-separated operands; plus the
// record-free lines that must keep passing. Links are made on disk first (a "prior turn"); the probed
// line creates the NEXT link and writes through it.
const WT = process.env.GUARD_WT || '/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpProject } = require(path.join(WT, 'tests', 'helpers'));
const GUARD = path.join(WT, 'scripts', 'hooks', 'guard.js');
function hook(payload) {
  const res = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000, env: { ...process.env, CLAUDE_PROJECT_DIR: '', ECCODE_ACTOR: '', ECCODE_SEQUENTIAL_ROLES: '', ECCODE_HOOKS: '' } });
  if (res.error) return { permissionDecision: 'TIMEOUT', permissionDecisionReason: String(res.error) };
  if (res.status !== 0 || res.stderr.trim()) return { permissionDecision: 'ERROR', permissionDecisionReason: res.stderr };
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput : null;
}
const agentOf = (role) => (role ? { agent_type: `eccode:${role}` } : {});
const results = [];
function probe(id, cwd, command, expect, note) {
  const out = hook({ cwd, tool_name: 'Bash', ...agentOf(null), tool_input: { command } });
  const decision = out ? out.permissionDecision : 'allow';
  results.push({ id, input: command, cwd: path.relative(process.env.HOME || '/', cwd), decision, expect, ok: expect === decision, note: note || '', reason: out ? out.permissionDecisionReason.slice(0, 110) : '' });
}
const cleanup = [];
const ctx = tmpProject();
cleanup.push(ctx.dir);
const D = ctx.dir;
const rec = path.join(D, '.eccode');
fs.mkdirSync(path.join(rec, 'drafts'), { recursive: true });
fs.mkdirSync(path.join(rec, 'memory'), { recursive: true });
fs.mkdirSync(path.join(D, 'src', 'deep'), { recursive: true });

// Pre-existing links ("prior turns"), each allowed to create on its own.
fs.symlinkSync(rec, path.join(D, 'a'));                         // a -> .eccode            (resolvable)
fs.symlinkSync(path.join(D, 'a'), path.join(D, 'a2'));          // a2 -> a -> .eccode       (chain, resolvable)
fs.symlinkSync(path.join(D, 'a2'), path.join(D, 'a3'));         // a3 -> a2 -> a -> .eccode (longer chain)
fs.symlinkSync(path.join(rec, 'memory'), path.join(D, 'mem')); // mem -> .eccode/memory    (record subdir)
fs.symlinkSync(path.join(rec, 'drafts'), path.join(D, 'dr'));  // dr -> .eccode/drafts     (draft area)
fs.symlinkSync(path.join(rec, 'newrec.json'), path.join(D, 'dang')); // dang -> .eccode/newrec.json (dangling into record)
fs.symlinkSync(path.join(rec, 'drafts', 'new.json'), path.join(D, 'dangdr')); // dangling into a draft area
fs.symlinkSync('../.eccode', path.join(D, 'src', 'rel'));      // src/rel -> ../.eccode    (relative, resolvable)
fs.symlinkSync('../../.eccode/memory', path.join(D, 'src', 'deep', 'relmem')); // relative two-up into a record subdir
fs.symlinkSync(path.join(D, 'src'), path.join(D, 'srclink'));  // srclink -> src           (non-record dir)

// MUST DENY: a fresh link whose operand resolves (through the pre-existing links) into a record.
probe('chain-a', D, 'ln -s a b && echo x > b/state.json', 'deny', 'a -> .eccode');
probe('chain-a2', D, 'ln -s a2 b && echo x > b/state.json', 'deny', 'a2 -> a -> .eccode');
probe('chain-a3', D, 'ln -s a3 b && echo x > b/events.jsonl', 'deny', 'three-hop chain');
probe('chain-cp-s', D, 'cp -s a b && echo x > b/config.json', 'deny');
probe('chain-cp-l', D, 'cp -l a/state.json b && echo x > b', 'deny', 'hard-link target resolves into record? operand a/state.json');
probe('subdir-mem', D, 'ln -s mem m && echo x > m/forged.json', 'deny', 'mem -> .eccode/memory');
probe('subdir-rel-literal', D, 'ln -s ./a/memory m && echo x > m/forged.json', 'deny', 'literal path through link a into a record subdir');
probe('rel-dotdot', D, 'ln -s src/rel b && echo x > b/state.json', 'deny', 'operand is a relative-link dir');
probe('rel-two-up', D, 'ln -s src/deep/relmem m && echo x > m/x.json', 'deny', 'relmem -> ../../.eccode/memory');
probe('quoted-operand', D, "ln -s 'a' b && echo x > b/state.json", 'deny', 'quoted operand a');
probe('dquoted-operand', D, 'ln -s "a" b && echo x > b/state.json', 'deny');
probe('flagged-ln', D, 'ln -sfn a b && echo x > b/state.json', 'deny', 'operand after -sfn');
probe('mklink-chain', D, 'mklink b a && echo x > b/state.json', 'deny', 'mklink target a');
probe('from-subdir-cwd', path.join(D, 'src'), 'ln -s ../a b && echo x > b/state.json', 'deny', 'cwd is src; ../a -> .eccode');
probe('from-subdir-rel', path.join(D, 'src'), 'ln -s rel b && echo x > b/state.json', 'deny', 'cwd src; rel -> ../.eccode');
probe('dangling-operand', D, 'ln -s dang b && echo x > b', 'deny', 'HARD: dang -> .eccode/newrec.json (dangling into record)');
probe('abs-operand', D, `ln -s ${path.join(D, 'a')} b && echo x > b/state.json`, 'deny', 'absolute operand to the record link');

// MUST ALLOW: record-free links, draft-area links, reads, single-target lines.
probe('nonrecord-chain', D, 'ln -s srclink b && echo x > b/x.js', 'allow', 'srclink -> src, not a record');
probe('draft-link', D, 'ln -s dr b && echo x > b/n.md', 'allow', 'dr -> .eccode/drafts (draft area)');
probe('dangling-draft', D, 'ln -s dangdr b && echo x > b', 'allow', 'dangling into a draft area');
probe('plain-nonrecord', D, 'ln -s p q && touch c', 'allow', 'record-free build line');
probe('release-line', D, 'ln -sf dist/current releases/latest && echo ok > releases/latest.txt', 'allow');
probe('cp-l-nonrecord', D, 'cp -l src/deep/x y && echo x > z', 'allow', 'hard link of a non-record file');
probe('read-through-link', D, 'cat a/state.json', 'allow', 'read, not a writer');
probe('single-target-record-link', D, 'ln -s a b', 'allow', 'one target: no write to bind');
probe('nonrecord-abs', D, `ln -s ${path.join(D, 'src')} b && echo x > b2`, 'allow', 'absolute non-record operand');

const failures = results.filter((r) => !r.ok);
const lines = [`# 1fcda26 link-operand-resolution probes against ${GUARD}`, `# node ${process.version}; ${results.length} probes; ${failures.length} mismatches`, '', 'id | cwd | decision | expect | ok | note | reason'];
for (const r of results) lines.push([r.id, r.cwd, r.decision, r.expect, r.ok ? 'ok' : 'MISMATCH', r.note, r.reason.replace(/\s+/g, ' ')].join(' | '));
lines.push('', '## Inputs');
for (const r of results) lines.push(`${r.id}: ${JSON.stringify(r.input)}`);
fs.writeFileSync(path.join(__dirname, 'results7.txt'), lines.join('\n') + '\n');
process.stdout.write(lines.slice(0, 4 + results.length).join('\n') + '\n');
for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
