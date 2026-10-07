'use strict';
// Composition root (spec C6.5, NFR9, E1). The only module that requires every other module and wires them.
// It reads configuration only through loadConfig(env); the live provider exists only when config.apiKey is set.

const { loadConfig } = require('./config.js');
const { createLogger } = require('./log.js');
const { createServer } = require('./http-server.js');
const { createTriageService } = require('./triage/service.js');
const { createAnthropicProvider } = require('./triage/anthropic-provider.js');
const { detectInjection } = require('./triage/injection.js');
const { fallbackAnalyse } = require('./triage/fallback-provider.js');
const { redact } = require('./triage/redact.js');

/**
 * @param {{env?:Record<string,string|undefined>, fetchImpl?:Function, log?:ReturnType<typeof createLogger>}} [opts]
 *   Tests always pass an explicit env object; only server.js relies on the process.env default.
 * @returns {{config:import('./config.js').Config, service:ReturnType<typeof createTriageService>, server:import('node:http').Server}}
 *   The server is NOT listening.
 * @throws {import('./config.js').ConfigError} when env is invalid (the message never contains a value).
 */
function buildApp({ env = process.env, fetchImpl = globalThis.fetch, log = createLogger() } = {}) {
  const config = loadConfig(env);

  let service;
  if (config.apiKey === null) {
    // Fallback mode: exactly the eval runner's wiring (E1), so the HTTP path and the eval share one composition.
    service = createTriageService({ provider: null, detectInjection, fallbackAnalyse, redact });
  } else {
    const provider = createAnthropicProvider({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxTokens: config.maxTokens,
      fetchImpl,
    });
    service = createTriageService({ provider, detectInjection, fallbackAnalyse, redact });
  }

  const server = createServer({ config, service, log });
  return { config, service, server };
}

module.exports = { buildApp };
