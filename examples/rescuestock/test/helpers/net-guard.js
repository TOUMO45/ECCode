// Offline network guard (NFR1, NFR3). Loaded with `node --import ./test/helpers/net-guard.js`
// (npm test does this) and by node-proc.js for every spawned process.
//
// It patches net.connect, net.Socket.prototype.connect, tls.connect, dns.lookup
// (callback and promise forms) and globalThis.fetch. A target whose host is not
// loopback throws an Error with code NETWORK_BLOCKED. Unix socket paths and
// connections made over an existing socket do not leave the machine and pass.
//
// "Fails the test": the error is thrown at the call site, and every blocked
// attempt is also recorded. A process that recorded an attempt nobody took
// with takeBlocked() exits non-zero even if the code under test swallowed the
// error, so a hidden network call cannot pass quietly.
//
// Importing this module twice, or loading it with --import and again from a
// test, installs the guard once (state lives on a global symbol).
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

export const NETWORK_BLOCKED = 'NETWORK_BLOCKED';

const STATE_KEY = Symbol.for('rescuestock.netGuard');

// 127.0.0.0/8, ::1 and the IPv4-mapped form of the first, plus localhost names.
export function isLoopbackHost(host) {
  if (host === undefined || host === null || host === '') return true; // Node connects to localhost
  if (typeof host !== 'string') return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = net.isIP(h);
  if (kind === 4) return h.startsWith('127.');
  if (kind === 6) {
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return mapped !== null && mapped[1].startsWith('127.');
  }
  return false;
}

function installOnce() {
  if (globalThis[STATE_KEY]) return globalThis[STATE_KEY];

  const state = { blocked: [], originals: {} };
  globalThis[STATE_KEY] = state;

  function block(api, host) {
    const entry = { api, host: host === undefined ? '' : String(host) };
    state.blocked.push(entry);
    const err = new Error(`${NETWORK_BLOCKED}: ${api} to non-loopback host "${entry.host}" is not allowed in tests`);
    err.code = NETWORK_BLOCKED;
    err.host = entry.host;
    if (!state.quiet) process.stderr.write(`${NETWORK_BLOCKED} ${api} ${entry.host}\n`);
    throw err;
  }

  function check(api, host) {
    if (!isLoopbackHost(host)) block(api, host);
  }

  // Target host of net.connect / Socket#connect / tls.connect style arguments:
  // (options[, cb]), (port[, host][, cb]) or (path[, cb]). Returns undefined for
  // targets that never leave the machine (unix path, existing socket).
  function targetHost(args) {
    const first = args[0];
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      if (first.path || first.socket) return undefined;
      return first.host ?? first.hostname;
    }
    if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      return typeof args[1] === 'string' ? args[1] : undefined;
    }
    return undefined; // a path string
  }

  const origNetConnect = net.connect;
  const origSocketConnect = net.Socket.prototype.connect;
  const origTlsConnect = tls.connect;
  const origLookup = dns.lookup;
  const origPromisesLookup = dns.promises.lookup;
  const origFetch = globalThis.fetch;
  state.originals = { origNetConnect, origSocketConnect, origTlsConnect, origLookup, origPromisesLookup, origFetch };

  net.connect = function guardedConnect(...args) {
    check('net.connect', targetHost(args));
    return origNetConnect.apply(this, args);
  };
  net.createConnection = net.connect;

  net.Socket.prototype.connect = function guardedSocketConnect(...args) {
    // Socket#connect receives a normalized array [options, cb] when called internally.
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    check('net.Socket.prototype.connect', targetHost(normalized));
    return origSocketConnect.apply(this, args);
  };

  tls.connect = function guardedTlsConnect(...args) {
    check('tls.connect', targetHost(args));
    return origTlsConnect.apply(this, args);
  };

  dns.lookup = function guardedLookup(hostname, ...rest) {
    check('dns.lookup', hostname);
    return origLookup.call(this, hostname, ...rest);
  };
  dns.promises.lookup = function guardedPromisesLookup(hostname, ...rest) {
    check('dns.promises.lookup', hostname);
    return origPromisesLookup.call(this, hostname, ...rest);
  };

  if (typeof origFetch === 'function') {
    globalThis.fetch = async function guardedFetch(input, init) {
      let url;
      try {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
        url = new URL(raw);
      } catch {
        url = null; // a malformed URL: let fetch reject it with its own TypeError
      }
      if (url && (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:')) {
        check('fetch', url.hostname);
      }
      return origFetch.call(globalThis, input, init);
    };
  }

  process.on('exit', (code) => {
    if (state.blocked.length > 0 && code === 0 && !process.exitCode) {
      process.stderr.write(`${NETWORK_BLOCKED}: ${state.blocked.length} blocked attempt(s) were not acknowledged; failing the process\n`);
      process.exitCode = 1;
    }
  });

  return state;
}

const guardState = installOnce();

// Blocked attempts recorded and not yet taken.
export function blockedAttempts() {
  return guardState.blocked.map((entry) => ({ ...entry }));
}

// Returns the recorded attempts and forgets them. A test that blocks on purpose
// (the self-test) takes the attempts it caused; anything else fails the process.
export function takeBlocked() {
  return guardState.blocked.splice(0, guardState.blocked.length);
}

// The self-test blocks on purpose; it silences the per-attempt stderr line (the record stays).
export function setQuiet(quiet) {
  guardState.quiet = Boolean(quiet);
}

export function guardInstalled() {
  return globalThis[STATE_KEY] === guardState;
}
