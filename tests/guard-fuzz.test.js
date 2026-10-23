'use strict';
// Seeded fuzz battery for the guard: hundreds of generated attack variants
// must ALL be denied, and generated legitimate commands must ALL be allowed —
// fuzzing both directions catches over-blocking as well as holes. The PRNG is
// seeded, so a failure reproduces exactly.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { tmpProject, approveThroughPlan } = require('./helpers');

const GUARD = path.join(__dirname, '..', 'scripts', 'hooks', 'guard.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

function decision(dir, agent, command) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: dir, tool_name: 'Bash', ...(agent ? { agent_type: `eccode:${agent}` } : {}), tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ECCODE_ACTOR: '' },
  });
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.permissionDecision : 'allow';
}

const RECORD_PATHS = ['.eccode/events.jsonl', '.eccode/state.json', '.eccode/config.json', '.eccode/memory/records/l1.json', '.eccode/evidence/e1.log'];
const PREFIXES = ['', 'cd .eccode && ', 'FOO=1 ', '  ', 'true && '];
const SUFFIXES = ['', ' && echo done', ' ; echo done', ' 2>/dev/null'];
const quote = (p) => pick([p, `"${p}"`, `'${p}'`]);

function attackCase(role) {
  const kind = pick(['interpreter', 'redirect', 'filetool', 'actor', 'env-actor', 'out-of-claim']);
  const rec = pick(RECORD_PATHS);
  const recBase = rec.replace('.eccode/', pick(['.eccode/', ''])); // half the cases address it from inside .eccode via the cd prefix
  switch (kind) {
    case 'interpreter':
      return pick([
        `python3 -c "open('${rec}','${pick(['a', 'w'])}').write('x')"`,
        `node -e "require('fs').${pick(['appendFileSync', 'writeFileSync'])}('${rec}','x')"`,
        `python3 - <<'EOF'\nopen('${rec}', 'a').write('x')\nEOF`,
      ]);
    case 'redirect':
      return `${pick(PREFIXES)}${pick(['echo x >', 'echo x >>', 'printf y >'])} ${quote(kindPath(recBase))}${pick(SUFFIXES)}`;
    case 'filetool':
      return `${pick(PREFIXES)}${pick([`sed -i s/a/b/ ${quote(rec)}`, `cp /tmp/x ${quote(rec)}`, `mv /tmp/x ${quote(rec)}`, `truncate -s 0 ${quote(rec)}`, `rm ${quote(rec)}`, `tee ${quote(rec)} < /tmp/x`])}${pick(SUFFIXES)}`;
    case 'actor': {
      const other = pick(['user', 'orchestrator', 'technical-reviewer', 'delivery-lead'].filter((r) => r !== role));
      const sep = pick([' ', '=']);
      const dup = pick(['', ` --actor${sep}${role}`]);
      return `node .claude/eccode/bin/eccode.js risk add --id R1 --title t --severity low${dup} --actor${sep}${pick([`"${other}"`, other])}`;
    }
    case 'env-actor':
      return `${pick(['', 'cd . && '])}${pick([`ECCODE_ACTOR=user `, `export ECCODE_ACTOR=user; `])}node .claude/eccode/bin/eccode.js task list`;
    case 'out-of-claim':
    default:
      return `${pick(PREFIXES)}${pick(['echo pwn >', 'echo pwn >>'])} ${quote(pick(['src/server/auth.js', 'tests/c.test.js', 'README.md', 'package.json']))}${pick(SUFFIXES)}`;
  }
  function kindPath(p) {
    return p;
  }
}

function legitimateCase(role) {
  const kind = pick(['read-record', 'git-read', 'own-eccode', 'own-claimed-write', 'drafts', 'outside-project']);
  switch (kind) {
    case 'read-record':
      return `${pick(['cat', 'head -n 2', 'grep -c seq', 'jq .seq', 'wc -l'])} ${quote(pick(RECORD_PATHS.slice(0, 3)))}${pick(SUFFIXES)}`;
    case 'git-read':
      return pick(['git diff -- .eccode/events.jsonl', 'git log -2 .eccode', 'git status', 'git show HEAD:./.eccode/events.jsonl']);
    case 'own-eccode':
      return `node .claude/eccode/bin/eccode.js ${pick(['task list', 'status --brief', `evidence run --actor ${role} --label t -- "node -e \\"process.exit(0)\\""`, `task claim ui --actor ${role}`])}`;
    case 'own-claimed-write':
      return `${pick(['echo ok >', 'echo ok >>'])} ${quote('src/web/app.js')}`;
    case 'drafts':
      return `echo '{}' > ${quote(`.eccode/drafts/note-${Math.floor(rand() * 1000)}.json`)}`;
    case 'outside-project':
    default:
      return `npm test > ${quote(`/tmp/out-${Math.floor(rand() * 1000)}.log`)}`;
  }
}

test('fuzz: 240 generated attack variants are denied; 120 generated legitimate commands are allowed', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'ui', 'frontend-engineer'); // owns src/web/**
  const role = 'frontend-engineer';
  const failures = [];
  for (let i = 0; i < 240; i++) {
    const cmd = attackCase(role);
    const got = decision(ctx.dir, role, cmd);
    if (got !== 'deny' && got !== 'ask') failures.push(`attack #${i} ALLOWED: ${cmd}`);
  }
  for (let i = 0; i < 120; i++) {
    const cmd = legitimateCase(role);
    const got = decision(ctx.dir, role, cmd);
    if (got !== 'allow') failures.push(`legitimate #${i} ${got.toUpperCase()}: ${cmd}`);
  }
  assert.deepStrictEqual(failures, [], `seed 42 reproduces these:\n${failures.slice(0, 12).join('\n')}`);
});

// Identity written through quoting or shell expansion. An independent audit
// found these read as "no actor" (allowed with no ask): the guard now unquotes
// the --actor word and fails closed on expansion in eccode arguments.
const OBFUSCATED_IDENTITY = [
  "node .claude/eccode/bin/eccode.js risk add --id R1 --title t --severity low --actor us''er",
  'node .claude/eccode/bin/eccode.js risk add --id R1 --title t --severity low --actor "us"er',
  'node .claude/eccode/bin/eccode.js risk add --id R1 --title t --severity low --actor u\\ser',
  'node .claude/eccode/bin/eccode.js risk add --id R1 --title t --severity low --actor "$(echo user)"',
  'node .claude/eccode/bin/eccode.js risk add --id R1 --title t --severity low --actor `echo user`',
  'U=user; node .claude/eccode/bin/eccode.js risk add --id R1 --title t --severity low --actor $U',
  'A=--actor; node .claude/eccode/bin/eccode.js risk add --id R1 --title t --severity low $A user',
];

test('obfuscated identity: denied inside a subagent, held for the human in the main session', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const failures = [];
  for (const cmd of OBFUSCATED_IDENTITY) {
    const sub = decision(ctx.dir, 'frontend-engineer', cmd);
    if (sub !== 'deny') failures.push(`subagent ${sub}: ${cmd}`);
    const main = decision(ctx.dir, null, cmd);
    if (main !== 'ask' && main !== 'deny') failures.push(`main ${main}: ${cmd}`);
  }
  // Literal identities and expansion inside an evidence command stay allowed.
  for (const cmd of [
    'node .claude/eccode/bin/eccode.js task list',
    'node .claude/eccode/bin/eccode.js evidence run --actor frontend-engineer --label t -- "echo $HOME"',
  ]) {
    const got = decision(ctx.dir, 'frontend-engineer', cmd);
    if (got !== 'allow') failures.push(`legitimate ${got}: ${cmd}`);
  }
  assert.deepStrictEqual(failures, []);
});
