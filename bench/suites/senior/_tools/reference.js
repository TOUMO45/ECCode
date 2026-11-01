#!/usr/bin/env node
'use strict';
// The instrument check of amendment 2: before an item is kept, the harness
// grade is run where its answer is known. Migration: the upstream commit's own
// tree (the reference solution) must pass; a reference that fails (an upstream
// data migration that is destructive or has no downgrade) is dropped and
// reported. Authorization: the parent tree must be unsafe (the grade finds
// the flaw the item is about) and the commit tree safe; a policy that does
// not separate them drops the item. Results go into selection.json.
// usage: ECCODE_MEALIE_ENVS=<dir> node reference.js [--only migration|authorization] [--sha <sha8>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('../../../pilot/lib');
const env = require('../../mealie/_tools/env');
const grade = require('./grade');
const authz = require('./grade-authorization');

const TOOLS = __dirname;
const FILE = path.join(TOOLS, 'selection.json');

/** A sandbox-like tree: the parent tree committed as the fixture, the commit's files on top (uncommitted). */
function sandboxPair(a) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `senior-ref-${a.sha.slice(0, 8)}-`));
  const parent = lib.treeAt(lib.MEALIE, a.parent, path.join(root, 'parent'));
  const commit = lib.treeAt(lib.MEALIE, a.sha, path.join(root, 'commit'));
  const mk = (name, overlay) => {
    const dir = path.join(root, name);
    fs.cpSync(parent, dir, { recursive: true });
    if (overlay) fs.cpSync(commit, dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: dir });
    return dir;
  };
  const parentSb = mk('parent-sb', false);
  const commitSb = mk('commit-sb', true);
  const python = path.join(env.pythonEnv(commit), 'bin', 'python');
  return { parentSb, commitSb, python, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function main(argv) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const sha = argv.includes('--sha') ? argv[argv.indexOf('--sha') + 1] : null;
  const selection = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const save = () => fs.writeFileSync(FILE, `${JSON.stringify(selection, null, 1)}\n`);
  for (const category of ['migration', 'authorization']) {
    if (only && only !== category) continue;
    for (const a of selection.accepted[category] || []) {
      const sha8 = a.sha.slice(0, 8);
      if (sha && sha !== sha8) continue;
      if (category === 'migration' && a.referenceGrade) continue;
      if (category === 'authorization' && a.instrument) continue;
      const policy = path.join(TOOLS, 'policies', `${sha8}.json`);
      if (category === 'authorization' && !fs.existsSync(policy)) continue;
      process.stderr.write(`reference: ${category} ${sha8} ${a.subject}\n`);
      const t = sandboxPair(a);
      try {
        if (category === 'migration') {
          const r = grade.gradeMigration({ tree: t.commitSb, python: t.python });
          a.referenceGrade = { safe: r.safe, reasons: r.reasons, findings: r.findings.map((f) => `${f.kind} ${f.file}:${f.line}`), proof: r.proof, files: r.files };
          if (!r.safe) a.dropped = `reference solution fails the migration grade: ${r.reasons.join('; ')}`;
          else delete a.dropped;
        } else {
          const p = authz.gradeAuthorization({ tree: t.parentSb, config: policy, python: t.python });
          const c = authz.gradeAuthorization({ tree: t.commitSb, config: policy, python: t.python });
          a.instrument = { parentUnsafe: !p.safe, parent: { mismatches: p.mismatches, leaks: p.leaks, idor: p.idor, errors: p.errors }, commitSafe: c.safe, commit: { mismatches: c.mismatches, leaks: c.leaks, idor: c.idor, errors: c.errors } };
          if (p.safe || !c.safe) a.dropped = `the policy does not separate the parent (${p.safe ? 'safe' : 'unsafe'}) from the commit (${c.safe ? 'safe' : 'unsafe'})`;
          else delete a.dropped;
        }
        process.stderr.write(`reference: ${category} ${sha8} ${a.dropped ? `DROPPED: ${a.dropped}` : 'kept'}\n`);
      } catch (e) {
        a.dropped = `instrument check failed: ${String(e.message).split('\n')[0]}`;
        process.stderr.write(`reference: ${category} ${sha8} error: ${e.message}\n`);
      } finally {
        t.cleanup();
      }
      save();
    }
  }
  save();
}

module.exports = { sandboxPair };

if (require.main === module) main(process.argv.slice(2));
