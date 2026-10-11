'use strict';
// TK-6 (RescueStock pilot review): treeDigest(root) re-hashes the files git reports as dirty with
// `git hash-object --stdin-paths`. Those paths were relative to the project root, but --stdin-paths
// resolves them from the repository's top level, not the working directory. For a project nested
// below the repository root (examples/rescuestock) a dirty file that exists only in the project made
// hash-object fail and the digest null (tree pinning silently off), and a dirty file with a same-named
// twin at the repository root (package.json, .eccode/*) was hashed from the twin's bytes. The
// .eccode/ entries were in the hashed batch although the digest excludes them, so one of them alone
// could null the digest.
//
// The oracle below computes the documented digest independently: one "<path> <blob>" line per file
// in the project's working tree (tracked or untracked, deleted files left out, .eccode/ excluded),
// each blob from `git hash-object -- <path>` run in the project directory (command-line paths are
// resolved from the working directory), sorted and hashed with sha256.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { initRepo } = require('./helpers');
const { treeDigest } = require('../lib/project');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commitAll(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', message]);
}

/** A throwaway repository with files at the root and a project at nested/app. */
function nestedRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tk6-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initRepo(repo); // core.autocrlf=false and an empty first commit
  write(repo, 'package.json', '{ "name": "repository-root" }\n');
  write(repo, '.eccode/state.json', '{ "root": true }\n');
  write(repo, 'README.md', '# repository\n');
  const project = path.join(repo, 'nested', 'app');
  write(project, 'package.json', '{ "name": "nested-app", "version": "1.0.0" }\n');
  write(project, 'src/main.js', 'module.exports = 1;\n');
  write(project, '.eccode/state.json', '{ "nested": true }\n');
  commitAll(repo, 'init');
  return { repo, project };
}

function expectedDigest(project) {
  const listed = (args) => git(project, ['ls-files', '-z', ...args]).split('\0').filter(Boolean);
  const files = [...new Set([...listed([]), ...listed(['--others', '--exclude-standard'])])]
    .filter((rel) => !rel.startsWith('.eccode/'))
    .filter((rel) => fs.existsSync(path.join(project, rel)));
  const lines = files.map((rel) => `${rel} ${git(project, ['hash-object', '--', rel]).trim()}`);
  return crypto.createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

test('TK-6 nested project: a dirty file that exists only in the project gives a digest of its bytes', (t) => {
  const { repo, project } = nestedRepo(t);
  const clean = treeDigest(project);
  assert.match(String(clean), /^[0-9a-f]{64}$/);
  assert.strictEqual(clean, expectedDigest(project));

  write(project, 'src/main.js', 'module.exports = 2;\n');
  const d1 = treeDigest(project);
  assert.notStrictEqual(d1, null, 'a dirty project-only file must not null the digest (tree pinning off)');
  assert.match(String(d1), /^[0-9a-f]{64}$/);
  assert.strictEqual(d1, expectedDigest(project));
  assert.notStrictEqual(d1, clean);

  write(project, 'src/main.js', 'module.exports = 3;\n');
  const d2 = treeDigest(project);
  assert.notStrictEqual(d2, null);
  assert.notStrictEqual(d2, d1, 'different bytes, different digest');
  assert.strictEqual(d2, expectedDigest(project));

  write(project, 'src/extra.js', 'untracked\n'); // untracked and project-only
  const d3 = treeDigest(project);
  assert.strictEqual(d3, expectedDigest(project));

  commitAll(repo, 'commit the same bytes');
  assert.strictEqual(treeDigest(project), d3, 'committing the same bytes does not change the digest');
});

test('TK-6 nested project: a dirty package.json is hashed from the project, not from its twin at the repository root', (t) => {
  const { repo, project } = nestedRepo(t);
  write(project, 'package.json', '{ "name": "nested-app", "version": "1.0.1" }\n');
  const nested = treeDigest(project);
  assert.match(String(nested), /^[0-9a-f]{64}$/);
  assert.strictEqual(nested, expectedDigest(project), 'the digest covers the nested file\'s bytes');

  // The root file now holds the nested file's bytes: a digest that read the root twin would change.
  fs.copyFileSync(path.join(project, 'package.json'), path.join(repo, 'package.json'));
  assert.strictEqual(treeDigest(project), nested, 'the nested digest must not depend on the repository root\'s package.json');

  // And the same bytes committed give the same digest (content, not status).
  git(repo, ['add', 'nested/app/package.json']);
  git(repo, ['commit', '-q', '-m', 'nested package.json']);
  assert.strictEqual(treeDigest(project), nested);
});

test('TK-6 a project at the repository root behaves as before', (t) => {
  const { repo } = nestedRepo(t);
  const clean = treeDigest(repo);
  assert.match(String(clean), /^[0-9a-f]{64}$/);
  assert.strictEqual(clean, expectedDigest(repo));

  write(repo, 'nested/app/src/main.js', 'module.exports = 2;\n');
  write(repo, 'package.json', '{ "name": "repository-root", "private": true }\n');
  write(repo, 'notes.txt', 'untracked\n');
  const d1 = treeDigest(repo);
  assert.match(String(d1), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(d1, clean);
  assert.strictEqual(d1, expectedDigest(repo));

  write(repo, '.eccode/drafts/scratch.md', 'scratch\n');
  write(repo, '.eccode/state.json', '{ "root": "changed" }\n');
  assert.strictEqual(treeDigest(repo), d1, 'the record under .eccode/ is not part of the source tree');

  fs.unlinkSync(path.join(repo, 'README.md'));
  const d2 = treeDigest(repo);
  assert.notStrictEqual(d2, d1);
  assert.strictEqual(d2, expectedDigest(repo), 'a deleted file leaves the digest');

  commitAll(repo, 'commit the same bytes');
  assert.strictEqual(treeDigest(repo), d2);
});

test('TK-6 nested project: a dirty file under the project\'s .eccode/ does not null the digest', (t) => {
  const { project } = nestedRepo(t);
  const clean = treeDigest(project);
  assert.match(String(clean), /^[0-9a-f]{64}$/);

  // Untracked, and no file of that path exists at the repository root.
  write(project, '.eccode/drafts/notes.md', 'scratch\n');
  assert.strictEqual(treeDigest(project), clean, 'a draft in the project record must not null or change the digest');

  // Tracked, with a twin at the repository root.
  write(project, '.eccode/state.json', '{ "nested": "changed" }\n');
  assert.strictEqual(treeDigest(project), clean);

  // Beside a real source change, the record still contributes nothing.
  write(project, 'src/main.js', 'module.exports = 4;\n');
  const d = treeDigest(project);
  assert.notStrictEqual(d, null);
  assert.strictEqual(d, expectedDigest(project));
});
