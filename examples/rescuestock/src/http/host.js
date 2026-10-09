// Host header allow-list (SEC-13): defends against DNS rebinding.
// Allowed: the host of RS_PUBLIC_URL, localhost:<port>, 127.0.0.1:<port>
// (the configured PORT and the port the request actually arrived on), and
// anything listed in RS_ALLOWED_HOSTS. Comparison is case-insensitive.

export function allowedHostValues({ publicUrl, configuredPort, localPort, extraHosts = [] }) {
  const allowed = new Set();
  if (publicUrl) {
    try {
      allowed.add(new URL(publicUrl).host.toLowerCase());
    } catch {
      // An unparsable public URL contributes nothing; config validation rejects it earlier.
    }
  }
  for (const port of [configuredPort, localPort]) {
    if (Number.isInteger(port) && port > 0) {
      allowed.add(`localhost:${port}`);
      allowed.add(`127.0.0.1:${port}`);
    }
  }
  for (const host of extraHosts) allowed.add(String(host).toLowerCase());
  return allowed;
}

export function hostAllowed(hostHeader, options) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0 || hostHeader.length > 255) return false;
  return allowedHostValues(options).has(hostHeader.toLowerCase());
}
