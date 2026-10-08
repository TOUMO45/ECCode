'use strict';
// Promotion sanitizes what is harmless to remove (the project's own name,
// non-URL source strings) and still blocks real leaks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evidence = require('../lib/evidence');
const { Memory } = require('../lib/memory/records');
const { init } = require('../lib/project');
const { loadConfig } = require('../lib/config');
const { execFileSync } = require('child_process');
const { write, expectCode } = require('./helpers');

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-promo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  const store = init(dir, { name, idea: 'A project whose name must not travel with its lessons' });
  process.env.ECCODE_SHARED_MEMORY = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-shared-'));
  return { dir, store, config: loadConfig(dir) };
}

function verifiedLesson(ctx, content) {
  write(ctx.dir, 'check.js', 'process.exit(require("fs").existsSync("fixed") ? 0 : 1)\n');
  const repro = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'repro: sales-csv export fails the spec', command: 'node check.js', purpose: 'reproduction' });
  write(ctx.dir, 'fixed', 'yes');
  const fix = evidence.runCommand(ctx.store, 'learning-debugger', { label: 'rerun sales-csv tests', command: 'node check.js' });
  const mem = new Memory(ctx.store, ctx.config);
  const rec = mem.add('learning-debugger', { layer: 'debugging', content: {
    title: 'CSV exports for accounting must follow spec ACC-2', problem: 'The accounting CSV was rejected by the import.',
    symptoms: ['accounting import rejects the CSV'], component: 'csv export', environment: { node: '>=18' }, fingerprint: 'csv-acc-2',
    reproduction: { steps: ['run the check'], evidence: [`ev:${repro.id}`] }, rootCause: { explanation: 'The export used minimal quoting; spec ACC-2 needs every text field quoted.', evidence: [`ev:${repro.id}`] },
    failedAttempts: [{ approach: 'RFC 4180 minimal quoting', whyFailed: 'ACC-2 is stricter' }], solution: { description: 'Quote every text field and use CRLF line endings.', tradeoffs: 'Larger files.' },
    verification: { evidence: [`ev:${fix.id}`], regressionTest: 'node check.js' }, sources: [{ title: 'QA feedback', url: 'QA feedback', checkedAt: '2026-10-08' }],
    appliesWhen: ['CSV files for accounting'], notApplicableWhen: ['CSV for other consumers'], confidence: 'high', tags: ['csv'], ...content } });
  mem.review(rec.id, 'technical-reviewer', { decision: 'verify', notes: 'Re-ran the sales-csv check: it now passes.' });
  return { mem, rec };
}

test('the project name and a non-URL source string no longer block promotion; they are scrubbed from the shared copy', () => {
  const ctx = project('sales-csv');
  const { mem, rec } = verifiedLesson(ctx, { problem: 'The sales-csv accounting export was rejected by the import.' });
  const shared = mem.promote(rec.id, 'technical-reviewer');
  const text = JSON.stringify(shared);
  assert.ok(!/sales-csv/i.test(text), 'project name must not reach shared memory');
  assert.match(text, /<project>/);
  assert.strictEqual(shared.revisions[0].content.sources[0].url, undefined, 'a non-URL "url" is dropped, the title stays');
  assert.strictEqual(shared.revisions[0].content.sources[0].title, 'QA feedback');
});

test('real leaks still block promotion (secret, email, IP, user path, private URL)', () => {
  for (const [label, patch] of [
    ['email', { problem: 'Reported by jane.doe@example.com while exporting' }],
    ['IP address', { problem: 'The export host 10.1.2.3 returned the wrong file' }],
    ['user path', { problem: 'The failing file was /home/alice/work/export.csv in the checkout' }],
    ['credentials in a URL', { sources: [{ title: 'ticket', url: 'https://bob:pw@example.com/t/1', checkedAt: '2026-10-08' }] }],
  ]) {
    const ctx = project('sales-csv');
    const { mem, rec } = verifiedLesson(ctx, patch);
    const err = expectCode(() => mem.promote(rec.id, 'technical-reviewer'), 'PRIVATE_DATA');
    assert.ok(err.message.length > 20, label);
  }
});
