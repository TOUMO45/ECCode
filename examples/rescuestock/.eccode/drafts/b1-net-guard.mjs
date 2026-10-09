// Scratch stand-in for test/helpers/net-guard.js (owned by b3): any non-loopback
// connection or DNS lookup throws NETWORK_BLOCKED and is recorded.
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '', undefined, null]);

function hostOf(args) {
  const first = args[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) return first.host ?? first.hostname;
  if (typeof first === 'number' || typeof first === 'string') return typeof args[1] === 'string' ? args[1] : undefined;
  return undefined;
}

function guard(host) {
  if (!LOOPBACK.has(host)) {
    process.stderr.write(`NETWORK_BLOCKED ${String(host)}\n`);
    throw Object.assign(new Error(`NETWORK_BLOCKED: ${String(host)}`), { code: 'NETWORK_BLOCKED' });
  }
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...args) {
  if (!(args[0] && typeof args[0] === 'object' && args[0].path)) guard(hostOf(args));
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function patched(host, ...rest) {
  guard(host);
  return lookup.call(this, host, ...rest);
};
tls.connect = () => {
  throw Object.assign(new Error('NETWORK_BLOCKED: tls'), { code: 'NETWORK_BLOCKED' });
};
const realFetch = globalThis.fetch;
globalThis.fetch = (input, ...rest) => {
  guard(new URL(typeof input === 'string' ? input : input.url).hostname);
  return realFetch(input, ...rest);
};
