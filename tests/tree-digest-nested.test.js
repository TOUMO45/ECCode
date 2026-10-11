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

function tmpDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-tk6-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A throwaway repository with files at the root and a project at `projectRel` (default nested/app). */
function nestedRepo(t, { repo, projectRel = 'nested/app' } = {}) {
  if (repo) fs.mkdirSync(repo, { recursive: true });
  else repo = tmpDir(t, 'repo');
  initRepo(repo); // core.autocrlf=false and an empty first commit
  write(repo, 'package.json', '{ "name": "repository-root" }\n');
  write(repo, '.eccode/state.json', '{ "root": true }\n');
  write(repo, 'README.md', '# repository\n');
  const project = path.join(repo, ...projectRel.split('/'));
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

// ------------------------------------------------------------------ review of cb73d42, round 2
// Names a POSIX file system accepts and Windows does not (trailing spaces, quotes, newlines, CR).
const POSIX_NAMES = { skip: process.platform === 'win32' ? 'file names Windows does not allow' : false };
const HEX = /^[0-9a-f]{64}$/;

test('TK-6 F3: a repository directory whose name ends in a space is not read as its trimmed sibling', POSIX_NAMES, (t) => {
  const parent = tmpDir(t, 'top');
  // What a trimmed --show-toplevel would name: a sibling directory holding the same project path.
  write(path.join(parent, 'repo'), 'nested/app/src/main.js', 'module.exports = "the sibling";\n');
  const { project } = nestedRepo(t, { repo: path.join(parent, 'repo ') });
  write(project, 'src/main.js', 'module.exports = 2;\n');
  const d = treeDigest(project);
  assert.match(String(d), HEX);
  assert.strictEqual(d, expectedDigest(project), 'the dirty file is hashed from this repository, not from the trimmed path');
});

test('TK-6 F3: a project below a directory whose name starts with a space sees its own dirty files', POSIX_NAMES, (t) => {
  const { project } = nestedRepo(t, { projectRel: ' lead space/app' });
  const clean = treeDigest(project);
  assert.match(String(clean), HEX);
  write(project, 'src/main.js', 'module.exports = 2;\n');
  const d = treeDigest(project);
  assert.notStrictEqual(d, clean, 'an edit must move the digest (a trimmed prefix matched no status path)');
  assert.strictEqual(d, expectedDigest(project));
});

const ODD_NAMES = ['x\ny.txt', 'cr\r', '"a.txt"', '"bad', 'tab\there.txt', 'back\\slash.txt', 'ünï cödé.txt', 'bell\u0007.txt'];

test('TK-6 F4: every --stdin-paths line is C-quoted: odd names hash like git hash-object -- <path> (root project)', POSIX_NAMES, (t) => {
  const { repo } = nestedRepo(t);
  for (const name of ODD_NAMES) write(repo, `odd/${name}`, `committed ${JSON.stringify(name)}\n`);
  commitAll(repo, 'odd names');
  const clean = treeDigest(repo);
  assert.strictEqual(clean, expectedDigest(repo));
  for (const name of ODD_NAMES) write(repo, `odd/${name}`, `edited ${JSON.stringify(name)}\n`);
  const d = treeDigest(repo);
  assert.match(String(d), HEX, 'a name with a newline, a CR or a leading quote must not null the digest');
  assert.strictEqual(d, expectedDigest(repo));
  // "a.txt" (with its quotes) used to be read as a.txt: its edits did not move the digest.
  write(repo, 'odd/"a.txt"', 'edited again\n');
  assert.notStrictEqual(treeDigest(repo), d);
  assert.strictEqual(treeDigest(repo), expectedDigest(repo));
});

test('TK-6 F4: a nested project below a directory whose name starts with a double quote', POSIX_NAMES, (t) => {
  const { project } = nestedRepo(t, { projectRel: '"quoted dir/app' });
  for (const name of ODD_NAMES) write(project, `odd/${name}`, `untracked ${JSON.stringify(name)}\n`);
  write(project, 'src/main.js', 'module.exports = 2;\n');
  const d = treeDigest(project);
  assert.match(String(d), HEX);
  assert.strictEqual(d, expectedDigest(project));
});

test('TK-6 F5 nested project: staged rename then edit (RM), copy then edit (CM), deletions and MM', (t) => {
  const { repo, project } = nestedRepo(t);
  const big = Array.from({ length: 40 }, (_, i) => `line ${i} of a file large enough for copy detection`).join('\n') + '\n';
  write(project, 'lib/big.js', big);
  write(project, 'src/gone.js', 'module.exports = "staged delete";\n');
  write(project, 'src/uncached.js', 'module.exports = "git rm --cached";\n');
  write(project, 'README.md', '# nested readme, twin of the root README.md\n');
  commitAll(repo, 'more files');
  git(repo, ['config', 'status.renames', 'copies']);

  git(project, ['mv', 'src/main.js', 'src/moved.js']); // RM
  write(project, 'src/moved.js', 'module.exports = "moved and edited";\n');
  write(project, 'lib/big.js', big.replace('line 3 ', 'line three ')); // CM: the source changed, the copy staged then edited
  write(project, 'lib/copy.js', big);
  git(project, ['add', 'lib/big.js', 'lib/copy.js']);
  write(project, 'lib/copy.js', `${big}// edited copy\n`);
  git(project, ['rm', '-q', 'src/gone.js']); // D (staged)
  git(project, ['rm', '-q', '--cached', 'src/uncached.js']); // D + ??
  fs.unlinkSync(path.join(project, 'README.md')); // " D" beside a twin at the repository root
  write(project, 'package.json', '{ "name": "nested-app", "version": "2.0.0" }\n'); // MM beside a twin
  git(project, ['add', 'package.json']);
  write(project, 'package.json', '{ "name": "nested-app", "version": "2.0.1" }\n');

  const status = git(project, ['status', '--porcelain']);
  for (const code of [/^RM /m, /^CM /m, /^D {2}/m, /^ D /m, /^MM /m, /^\?\? /m]) assert.match(status, code, `the case is exercised:\n${status}`);
  const d = treeDigest(project);
  assert.match(String(d), HEX);
  assert.strictEqual(d, expectedDigest(project));
  commitAll(repo, 'the same bytes, committed');
  assert.strictEqual(treeDigest(project), d);
});

test('TK-6 F5 nested project in a linked worktree: its own bytes, not the main working tree\'s', (t) => {
  const { repo } = nestedRepo(t);
  const wt = path.join(tmpDir(t, 'wt'), 'linked');
  git(repo, ['worktree', 'add', '-q', wt]);
  const project = path.join(wt, 'nested', 'app');
  const clean = treeDigest(project);
  assert.strictEqual(clean, expectedDigest(project));
  write(project, 'src/main.js', 'module.exports = "worktree";\n');
  write(project, 'package.json', '{ "name": "nested-app", "version": "worktree" }\n');
  const d = treeDigest(project);
  assert.match(String(d), HEX);
  assert.notStrictEqual(d, clean);
  assert.strictEqual(d, expectedDigest(project));
  write(repo, 'nested/app/src/main.js', 'module.exports = "main working tree";\n');
  write(repo, 'package.json', '{ "name": "main working tree" }\n');
  assert.strictEqual(treeDigest(project), d, 'edits in the main working tree do not move the linked worktree\'s digest');
});
