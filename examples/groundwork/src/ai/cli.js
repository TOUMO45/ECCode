// Claude Code CLI provider (`claude -p`), spec section 1 and 4.
// No shell, no tools, fixed system prompt, notes on stdin as a data block,
// scrubbed environment, fresh empty cwd removed afterwards.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRAFT_JSON_SCHEMA, validateDraft, parseJsonText } from './schema.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { ProviderError, safeNumber, logCall } from './provider.js';

/** The only tool the CLI may expose: the synthetic structured-output tool added by --json-schema. */
export const ALLOWED_TOOLS = Object.freeze(['StructuredOutput']);

export const CLI_DEFAULTS = Object.freeze({
  maxStdoutBytes: 1024 * 1024,
  deadlineMs: 150000,
  maxConcurrent: 2,
  busyWaitMs: 5000,
  maxAttempts: 2,
});

const BASE_ENV = ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'LANG', 'LC_ALL', 'TMPDIR'];

/** Exact pinned argv (no shell). `--tools` is followed by an empty-string argument. */
export function buildArgv({ model, maxBudgetUsd }) {
  return [
    '-p',
    '--model', String(model),
    '--tools', '',
    '--safe-mode',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format', 'json',
    '--max-budget-usd', String(maxBudgetUsd),
    '--json-schema', JSON.stringify(DRAFT_JSON_SCHEMA),
    '--system-prompt', SYSTEM_PROMPT,
  ];
}

/** Child environment built from scratch: base allowlist plus names in envPass. Never the API key. */
export function buildEnv(envPass = [], source = process.env) {
  const out = {};
  for (const k of [...BASE_ENV, ...envPass]) {
    if (k === 'ANTHROPIC_API_KEY') continue;
    if (typeof source[k] === 'string') out[k] = source[k];
  }
  return out;
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiters = [];
  }

  acquire(waitMs) {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = { resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new ProviderError('PROVIDER_BUSY', 'semaphore'));
      }, waitMs);
      this.waiters.push(w);
    });
  }

  release() {
    const w = this.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(); // slot handed over; active unchanged
    } else {
      this.active -= 1;
    }
  }
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Runs one CLI invocation. Resolves { stdout } or rejects ProviderError. Cleans its cwd. */
async function runOnce({ bin, argv, env, input, timeoutMs, maxStdoutBytes, signal, onCwd }) {
  let cwd;
  try {
    cwd = await mkdtemp(join(tmpdir(), 'gw-cli-'));
    if (onCwd) onCwd(cwd);
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new ProviderError('PROVIDER_UNAVAILABLE', 'aborted'));
      let child;
      try {
        child = spawn(bin, argv, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch {
        return reject(new ProviderError('PROVIDER_UNAVAILABLE', 'spawn'));
      }
      let size = 0;
      const chunks = [];
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(v);
      };
      const fail = (code, reason) => {
        killGroup(child);
        finish(reject, new ProviderError(code, reason));
      };
      const timer = setTimeout(() => fail('PROVIDER_TIMEOUT', 'timeout'), timeoutMs);
      const onAbort = () => fail('PROVIDER_UNAVAILABLE', 'aborted');
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (e) => finish(reject, new ProviderError('PROVIDER_UNAVAILABLE', e?.code === 'ENOENT' ? 'ENOENT' : 'spawn')));
      child.stdout.on('data', (c) => {
        size += c.length;
        if (size > maxStdoutBytes) return fail('PROVIDER_UNAVAILABLE', 'stdout-cap');
        chunks.push(c);
      });
      child.stdin.on('error', () => {}); // EPIPE when the child exits early
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) return finish(reject, new ProviderError('PROVIDER_UNAVAILABLE', `exit-${code}`));
        finish(resolve, Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.end(input);
    });
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/** Interprets the CLI's `--output-format json` result object. Throws ProviderError. */
export function parseCliResult(stdout) {
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    throw new ProviderError('PROVIDER_BAD_OUTPUT', 'cli-json');
  }
  if (Array.isArray(r)) r = r.findLast((e) => e?.type === 'result'); // tolerate event-array form
  if (!r || typeof r !== 'object') throw new ProviderError('PROVIDER_BAD_OUTPUT', 'cli-shape');
  // num_turns / stop_reason are informational only (tool_use after StructuredOutput is normal).
  if (r.is_error === true || (typeof r.subtype === 'string' && r.subtype !== 'success')) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', `cli-${String(r.subtype ?? 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)}`);
  }
  const usage = {
    model: Object.keys(r.modelUsage ?? {})[0] ?? '',
    inputTokens: safeNumber(r.usage?.input_tokens),
    outputTokens: safeNumber(r.usage?.output_tokens),
    costUsd: safeNumber(r.total_cost_usd),
  };
  let candidate = r.structured_output;
  let v = candidate === undefined || candidate === null ? { ok: false } : validateDraft(candidate);
  if (!v.ok && typeof r.result === 'string') v = validateDraft(parseJsonText(r.result));
  if (!v.ok) throw Object.assign(new ProviderError('PROVIDER_BAD_OUTPUT', 'schema'), { usage });
  return { draft: v.draft, usage };
}

/**
 * @param {{config:{cli:{model:string,maxBudgetUsd:number,timeoutMs:number,bin:string,envPass:string[]}}, env?:object, log?:Function,
 *          maxStdoutBytes?:number, deadlineMs?:number, maxConcurrent?:number, busyWaitMs?:number, onCwd?:Function}} opts
 */
export function createCliProvider({ config, env = process.env, log, ...over }) {
  const c = config.cli;
  const o = { ...CLI_DEFAULTS, ...over };
  const sem = new Semaphore(o.maxConcurrent);
  let versionCache;

  async function version() {
    if (versionCache !== undefined) return versionCache;
    versionCache = await new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn(c.bin, ['--version'], { env: buildEnv(c.envPass, env), shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return resolve(null);
      }
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 5000);
      child.stdout.on('data', (d) => { if (out.length < 200) out += d; });
      child.on('error', () => { clearTimeout(t); resolve(null); });
      child.on('close', (code) => { clearTimeout(t); resolve(code === 0 ? (out.trim().split(/\s+/)[0] || null) : null); });
    });
    return versionCache;
  }

  return {
    id: 'cli',
    isFallback: false,
    version,
    async available() {
      return (await version()) !== null;
    },
    async generate({ incident, lines, signal }) {
      const started = Date.now();
      await sem.acquire(o.busyWaitMs);
      const total = { model: c.model, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      let attempts = 0;
      let lastErr;
      try {
        const argv = buildArgv({ model: c.model, maxBudgetUsd: c.maxBudgetUsd });
        const childEnv = buildEnv(c.envPass, env);
        while (attempts < o.maxAttempts) {
          const remaining = o.deadlineMs - (Date.now() - started);
          if (attempts > 0 && remaining < 1000) break;
          attempts += 1;
          try {
            const stdout = await runOnce({
              bin: c.bin, argv, env: childEnv, input: buildUserMessage({ incident, lines }),
              timeoutMs: Math.max(1, Math.min(c.timeoutMs, remaining)), maxStdoutBytes: o.maxStdoutBytes, signal, onCwd: o.onCwd,
            });
            const parsed = parseCliResult(stdout);
            addUsage(total, parsed.usage);
            const usage = { ...total, durationMs: Date.now() - started, attempts };
            logCall(log, { provider: 'cli', ok: true, ...usage });
            return { draft: parsed.draft, usage };
          } catch (e) {
            if (!(e instanceof ProviderError)) throw e;
            if (e.usage) addUsage(total, e.usage);
            lastErr = e;
            if (e.code !== 'PROVIDER_BAD_OUTPUT') break; // retry only malformed output, never after timeout/outage
          }
        }
        throw lastErr ?? new ProviderError('PROVIDER_UNAVAILABLE', 'deadline');
      } catch (e) {
        logCall(log, { provider: 'cli', ok: false, code: e.code ?? 'ERROR', reason: e.reason ?? '', attempts, durationMs: Date.now() - started, costUsd: total.costUsd });
        throw e instanceof ProviderError ? e : new ProviderError('PROVIDER_UNAVAILABLE', 'internal');
      } finally {
        sem.release();
      }
    },
  };
}

function addUsage(total, u) {
  if (u.model) total.model = u.model;
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.costUsd += u.costUsd;
}
