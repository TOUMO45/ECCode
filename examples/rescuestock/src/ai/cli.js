// Claude Code CLI adapter (`claude -p`), AI / LLM Design "CLI adapter" and Security T25.
//
//   * spawn without a shell, in its own process group, in a fresh empty temp cwd that is removed afterwards;
//   * pinned argv: no tools, safe mode, no settings, no MCP, no slash commands, no session persistence,
//     stream-json in and out (+ --verbose), a per-call budget cap and the wire schema;
//   * child environment built from scratch from an allow-list (PATH, HOME, CLAUDE_CONFIG_DIR, LANG, LC_ALL, TMPDIR):
//     no RS_* variable and never ANTHROPIC_API_KEY reach the child;
//   * stdin: one stream-json user line, then EOF; stdout: NDJSON, capped at 8 MiB (SEC-15); the last
//     `type:"result"` event is the answer; cost comes from total_cost_usd in integer micro-dollars (F-TR-12);
//   * timeout with a process-group SIGKILL; ONE attempt (no retry, which bounds cost); concurrency 2 per process.
//
// The stdin and result event shapes are verified against a recorded transcript in the unit tests and against the real
// CLI only by the opt-in live run (case cli-image-smoke).
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toMicroUsd } from './gate.js';
import { buildExtractionPrompt, SYSTEM_PROMPT } from './prompt.js';
import { DEFAULT_MODEL, ProviderError } from './provider.js';
import { EXTRACTION_WIRE_SCHEMA, parseAndValidate, validateExtraction } from './schema.js';

export const CLI_OUTPUT_CAP_BYTES = 8 * 1024 * 1024;
export const CLI_MAX_CONCURRENT = 2;
export const CLI_DEFAULT_TIMEOUT_MS = 30000;
export const CLI_ENV_ALLOW = Object.freeze(['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'LANG', 'LC_ALL', 'TMPDIR']);

// Wire schema of an opt-in rephrase call (ai/rephrase.js).
export const REPHRASE_WIRE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: Object.freeze({ text: Object.freeze({ type: 'string' }) }),
});

// 50000 -> "0.05"; 1000000 -> "1.00": integer micro-dollars rendered as a decimal string without floating point.
export function formatMicroUsd(micro) {
  if (!Number.isSafeInteger(micro) || micro < 0) throw new RangeError('micro-dollar amount must be a non-negative integer');
  const whole = Math.floor(micro / 1_000_000);
  const frac = String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${frac}`;
}

/** The exact pinned argv. `--tools` and `--setting-sources` are each followed by an empty-string argument. */
export function buildArgv({ model, callCapMicroUsd, schema = EXTRACTION_WIRE_SCHEMA, systemPrompt = SYSTEM_PROMPT }) {
  if (typeof model !== 'string' || model === '') throw new TypeError('model is required');
  return [
    '-p',
    '--model', model,
    '--tools', '',
    '--safe-mode',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', formatMicroUsd(callCapMicroUsd),
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', systemPrompt,
  ];
}

/** Child environment from an allow-list; RS_* names and ANTHROPIC_API_KEY are never copied. */
export function buildChildEnv(source = process.env) {
  const out = {};
  for (const name of CLI_ENV_ALLOW) if (typeof source[name] === 'string') out[name] = source[name];
  return out;
}

/** The one stdin line: {"type":"user","message":{"role":"user","content":[...]}} + newline. */
export function buildStdinLine(content) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function usageOf(result, model, startedMs, nowMs) {
  const u = result?.usage ?? {};
  let costMicroUsd = 0;
  try {
    costMicroUsd = typeof result?.total_cost_usd === 'number' ? toMicroUsd(result.total_cost_usd) : 0;
  } catch {
    costMicroUsd = 0;
  }
  return {
    model: Object.keys(result?.modelUsage ?? {})[0] ?? model,
    costUsd: costMicroUsd / 1_000_000,
    costMicroUsd,
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
    latencyMs: Math.max(0, nowMs - startedMs),
  };
}

/** Last `type:"result"` event of an NDJSON stream; lines that are not JSON objects are ignored. */
export function lastResultEvent(stdout) {
  let result = null;
  for (const line of String(stdout).split('\n')) {
    const text = line.trim();
    if (text === '' || text[0] !== '{') continue;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (event && typeof event === 'object' && event.type === 'result') result = event;
  }
  return result;
}

function runOnce({ command, argv, env, stdin, timeoutMs, capBytes, signal, tmpRoot }) {
  return new Promise((resolve, reject) => {
    let cwd = null;
    let child = null;
    let settled = false;
    let size = 0;
    const chunks = [];
    let timer = null;

    // The temp cwd is removed BEFORE the promise settles, so nothing is left behind once extract() returns.
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      return cwd ? rm(cwd, { recursive: true, force: true }).catch(() => {}) : Promise.resolve();
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup().then(() => fn(value));
    };
    const fail = (code, usageHint) => {
      if (child) killGroup(child);
      finish(reject, new ProviderError(code, usageHint ? { usage: usageHint } : {}));
    };
    const onAbort = () => fail('PROVIDER_TIMEOUT');

    mkdtemp(join(tmpRoot, 'rs-cli-')).then((dir) => {
      cwd = dir;
      if (signal?.aborted) {
        fail('PROVIDER_TIMEOUT');
        return;
      }
      try {
        child = spawn(command, argv, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch {
        fail('PROVIDER_UNAVAILABLE');
        return;
      }
      timer = setTimeout(() => fail('PROVIDER_TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', () => finish(reject, new ProviderError('PROVIDER_UNAVAILABLE')));
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > capBytes) {
          fail('PROVIDER_BAD_OUTPUT');
          return;
        }
        chunks.push(chunk);
      });
      child.stdin.on('error', () => {}); // EPIPE when the child exits before reading everything
      child.on('close', (code) => finish(resolve, { code, stdout: Buffer.concat(chunks).toString('utf8') }));
      child.stdin.end(stdin);
    }, () => finish(reject, new ProviderError('PROVIDER_UNAVAILABLE')));
  });
}

/**
 * createCliProvider({ model, timeoutMs, callCapMicroUsd, command, env, tmpRoot, clock, outputCapBytes, maxConcurrent })
 *   callCapMicroUsd  RS_MODEL_CALL_CAP_USD in integer micro-dollars (becomes --max-budget-usd)
 *   env              source for the allow-listed child environment (default process.env)
 * extract() resolves { output, usage, meta: { schemaAccepted } } where schemaAccepted is true only when the CLI returned
 * a structured_output object (F-TR-13); it rejects ProviderError PROVIDER_TIMEOUT | PROVIDER_UNAVAILABLE |
 * PROVIDER_BAD_OUTPUT | PROVIDER_BUSY, with the billed usage attached when the CLI reported one.
 */
export function createCliProvider({
  model = DEFAULT_MODEL,
  timeoutMs = CLI_DEFAULT_TIMEOUT_MS,
  callCapMicroUsd = 50_000,
  command = 'claude',
  env = process.env,
  tmpRoot = tmpdir(),
  clock = { now: () => Date.now() },
  outputCapBytes = CLI_OUTPUT_CAP_BYTES,
  maxConcurrent = CLI_MAX_CONCURRENT,
} = {}) {
  let active = 0;

  async function call({ system, content, schema, interpret, signal }) {
    if (active >= maxConcurrent) throw new ProviderError('PROVIDER_BUSY');
    active += 1;
    const started = clock.now();
    try {
      const argv = buildArgv({ model, callCapMicroUsd, schema, systemPrompt: system });
      let run;
      try {
        run = await runOnce({
          command, argv, env: buildChildEnv(env), stdin: buildStdinLine(content), timeoutMs, capBytes: outputCapBytes, signal, tmpRoot,
        });
      } catch (err) {
        throw err instanceof ProviderError ? err : new ProviderError('PROVIDER_UNAVAILABLE');
      }
      const result = lastResultEvent(run.stdout);
      if (result === null) throw new ProviderError(run.code === 0 ? 'PROVIDER_BAD_OUTPUT' : 'PROVIDER_UNAVAILABLE');
      const usage = usageOf(result, model, started, clock.now());
      if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success')) {
        throw new ProviderError('PROVIDER_UNAVAILABLE', { usage });
      }
      const interpreted = interpret(result);
      if (!interpreted.ok) throw new ProviderError('PROVIDER_BAD_OUTPUT', { usage });
      return { output: interpreted.value, usage, meta: { schemaAccepted: interpreted.schemaAccepted } };
    } finally {
      active -= 1;
    }
  }

  // structured_output first (object, or a JSON string); the `result` text is the fallback
  function pickPayload(result) {
    const structured = result.structured_output;
    if (structured !== undefined && structured !== null) return { candidate: structured, schemaAccepted: typeof structured === 'object' };
    return { candidate: typeof result.result === 'string' ? result.result : null, schemaAccepted: false };
  }

  async function extract({ text, image = null, signal } = {}) {
    const prompt = buildExtractionPrompt({ text, image });
    return call({
      system: prompt.system,
      content: prompt.content,
      schema: EXTRACTION_WIRE_SCHEMA,
      signal,
      interpret(result) {
        const { candidate, schemaAccepted } = pickPayload(result);
        if (candidate === null) return { ok: false };
        const checked = typeof candidate === 'string' ? parseAndValidate(candidate) : validateExtraction(candidate);
        return checked.ok ? { ok: true, value: checked.value, schemaAccepted } : { ok: false };
      },
    });
  }

  async function rephrase({ system, content, signal } = {}) {
    if (!Array.isArray(content)) throw new TypeError('rephrase needs the prompt content');
    return call({
      system,
      content,
      schema: REPHRASE_WIRE_SCHEMA,
      signal,
      interpret(result) {
        const { candidate, schemaAccepted } = pickPayload(result);
        let value = candidate;
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value);
          } catch {
            return { ok: false };
          }
        }
        const good = value !== null && typeof value === 'object' && !Array.isArray(value) &&
          Object.keys(value).length === 1 && typeof value.text === 'string';
        return good ? { ok: true, value: { text: value.text }, schemaAccepted } : { ok: false };
      },
    });
  }

  return Object.freeze({ id: 'cli', simulated: false, model, extract, rephrase });
}

/** `claude --version` -> "2.1.296" or null. No model call. */
export function cliVersion({ command = 'claude', env = process.env, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(command, ['--version'], { env: buildChildEnv(env), shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length < 200) out += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? (out.trim().split(/\s+/)[0] || null) : null);
    });
  });
}
