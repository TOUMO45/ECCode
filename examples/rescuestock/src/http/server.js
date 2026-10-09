// node:http server construction with the timeouts of the spec.
//   headersTimeout 10 s, requestTimeout 30 s, keepAliveTimeout 5 s.
// The 60 s allowance for uploads is exported as UPLOAD_REQUEST_TIMEOUT_MS; Node
// has one server-wide requestTimeout, so the upload route (not built here)
// must enforce its own deadline while it streams.
import { createServer } from 'node:http';

export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const UPLOAD_REQUEST_TIMEOUT_MS = 60_000;
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const MAX_HEADER_BYTES = 16 * 1024;

// Node checks the header and request timeouts only on this interval; its default of 30 s made the
// configured 10 s and 30 s limits fire at 30 s and 60 s (SEC-B-4).
export const CONNECTIONS_CHECK_INTERVAL_MS = 1_000;
export const MAX_CONNECTIONS = 512;

// The timeout options exist so tests can use short values; the application passes none.
export function createHttpServer(
  handler,
  { headersTimeout = HEADERS_TIMEOUT_MS, requestTimeout = REQUEST_TIMEOUT_MS, checkInterval = CONNECTIONS_CHECK_INTERVAL_MS } = {},
) {
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, connectionsCheckingInterval: checkInterval }, (req, res) => {
    // The handler turns every failure into a response; this is a last resort.
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end('{"error":{"code":"INTERNAL","message":"Something went wrong on the server."}}');
      } else {
        res.destroy();
      }
    });
  });
  server.headersTimeout = headersTimeout;
  server.requestTimeout = requestTimeout;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  server.on('clientError', (err, socket) => {
    if (socket.writable && !socket.destroyed) {
      let code = '400 Bad Request';
      if (err && err.code === 'HPE_HEADER_OVERFLOW') code = '431 Request Header Fields Too Large';
      else if (err && err.code === 'ERR_HTTP_REQUEST_TIMEOUT') code = '408 Request Timeout';
      socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } else {
      socket.destroy();
    }
  });
  return server;
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    // Give in-flight requests a moment, then drop what is left.
    const timer = setTimeout(() => server.closeAllConnections?.(), 2000);
    timer.unref();
  });
}
