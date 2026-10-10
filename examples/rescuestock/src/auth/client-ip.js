// Client IP used as a throttle key (SEC-1, SEC-9, SEC-B-9 / FU-11).
//
// Decision: X-Forwarded-For is NOT trusted by default. The spec's default deployment has no proxy,
// so the key is the socket address, which a client cannot choose. Only with RS_TRUST_PROXY=1 is the
// last X-Forwarded-For hop (the one the nearest trusted proxy appended) read, and it is accepted only
// when node:net says it is an IP address. Anything else (a name, a list fragment, markup, an overlong
// value) falls back to the socket address, so a forged header can never become a throttle key.
import net from 'node:net';

const MAX_HEADER_LENGTH = 512;
const UNKNOWN = 'unknown';

// Canonical text for one address: IPv4-mapped IPv6 collapses to IPv4, IPv6 is lower case.
export function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const kind = net.isIP(text);
  if (kind === 0) return null;
  if (kind === 4) return text;
  const lower = text.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped && net.isIP(mapped[1]) === 4) return mapped[1];
  return lower;
}

export function clientIp(req, trustProxy = false) {
  const socketIp = normalizeIp(req.socket?.remoteAddress) ?? UNKNOWN;
  if (!trustProxy) return socketIp;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length === 0 || forwarded.length > MAX_HEADER_LENGTH) return socketIp;
  const last = forwarded.split(',').pop();
  return normalizeIp(last) ?? socketIp;
}
