// Environment parsing with documented defaults (spec section 12).
// loadConfig(env) is pure so tests can inject an environment.

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function int(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const v = Number(raw);
  if (v < min || v > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return v;
}

function num(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max}`);
  }
  return v;
}

function flag(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (raw === '1') return true;
  if (raw === '0') return false;
  throw new ConfigError(`${name} must be 0 or 1`);
}

function str(env, name, def) {
  const raw = env[name];
  return raw === undefined || raw === '' ? def : raw;
}

export function loadConfig(env = process.env) {
  const log = str(env, 'GW_LOG', 'json');
  if (!['json', 'off'].includes(log)) throw new ConfigError('GW_LOG must be json or off');
  return Object.freeze({
    port: int(env, 'PORT', 3000, 0, 65535),
    host: str(env, 'HOST', '127.0.0.1'),
    dbPath: str(env, 'GW_DB_PATH', './data/groundwork.db'),
    cookieSecure: flag(env, 'GW_COOKIE_SECURE', false),
    log,
    enableFake: flag(env, 'GW_ENABLE_FAKE', false),
    cli: Object.freeze({
      model: str(env, 'GW_CLI_MODEL', 'haiku'),
      maxBudgetUsd: num(env, 'GW_CLI_MAX_BUDGET_USD', 0.1, 0.001, 100),
      timeoutMs: int(env, 'GW_CLI_TIMEOUT_MS', 90000, 100, 600000),
      bin: str(env, 'GW_CLAUDE_BIN', 'claude'),
      envPass: Object.freeze(
        str(env, 'GW_CLI_ENV_PASS', '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)),
      ),
    }),
    anthropic: Object.freeze({
      apiKey: str(env, 'ANTHROPIC_API_KEY', ''),
      model: str(env, 'GW_ANTHROPIC_MODEL', 'claude-haiku-5-5'),
      url: str(env, 'GW_ANTHROPIC_URL', 'https://api.anthropic.com'),
    }),
    seedPassword: str(env, 'GW_SEED_PASSWORD', ''),
  });
}
