'use strict';
// P0 of S2.4: the read-only usage reader (lib/greenfield/usage.js) over the harness's transcript layout, with a synthetic
// transcript that mirrors the fields measured on 2026-11-08 (docs/build/gf-s2-4-evidence.md): assistant lines with
// message.usage and message.model, a streamed message repeated on two lines with one id, a cost-state line, a torn line.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const usage = require('../lib/greenfield/usage');

const line = (o) => `${JSON.stringify(o)}\n`;
const assistant = (id, model, u, extra = {}) => line({ type: 'assistant', uuid: `u-${id}-${Math.random()}`, timestamp: '2026-11-08T16:00:00.000Z', isSidechain: false, message: { id, model, role: 'assistant', usage: u }, ...extra });
const U = (input, cw, cr, out) => ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out, output_tokens_details: { thinking_tokens: 1 } });

/** A fake home with one project's transcripts: the session file and, optionally, subagent files. */
function home(root, sessionId, { agents = 0 } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-usage-'));
  const dir = usage.transcriptDir(root, h);
  fs.mkdirSync(dir, { recursive: true });
  const text = line({ type: 'mode', mode: 'auto' })
    + assistant('m1', 'claude-fable-5-1', U(2, 43408, 66539, 372))
    + assistant('m2', 'claude-fable-5-1', U(2, 3441, 445492, 4671))
    + assistant('m2', 'claude-fable-5-1', U(2, 3441, 445492, 4671)) // the same message, streamed on a second line
    + assistant('m3', 'claude-haiku-5-5', U(10, 0, 0, 20))
    + '{"type":"assistant","message":{"id":"torn"' + '\n' // a torn line
    + line({ type: 'cost-state', sessionId, totalCostUSD: 20.67, totalDuration: 2273115, startTime: 1794152528275, modelUsage: { 'claude-fable-5-1': { inputTokens: 4, outputTokens: 5043, costUSD: 20.6 } } });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), text);
  for (let i = 0; i < agents; i++) {
    fs.mkdirSync(path.join(dir, sessionId, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, sessionId, 'subagents', `agent-${i}.jsonl`), assistant(`a${i}`, 'claude-sonnet-5-5', U(100, 0, 1000, 50)));
  }
  return h;
}

test('transcriptDir: the harness names a project directory by its path with the separators turned into dashes', () => {
  assert.strictEqual(usage.transcriptDir('/home/user/ECCode', '/root'), '/root/.claude/projects/-home-user-ECCode');
});

test('readTranscript: sums every assistant message once (a streamed repeat is deduplicated by message id), per model and in all, and reads the cost-state line', () => {
  const h = home('/p/x', 's1');
  const r = usage.readTranscript(path.join(usage.transcriptDir('/p/x', h), 's1.jsonl'));
  assert.strictEqual(r.messages, 3);
  assert.deepStrictEqual([r.input, r.cacheWrite, r.cacheRead, r.output], [14, 46849, 512031, 5063]);
  assert.strictEqual(r.allProcessed, 14 + 46849 + 512031 + 5063);
  assert.strictEqual(r.perModel['claude-haiku-5-5'].messages, 1);
  assert.strictEqual(r.perModel['claude-fable-5-1'].output, 5043);
  assert.strictEqual(r.costUSD, 20.67);
  assert.strictEqual(r.costState.modelUsage['claude-fable-5-1'].costUSD, 20.6);
});

test('readTranscript: a missing file is null; a file with no assistant line is unmeasurable, not zero', () => {
  assert.strictEqual(usage.readTranscript('/nonexistent/x.jsonl'), null);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-usage-')), 'e.jsonl');
  fs.writeFileSync(f, line({ type: 'mode' }));
  const r = usage.readTranscript(f);
  assert.strictEqual(r.allProcessed, 'unmeasurable');
  assert.strictEqual(r.costUSD, 'unmeasurable');
});

test('sessionUsage: the session plus its subagent transcripts, each reported and all summed; the cost is the session\'s cost-state', () => {
  const h = home('/p/y', 's2', { agents: 2 });
  const r = usage.sessionUsage('/p/y', 's2', { home: h });
  assert.strictEqual(r.unit, 'all-processed-tokens');
  assert.strictEqual(r.agents.length, 2);
  assert.strictEqual(r.allProcessed, (14 + 46849 + 512031 + 5063) + 2 * 1150);
  assert.strictEqual(r.costUSD, 20.67);
  assert.match(r.source, /plus 2 subagent transcript/);
});

test('sessionUsage: a session the harness never wrote is unmeasurable in every figure', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-usage-'));
  const r = usage.sessionUsage('/p/z', 'nope', { home: h });
  assert.strictEqual(r.session, null);
  assert.strictEqual(r.allProcessed, 'unmeasurable');
  assert.strictEqual(r.costUSD, 'unmeasurable');
});

test('listSessions: newest first, by the files that exist', () => {
  const h = home('/p/w', 'old');
  const dir = usage.transcriptDir('/p/w', h);
  fs.writeFileSync(path.join(dir, 'new.jsonl'), assistant('n', 'm', U(1, 0, 0, 1)));
  fs.utimesSync(path.join(dir, 'old.jsonl'), new Date(1000), new Date(1000));
  assert.deepStrictEqual(usage.listSessions('/p/w', { home: h }).map((s) => s.sessionId), ['new', 'old']);
  assert.deepStrictEqual(usage.listSessions('/p/none', { home: h }), []);
});

test('difference: a number only when both snapshots are numbers and the end is not below the start; otherwise unmeasurable', () => {
  assert.strictEqual(usage.difference({ allProcessed: 100 }, { allProcessed: 250 }), 150);
  assert.strictEqual(usage.difference({ allProcessed: 100 }, { allProcessed: 90 }), 'unmeasurable');
  assert.strictEqual(usage.difference({ allProcessed: 'unmeasurable' }, { allProcessed: 90 }), 'unmeasurable');
  assert.strictEqual(usage.difference(null, { allProcessed: 90 }), 'unmeasurable');
});
