// Client IP used as a throttle key (SEC-1, SEC-9, SEC-B-9 / FU-11, SEC-C-2).
//
// An IPv6 client is keyed by its /64 prefix, not its full address (SEC-C-2); IPv4 and IPv4-mapped
// addresses keep their IPv4 key. See throttleKey().
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

// The eight 16-bit groups of a normalised IPv6 address (net.isIP === 6), or null.
function ipv6Groups(text) {
  let address = text;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    address = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

// The throttle key of one client (SEC-C-2): an IPv4 address as it is; an IPv6 address as its /64 prefix
// ("2001:db8:1:1::/64"), because one subscriber normally holds a whole /64 and every address in it would
// otherwise be a fresh budget. An IPv4-mapped IPv6 address (dotted or hex form) is its IPv4 address.
export function throttleKey(value) {
  const address = normalizeIp(value);
  if (address === null || net.isIP(address) !== 6) return address;
  const groups = ipv6Groups(address);
  if (groups === null) return address;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

export function clientIp(req, trustProxy = false) {
  const socketIp = throttleKey(req.socket?.remoteAddress) ?? UNKNOWN;
  if (!trustProxy) return socketIp;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length === 0 || forwarded.length > MAX_HEADER_LENGTH) return socketIp;
  const last = forwarded.split(',').pop();
  return throttleKey(last) ?? socketIp;
}
