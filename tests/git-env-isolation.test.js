'use strict';
// TK-6 R3-1 (review of 366c8ab): every git call the engine makes inherited the caller's environment, so
// GIT_DIR, GIT_WORK_TREE, GIT_CEILING_DIRECTORIES or a config override (GIT_CONFIG_COUNT/KEY/VALUE,
// GIT_CONFIG_PARAMETERS: core.worktree) on an eccode command made the engine believe it was outside any
// work tree: the run recorded neither tree nor marker and printed nothing, a stale run was cited as current,
// and `gate submit` recorded an approval with no commit. An eccode call made from a git hook (GIT_DIR=.git,
// GIT_INDEX_FILE set, the hook's cwd at the repository top) misfired the same way for a nested project.
// The engine now runs git with the repository-selection and config variables removed, so discovery always
// starts from the project directory.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor, expectCode, ARCH_MD, initRepo } = require('./helpers');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { init, treeDigest, treePin, gitHead, insideWorkTree, gitChangedFiles } = require('../lib/project');
const { workingTreeStatus } = require('../lib/delivery');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');
const HEX = /^[0-9a-f]{64}$/;

/** Set (or with undefined, remove) process variables for the duration of fn; the engine's git children inherit them. */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
}

/** A repository with a committed file at the root and an initialised project at nested/app with a dirty file. */
function nestedProject() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gitenv-'));
  initRepo(repo);
  write(repo, 'package.json', '{ "name": "root" }\n');
  write(repo, 'nested/app/src/main.js', 'module.exports = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'files');
  const project = path.join(repo, 'nested', 'app');
  const store = init(project, { name: 'Nested', idea: 'A project below the repository root' });
  write(project, 'src/main.js', 'module.exports = 2;\n');
  write(project, 'src/new.js', 'untracked\n');
  return { repo, project, store };
}

const nowhere = () => path.join(os.tmpdir(), `eccode-nowhere-${process.pid}-${Math.random().toString(36).slice(2)}`);

/** An ignore file that hides every file: a config override pointing core.excludesFile at it hides untracked files from git. */
function ignoreAll() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-ignore-')), 'ignore');
  fs.writeFileSync(file, '*\n');
  return file;
}

/** A config file that sets core.excludesFile to ignoreAll(). */
function hidingConfig() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-config-')), 'gitconfig');
  fs.writeFileSync(file, `[core]\n\texcludesFile = ${ignoreAll()}\n`);
  return file;
}

// Each variable at a wrong or nonexistent value. GIT_CEILING_DIRECTORIES at the repository root stops
// discovery from the nested project before it reaches the repository.
const CASES = [
  ['GIT_DIR', () => ({ GIT_DIR: nowhere() })],
  ['GIT_DIR inside the project', ({ project }) => ({ GIT_DIR: path.join(project, 'nope') })],
  ['GIT_WORK_TREE', () => ({ GIT_WORK_TREE: fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-elsewhere-')) })],
  ['GIT_DIR + GIT_WORK_TREE elsewhere', ({ repo }) => ({ GIT_DIR: path.join(repo, '.git'), GIT_WORK_TREE: fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-elsewhere-')) })],
  ['GIT_INDEX_FILE', () => ({ GIT_INDEX_FILE: nowhere() })],
  ['GIT_COMMON_DIR', () => ({ GIT_COMMON_DIR: nowhere() })],
  ['GIT_OBJECT_DIRECTORY', () => ({ GIT_OBJECT_DIRECTORY: nowhere() })],
  ['GIT_ALTERNATE_OBJECT_DIRECTORIES', () => ({ GIT_ALTERNATE_OBJECT_DIRECTORIES: nowhere() })],
  ['GIT_CEILING_DIRECTORIES', ({ repo }) => ({ GIT_CEILING_DIRECTORIES: fs.realpathSync(repo) })],
  ['GIT_DISCOVERY_ACROSS_FILESYSTEM', () => ({ GIT_DISCOVERY_ACROSS_FILESYSTEM: '0' })],
  ['GIT_NAMESPACE', () => ({ GIT_NAMESPACE: 'elsewhere' })],
  ['GIT_CONFIG', () => ({ GIT_CONFIG: hidingConfig() })],
  // A global or system config file named by the environment that hides untracked files.
  ['GIT_CONFIG_GLOBAL', () => ({ GIT_CONFIG_GLOBAL: hidingConfig() })],
  ['GIT_CONFIG_SYSTEM', () => ({ GIT_CONFIG_SYSTEM: hidingConfig(), GIT_CONFIG_NOSYSTEM: undefined })],
  ['GIT_CONFIG_NOSYSTEM', () => ({ GIT_CONFIG_NOSYSTEM: '1' })],
  ['GIT_CONFIG_COUNT/KEY/VALUE (core.excludesFile)', () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: ignoreAll() })],
  ['GIT_CONFIG_PARAMETERS (core.excludesFile)', () => ({ GIT_CONFIG_PARAMETERS: `'core.excludesfile'='${ignoreAll()}'` })],
];

for (const [label, vars] of CASES) {
  test(`R3-1 ${label} in the environment does not change what the engine sees`, () => {
    const ctx = nestedProject();
    const expected = { tree: treeDigest(ctx.project), head: gitHead(ctx.project), changed: gitChangedFiles(ctx.project, gitHead(ctx.project)), status: workingTreeStatus(ctx.project) };
    assert.match(String(expected.tree), HEX);
    withEnv(vars(ctx), () => {
      assert.strictEqual(insideWorkTree(ctx.project), true);
      assert.strictEqual(treeDigest(ctx.project), expected.tree);
      assert.deepStrictEqual(treePin(ctx.project), { tree: expected.tree });
      assert.strictEqual(gitHead(ctx.project), expected.head);
      assert.deepStrictEqual(gitChangedFiles(ctx.project, expected.head), expected.changed, 'completion\'s ownership accounting');
      assert.deepStrictEqual(workingTreeStatus(ctx.project), expected.status, 'delivery\'s clean-tree check');
    });
  });
}

test('R3-1 a run recorded with GIT_DIR or GIT_WORK_TREE pointed elsewhere is pinned and refused as stale', () => {
  for (const vars of [{ GIT_DIR: nowhere() }, { GIT_WORK_TREE: fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-elsewhere-')) }]) {
    const ctx = tmpProject();
    approveThroughPlan(ctx);
    const { store, config, dir } = ctx;
    gates.startGate(store, config, 'phase:core', 'orchestrator');
    tasks.claim(store, config, 'api', 'backend-engineer');
    write(dir, 'src/server/app.js', 'module.exports = "bytes A";\n');
    const run = withEnv(vars, () => passCheck(store, 'backend-engineer'));
    write(dir, 'src/server/app.js', 'module.exports = "bytes B";\n');
    const complete = (ids) => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', ids, ['src/server/app.js']));
    const err = expectCode(() => complete([run.id]), 'INVALID_HANDOFF');
    assert.match(err.message, new RegExp(`ev:${run.id} ran on different bytes`), Object.keys(vars).join());
    assert.match(String(run.tree), HEX);
  }
});

test('R3-1 gate submit with GIT_DIR pointed elsewhere still records the commit and the tree', () => {
  const { dir, store, config } = tmpProject();
  gates.startGate(store, config, 'architecture', 'orchestrator');
  write(dir, '.eccode/artifacts/brief.md', ARCH_MD);
  const { event } = withEnv({ GIT_DIR: nowhere() }, () => gates.submit(store, config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] }));
  assert.strictEqual(event.data.commit, gitHead(dir));
  assert.match(String(event.data.tree), HEX);
});

test('R3-1 the CLI run from a git hook environment (GIT_DIR, GIT_INDEX_FILE, cwd at the repository top) pins a nested project', () => {
  const ctx = nestedProject();
  const expected = treeDigest(ctx.project);
  const run = (env) =>
    spawnSync(process.execPath, [BIN, '--root', ctx.project, 'evidence', 'run', '--actor', 'backend-engineer', '--label', 'hook', '--json', '--', 'node -e "process.exit(0)"'], {
      cwd: ctx.repo,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  for (const env of [
    { GIT_DIR: '.git', GIT_INDEX_FILE: '.git/index' }, // what a pre-commit hook sees, relative to the top level
    { GIT_DIR: path.join(ctx.repo, '.git'), GIT_INDEX_FILE: path.join(ctx.repo, '.git', 'index') }, // the real .git, absolute
  ]) {
    const res = run(env);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /tree pinning/);
    assert.strictEqual(JSON.parse(res.stdout).tree, expected, JSON.stringify(env));
  }
});
