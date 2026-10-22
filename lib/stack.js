'use strict';
// Stack packs: detect the project's stacks from their manifests and turn the
// stack's own quality tools into runnable, recordable checks. The project's
// own scripts come first (a repo's `npm test` beats any guess); standard
// tools are offered only when they are actually available on this machine.
// `eccode stack adopt --actor user` makes chosen checks REQUIRED: the
// verification gate then refuses approval until the reviewer has recorded
// each one passing after the submission.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, exists, EccodeError } = require('./util');
const { listFiles, readText, TEST } = require('./lean');
const { SECRET_PATTERNS } = require('./evidence');

const availCache = new Map();
function available(probe) {
  if (!availCache.has(probe)) {
    const r = spawnSync('sh', ['-c', probe], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'ignore', 'ignore'] });
    availCache.set(probe, r.status === 0);
  }
  return availCache.get(probe);
}

/** Stacks present in this repository, with the manifest that proves each. */
function detect(root) {
  const has = (f) => exists(path.join(root, f));
  const pkg = has('package.json') ? readJson(path.join(root, 'package.json'), {}) : null;
  const stacks = [];
  if (pkg) stacks.push({ id: 'node', evidence: 'package.json', typescript: has('tsconfig.json'), scripts: Object.keys(pkg.scripts || {}) });
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    stacks.push({ id: 'python', evidence: ['pyproject.toml', 'requirements.txt', 'setup.py'].filter(has).join(', ') });
  }
  if (has('go.mod')) stacks.push({ id: 'go', evidence: 'go.mod' });
  if (has('Cargo.toml')) stacks.push({ id: 'rust', evidence: 'Cargo.toml' });
  if (has('pom.xml')) stacks.push({ id: 'java', evidence: 'pom.xml', tool: 'maven' });
  else if (has('build.gradle') || has('build.gradle.kts')) stacks.push({ id: 'java', evidence: 'build.gradle', tool: 'gradle' });
  if (has('Gemfile')) stacks.push({ id: 'ruby', evidence: 'Gemfile' });
  if (has('composer.json')) stacks.push({ id: 'php', evidence: 'composer.json' });
  if (has('Dockerfile') || has('docker-compose.yml')) stacks.push({ id: 'docker', evidence: 'Dockerfile' });
  return stacks;
}

function realScript(pkg, name) {
  const s = pkg && pkg.scripts && pkg.scripts[name];
  return s && !/no test specified/.test(s) ? s : null;
}

/**
 * The checks this repository supports right now. Each has a stable id, the
 * exact command, and whether the tool is available on this machine. Built-in
 * checks (id starting "eccode-") run through `… stack run <id>` of any eccode
 * invocation, so the required-check matcher recognizes them by id.
 */
function checks(root, config) {
  const out = [];
  const add = (c) => out.push({ source: 'standard', kind: 'test', available: true, ...c });
  const pkg = exists(path.join(root, 'package.json')) ? readJson(path.join(root, 'package.json'), {}) : null;
  for (const s of detect(root)) {
    if (s.id === 'node') {
      if (realScript(pkg, 'test')) add({ id: 'node-test', label: 'project test script', command: 'npm test', source: 'project-script' });
      if (realScript(pkg, 'lint')) add({ id: 'node-lint', label: 'project lint script', command: 'npm run lint', kind: 'lint', source: 'project-script' });
      if (realScript(pkg, 'typecheck')) add({ id: 'node-typecheck', label: 'project typecheck script', command: 'npm run typecheck', kind: 'type', source: 'project-script' });
      else if (s.typescript) add({ id: 'tsc', label: 'TypeScript typecheck', command: 'npx tsc --noEmit', kind: 'type', available: available('command -v npx') });
    }
    if (s.id === 'python') {
      add({ id: 'pytest', label: 'pytest', command: 'pytest -q', available: available('pytest --version') });
      add({ id: 'ruff', label: 'ruff lint', command: 'ruff check .', kind: 'lint', available: available('command -v ruff') });
      if (exists(path.join(root, 'mypy.ini')) || exists(path.join(root, 'setup.cfg'))) {
        add({ id: 'mypy', label: 'mypy typecheck', command: 'mypy .', kind: 'type', available: available('command -v mypy') });
      }
    }
    if (s.id === 'go') {
      add({ id: 'go-test', label: 'go test', command: 'go test ./...', available: available('command -v go') });
      add({ id: 'go-vet', label: 'go vet', command: 'go vet ./...', kind: 'lint', available: available('command -v go') });
      add({ id: 'gofmt', label: 'gofmt (no diffs)', command: 'test -z "$(gofmt -l .)"', kind: 'lint', available: available('command -v gofmt') });
    }
    if (s.id === 'rust') {
      add({ id: 'cargo-test', label: 'cargo test', command: 'cargo test --quiet', available: available('command -v cargo') });
      add({ id: 'clippy', label: 'cargo clippy', command: 'cargo clippy --quiet -- -D warnings', kind: 'lint', available: available('cargo clippy --version') });
      add({ id: 'cargo-fmt', label: 'cargo fmt --check', command: 'cargo fmt --check', kind: 'lint', available: available('cargo fmt --version') });
    }
    if (s.id === 'java') {
      add(s.tool === 'maven'
        ? { id: 'mvn-test', label: 'maven test', command: 'mvn -q test', available: available('command -v mvn') }
        : { id: 'gradle-test', label: 'gradle test', command: 'gradle test -q', available: available('command -v gradle') });
    }
    if (s.id === 'ruby' && exists(path.join(root, 'spec'))) {
      add({ id: 'rspec', label: 'rspec', command: 'bundle exec rspec', available: available('command -v bundle') });
    }
    if (s.id === 'php' && realScript(readJson(path.join(root, 'composer.json'), {}), 'test')) {
      add({ id: 'composer-test', label: 'composer test script', command: 'composer test', source: 'project-script', available: available('command -v composer') });
    }
  }
  // Universal checks, preferring external scanners when installed.
  add({ id: 'eccode-secrets', label: 'secrets scan (built in)', command: 'eccode stack run eccode-secrets', kind: 'secrets' });
  if (available('command -v gitleaks')) add({ id: 'gitleaks', label: 'gitleaks secrets scan', command: 'gitleaks git --no-banner --exit-code 1', kind: 'secrets' });
  if (available('command -v osv-scanner')) add({ id: 'osv', label: 'OSV dependency vulnerabilities', command: 'osv-scanner scan source -r .', kind: 'audit', networked: true });
  const required = new Set((config && config.stack && config.stack.required) || []);
  for (const c of out) c.required = required.has(c.id);
  return out;
}

/**
 * Built-in secrets scan. Only the high-confidence token shapes from
 * evidence.js (sk-ant-, AKIA, ghp_, xox…) plus private-key blocks: the
 * generic key=value heuristic stays in redact(), where over-matching is
 * safe, but would flood a source scan with false positives. Hits inside
 * test files are reported as warnings (fixtures hold fake keys), hits in
 * code fail the check. `eccode-allow-secret` on the line suppresses it.
 */
function scanSecrets(root) {
  const PATTERNS = [...SECRET_PATTERNS.filter((re) => !re.ignoreCase), /-----BEGIN [A-Z ]*PRIVATE KEY-----/g];
  const code = [];
  const tests = [];
  for (const f of listFiles(root)) {
    if (f.startsWith('.eccode/') || /\.(lock|min\.js|map|svg|png|jpg)$/.test(f)) continue;
    const text = readText(root, f);
    if (text === null) continue;
    text.split('\n').forEach((line, i) => {
      if (line.includes('eccode-allow-secret')) return;
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        if (re.test(line)) {
          (TEST.test(f) ? tests : code).push(`${f}:${i + 1}`);
          return;
        }
      }
    });
  }
  return { code, tests };
}

/** Run one check (or every available one). Built-ins run in-process. */
function runCheck(root, config, id) {
  const c = checks(root, config).find((x) => x.id === id);
  if (!c) throw new EccodeError('NOT_FOUND', `No check "${id}" for this repository. See: eccode stack`);
  if (c.id === 'eccode-secrets') {
    const { code, tests } = scanSecrets(root);
    const out = [
      code.length ? `Possible secrets in code (mark false positives with eccode-allow-secret):\n${code.join('\n')}` : 'No secrets found in code.',
      tests.length ? `Warnings: secret-shaped strings in test files (fine if they are fake fixtures):\n${tests.join('\n')}` : null,
    ].filter(Boolean).join('\n');
    return { id, exitCode: code.length ? 2 : 0, output: out };
  }
  if (!c.available) throw new EccodeError('TOOL_UNAVAILABLE', `Check "${id}" needs a tool that is not installed (${c.command})`);
  const r = spawnSync(c.command, { cwd: root, shell: true, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  return { id, exitCode: typeof r.status === 'number' ? r.status : 1, output: `${r.stdout || ''}${r.stderr || ''}`.slice(-4000) };
}

/** Does a recorded evidence command satisfy this check? Built-ins match by id. */
function evidenceMatches(check, command) {
  const norm = (s) => String(s).trim().replace(/\s+/g, ' ');
  if (check.id.startsWith('eccode-')) return new RegExp(`eccode(\\.js)?["']?\\s+stack\\s+run\\s+${check.id}(\\s|$)`).test(command);
  return norm(command) === norm(check.command) || norm(command).endsWith(` ${norm(check.command)}`);
}

/** Required-check verdicts for a verification approval. */
function requiredCheckProblems(state, config, root, reviewer, sinceTs) {
  const required = (config.stack && config.stack.required) || [];
  if (!required.length) return [];
  const all = checks(root, config);
  const problems = [];
  for (const id of required) {
    const check = all.find((c) => c.id === id);
    if (!check) {
      problems.push(`required stack check "${id}" does not exist for this repository anymore; the user should update stack.required (eccode stack adopt)`);
      continue;
    }
    const ok = Object.values(state.evidence).some(
      (e) => e.kind === 'command' && e.status === 'passed' && e.recordedBy === reviewer && e.at >= sinceTs && evidenceMatches(check, e.command),
    );
    if (!ok) {
      problems.push(`required stack check "${id}" has no passing run by ${reviewer} after the submission; run: eccode evidence run --actor ${reviewer} --label "${check.label}" -- ${JSON.stringify(check.command)}`);
    }
  }
  return problems;
}

/** Commands that run exactly the given test files, grouped by language. */
function testRunCommands(root, files) {
  const groups = { js: [], py: [], go: new Set() };
  for (const f of files) {
    if (/\.(test|spec)\.(js|mjs|cjs|ts|tsx|jsx)$|\.test\.ts$/.test(f) || /\.(js|mjs|cjs)$/.test(f)) groups.js.push(f);
    else if (/\.py$/.test(f)) groups.py.push(f);
    else if (/_test\.go$/.test(f)) groups.go.add('./' + path.posix.dirname(f));
  }
  const cmds = [];
  if (groups.js.length) cmds.push(`node --test ${groups.js.join(' ')}`);
  if (groups.py.length) cmds.push(`pytest -q ${groups.py.join(' ')}`);
  if (groups.go.size) cmds.push(`go test ${[...groups.go].join(' ')}`);
  return cmds;
}

/** Update config.stack.required in the user's config file (CLI enforces --actor user). */
function adopt(root, ids, { remove = false } = {}) {
  const { configPath, loadConfig } = require('./config');
  const file = configPath(root);
  const raw = readJson(file, {});
  const current = new Set((raw.stack && raw.stack.required) || []);
  const known = checks(root, loadConfig(root));
  for (const id of ids) {
    const check = known.find((c) => c.id === id);
    if (!remove && !check) throw new EccodeError('NOT_FOUND', `No check "${id}" for this repository. See: eccode stack`);
    if (!remove && !check.available) throw new EccodeError('TOOL_UNAVAILABLE', `Check "${id}" is not available on this machine; install its tool first (${check.command})`);
    if (remove) current.delete(id);
    else current.add(id);
  }
  raw.stack = { ...(raw.stack || {}), required: [...current].sort() };
  require('./util').writeJson(file, raw);
  return raw.stack.required;
}

module.exports = { detect, checks, runCheck, scanSecrets, evidenceMatches, requiredCheckProblems, testRunCommands, adopt };
