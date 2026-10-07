'use strict';
// Entry point (spec NFR10, C6.5, D1.6): main() → buildApp → listen → signals. Nothing else lives here.
// Startup failures print one fixed-format line to stderr and exit 1. No line ever contains a configuration value,
// an error message or a stack (Security T6, T12): only the ConfigError message (which names the variable, never its
// value) or an error code/name.

const { buildApp } = require('./app.js');
const { ConfigError } = require('./config.js');
const { createLogger } = require('./log.js');

const FORCE_EXIT_MS = 2000;
const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;

function safeCode(err) {
  if (err && typeof err.code === 'string' && SAFE_CODE.test(err.code)) return err.code;
  if (err && typeof err.name === 'string' && SAFE_CODE.test(err.name)) return err.name;
  return 'Error';
}

function main() {
  const log = createLogger();

  let app;
  try {
    app = buildApp({ env: process.env, fetchImpl: globalThis.fetch, log });
  } catch (err) {
    if (err instanceof ConfigError) process.stderr.write(`config error: ${err.message}\n`);
    else process.stderr.write(`startup error: ${safeCode(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const { config, service, server } = app;

  server.once('error', (err) => {
    // Typically EADDRINUSE / EACCES on listen. Report the code only.
    process.stderr.write(`listen error: ${safeCode(err)}\n`);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    log.event('listening', {
      host: config.host,
      port: address && typeof address === 'object' ? address.port : config.port,
      mode: service.mode,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxTokens: config.maxTokens,
      baseUrlCustom: config.baseUrlCustom,
    });
    for (const code of config.warnings) log.event('warning', { code });
  });

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    // Forced exit if open connections keep the server from closing; unref so it never delays a clean exit.
    setTimeout(() => process.exit(1), FORCE_EXIT_MS).unref();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
