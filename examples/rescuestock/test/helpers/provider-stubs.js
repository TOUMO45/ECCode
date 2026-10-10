// Stubs for the ExtractionProvider contract suite (test/unit/ai/provider-contract.test.js): a stub `claude` binary that
// replays the recorded transcript (CLI adapter) and a loopback server that plays POST /v1/messages (Anthropic adapter).
// No model, no network beyond 127.0.0.1 and no key or login is involved.
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUB = fileURLToPath(new URL('../fixtures/extraction/stub-claude.mjs', import.meta.url));
const TRANSCRIPT = fileURLToPath(new URL('../fixtures/extraction/cli-transcript.ndjson', import.meta.url));

// The structured output of the recorded CLI transcript: the answer to CONTRACT_TEXT (RS-FIX-1 core values).
export const TRANSCRIPT_STRUCTURED = readFileSync(TRANSCRIPT, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .find((e) => e.type === 'result').structured_output;

// A marker that a stub puts into everything a real provider could return (error bodies, stderr, prose). The contract
// suite asserts that it never shows in a ProviderError (no provider body in errors or logs).
export const PROVIDER_BODY_MARKER = 'PROVIDER-BODY-MARKER-7f3a';

// ---- CLI: a temp dir holding a `claude` wrapper for one stub mode ---------------------------------------------------------

export function createCliStubRoot() {
  const root = mkdtempSync(join(tmpdir(), 'rs-contract-cli-'));
  let seq = 0;
  return {
    root,
    // mode: a stub-claude.mjs mode (transcript, hang, exit1, prose, slow, ...).
    sandbox(mode) {
      const dir = join(root, `case-${(seq += 1)}`);
      const bin = join(dir, 'bin');
      const tmp = join(dir, 'tmp');
      mkdirSync(bin, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${STUB}" ${mode} "$@"\n`, { mode: 0o755 });
      const env = {
        PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: dir, TMPDIR: tmp, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NODE_OPTIONS: '--no-warnings',
      };
      return { dir, tmp, env };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---- Anthropic: a loopback server with a queue of scripted replies ---------------------------------------------------------

export function okMessage(text = JSON.stringify(TRANSCRIPT_STRUCTURED), extra = {}) {
  return {
    id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn',
    content: [{ type: 'text', text }], usage: { input_tokens: 420, output_tokens: 180 }, ...extra,
  };
}

// start() -> { baseUrl, requests, queue(reply...), reset(), close() }. A reply is { status, json | raw, delayMs? }; an empty
// queue answers a valid extraction.
export async function startAnthropicStub() {
  const requests = [];
  const script = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, bytes: Buffer.concat(chunks).length });
      const reply = script.shift() ?? { status: 200, json: okMessage() };
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.raw ?? JSON.stringify(reply.json ?? {}));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs).unref();
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    queue: (...replies) => script.push(...replies),
    reset() {
      requests.length = 0;
      script.length = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
