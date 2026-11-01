#!/usr/bin/env node
'use strict';
// The instrument check of amendment 2: before an item is kept, the harness
// grade is run where its answer is known. Migration: the upstream commit's own
// tree (the reference solution) must pass; a reference that fails (an upstream
// data migration that is destructive or has no downgrade) is dropped and
// reported. Authorization: the parent tree must be unsafe (the grade finds
// the flaw the item is about) and the commit tree safe; a policy that does
// not separate them drops the item. Results go into _tools/instrument.json
// (keyed by sha8; selection.json is the selector's file and is never rewritten
// here, since the selector may still be writing it). An item already checked
// is skipped unless --redo.
// usage: ECCODE_MEALIE_ENVS=<dir> node reference.js [--only migration|authorization] [--sha <sha8>] [--redo]
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
const OUT = path.join(TOOLS, 'instrument.json');

/** The instrument results so far (re-read before every write: the authorization drafting and this script may both append). */
function readInstrument() {
  return fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
}
function writeInstrument(sha8, entry) {
  const all = readInstrument();
  all[sha8] = { ...entry, at: new Date().toISOString() };
  fs.writeFileSync(OUT, `${JSON.stringify(all, null, 1)}\n`);
}

/** A sandbox-like tree: the parent tree committed as the fixture, the commit's files on top (uncommitted). */
function sandboxPair(a) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `senior-ref-${a.sha.slice(0, 8)}-`));
  const parent = lib.treeAt(lib.MEALIE, a.parent, path.join(root, 'parent'));
  const commit = lib.treeAt(lib.MEALIE, a.sha, path.join(root, 'commit'));
  const mk = (name, overlay) => {
    const dir = path.join(root, name);
    fs.cpSync(parent, dir, { recursive: true });
    // The parent is the fixture commit; the upstream change sits on it uncommitted, as an arm's change would.
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: dir });
    if (overlay) fs.cpSync(commit, dir, { recursive: true });
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
  const redo = argv.includes('--redo');
  const selection = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const category of ['migration', 'authorization']) {
    if (only && only !== category) continue;
    for (const a of selection.accepted[category] || []) {
      const sha8 = a.sha.slice(0, 8);
      if (sha && sha !== sha8) continue;
      if (!redo && readInstrument()[sha8]) continue;
      const policy = path.join(TOOLS, 'policies', `${sha8}.json`);
      if (category === 'authorization' && !fs.existsSync(policy)) continue;
      process.stderr.write(`reference: ${category} ${sha8} ${a.subject}\n`);
      const entry = { category, sha: a.sha, subject: a.subject };
      const t = sandboxPair(a);
      try {
        if (category === 'migration') {
          const r = grade.gradeMigration({ tree: t.commitSb, python: t.python });
          entry.referenceGrade = { safe: r.safe, reasons: r.reasons, findings: r.findings.map((f) => `${f.kind} ${f.file}:${f.line}`), proof: r.proof, files: r.files };
          if (!r.safe) entry.dropped = `reference solution fails the migration grade: ${r.reasons.join('; ')}`;
        } else {
          const p = authz.gradeAuthorization({ tree: t.parentSb, config: policy, python: t.python });
          const c = authz.gradeAuthorization({ tree: t.commitSb, config: policy, python: t.python });
          entry.instrument = { parentUnsafe: !p.safe, parent: { mismatches: p.mismatches, leaks: p.leaks, idor: p.idor, errors: p.errors }, commitSafe: c.safe, commit: { mismatches: c.mismatches, leaks: c.leaks, idor: c.idor, errors: c.errors } };
          if (p.safe || !c.safe) entry.dropped = `the policy does not separate the parent (${p.safe ? 'safe' : 'unsafe'}) from the commit (${c.safe ? 'safe' : 'unsafe'})`;
        }
        process.stderr.write(`reference: ${category} ${sha8} ${entry.dropped ? `DROPPED: ${entry.dropped}` : 'kept'}\n`);
      } catch (e) {
        entry.dropped = `instrument check failed: ${String(e.message).split('\n')[0]}`;
        process.stderr.write(`reference: ${category} ${sha8} error: ${e.message}\n`);
      } finally {
        t.cleanup();
      }
      writeInstrument(sha8, entry);
    }
  }
}

module.exports = { sandboxPair, readInstrument, OUT };

if (require.main === module) main(process.argv.slice(2));
