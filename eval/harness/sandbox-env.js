'use strict';
// Environment and launch helpers for sandboxed trial sessions.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SANDBOX = path.join(__dirname, 'sandbox.sh');
const SBX = '/mnt/sbx';
const CA_COPY = '/etc/ssl/eccode-eval/ca-bundle.crt';

// Never handed to a trial: credentials of the operator's environment, and
// variables that would tie the child to the operator's own session.
const SECRET = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i;
const DROP = new Set([
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_USER_EMAIL', 'CLAUDE_CODE_SYNC_PLUGINS', 'CLAUDE_CODE_SYNC_SKILLS',
  'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'CLAUDE_ADDITIONAL_DIRECTORIES', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_SYNC_SESSION_REFS',
  'CLAUDE_CODE_DIAGNOSTICS_FILE', 'CLAUDE_CODE_TEE_SDK_STDOUT', 'CLAUDE_PID', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION',
  'ECCODE_LEARNING', 'ECCODE_SHARED_MEMORY', 'ECCODE_ACTOR', 'ECCODE_ROOT', 'OLDPWD', 'PWD',
]);
const CA_VARS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'NIX_SSL_CERT_FILE', 'CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE', 'PIP_CERT', 'DENO_CERT', 'HEX_CACERTS_PATH', 'HTTPLIB2_CA_CERTS', 'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE'];

function ensureCaCopy() {
  if (fs.existsSync(CA_COPY)) return;
  const src = process.env.SSL_CERT_FILE || process.env.NODE_EXTRA_CA_CERTS;
  fs.mkdirSync(path.dirname(CA_COPY), { recursive: true });
  if (src && fs.existsSync(src)) fs.copyFileSync(src, CA_COPY);
}

/** Curated environment as seen INSIDE the sandbox (paths are sandbox paths). */
function trialEnv(cond) {
  ensureCaCopy();
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (DROP.has(k)) continue;
    if (SECRET.test(k) && k !== 'CLAUDE_SESSION_INGRESS_TOKEN_FILE') continue;
    env[k] = v;
  }
  for (const k of CA_VARS) if (env[k]) env[k] = CA_COPY;
  Object.assign(env, {
    HOME: `${SBX}/state/home`,
    // The default location (~/.claude under the per-condition HOME): ECC's /learn writes global skills to
    // ~/.claude/skills, which later sessions of the same condition must be able to load.
    CLAUDE_CONFIG_DIR: `${SBX}/state/home/.claude`,
    CLAUDE_SESSION_INGRESS_TOKEN_FILE: `${SBX}/state/.ingress_token`,
    IS_SANDBOX: '1',
    TMPDIR: '/tmp',
    GIT_AUTHOR_NAME: 'acme-dev',
    GIT_AUTHOR_EMAIL: 'dev@acme.test',
    GIT_COMMITTER_NAME: 'acme-dev',
    GIT_COMMITTER_EMAIL: 'dev@acme.test',
  });
  if (cond !== 'C0') {
    env.PATH = `${SBX}/state/bin:${env.PATH}`;
    env.ECCODE_SHARED_MEMORY = `${SBX}/state/eccode-shared`;
    env.ECCODE_LEARNING = cond === 'C1' ? 'off' : 'on';
    env.ECCODE_UNATTENDED = '1'; // nobody answers: the Stop hook keeps the workflow from being skipped
  }
  return env;
}

/** Prepare a host state dir for a condition: home, config, CLI wrapper, fresh session token. */
function prepareState(cond, state) {
  for (const d of ['home/.claude', 'bin', 'eccode-shared']) fs.mkdirSync(path.join(state, d), { recursive: true });
  if (cond !== 'C0') fs.writeFileSync(path.join(state, 'bin', 'eccode'), `#!/bin/sh\nexec node "${SBX}/toolkit/bin/eccode.js" "$@"\n`, { mode: 0o755 });
  // Refresh the session token atomically: parallel sessions of one condition
  // share the state dir, so it is never deleted between sessions (only when
  // a whole run ends, via dropToken).
  const tokenFile = process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE;
  if (tokenFile && fs.existsSync(tokenFile)) {
    const tmp = path.join(state, `.ingress_token.${process.pid}.${Date.now()}`);
    fs.copyFileSync(tokenFile, tmp);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, path.join(state, '.ingress_token'));
  }
}

function dropToken(state) {
  fs.rmSync(path.join(state, '.ingress_token'), { force: true });
}

/** Spawn a command inside the sandbox (async, detached process group). */
function spawnInSandbox({ work, state, toolkit, extra = '-', env, cmd, args, stdout, stderr }) {
  return spawn(SANDBOX, [work, state, toolkit, extra, '--', cmd, ...args], { env, stdio: ['ignore', stdout, stderr], detached: true });
}

function runInSandboxSync({ work, state, toolkit, extra = '-', env, cmd, args, timeoutMs = 180000 }) {
  return spawnSync(SANDBOX, [work, state, toolkit, extra, '--', cmd, ...args], { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}

module.exports = { SBX, trialEnv, prepareState, dropToken, spawnInSandbox, runInSandboxSync };
