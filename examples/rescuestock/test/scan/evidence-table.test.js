// docs/evidence-table.md (FU-52, F-PL-2, SEC-18): one row for each of the 45 required criteria, RS-01..RS-39 and NFR1..NFR6, with the
// suites that prove it, the tests by file and title, the ev: ids of the runs, and the part that is NOT verified with its blocker.
//
// This test keeps the table honest:
//   - all 45 ids are present exactly once, each with a status from the fixed vocabulary (verified, fake-only, LIVE-DEPENDENT);
//   - every cited ev: id has the record pattern, and every test a row names exists: its file exists and holds the title text;
//   - every row that is not plain `verified`, and every row with a live suite tag, names its blocker (LIVE-M1, LIVE-P1, LIVE-P2, OQ-D5,
//     USER-Q9) in its Unverified cell, and no live suite ever appears as passed;
//   - the specific wordings the acceptance criteria demand are there: the SEC-18 wording on RS-20/RS-25/RS-26, the single-credential
//     label (A2) on the rows it weakens, RS_MODEL_CUSTOMER_DAILY_SHARE=1 on NFR6 (F-TR-18), derive.js on RS-36 (F-TR-9), the Node 22.5
//     run being the user's on NFR1 (Q9), and the list of what no live file covers (FU-52), identical to docs/runbooks/live-paypal.md;
//   - WHEN THE PROJECT RECORD IS PRESENT (it is not in a clean checkout, where those checks are reported as skipped): each cited run
//     exists, exited 0, and its log shows every test the row names as `ok` and not skipped. A claim in the table that no recorded run
//     shows fails here.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = join(ROOT, 'docs', 'evidence-table.md');
const RUNBOOK = join(ROOT, 'docs', 'runbooks', 'live-paypal.md');
const EVIDENCE_DIR = join(ROOT, '.eccode', 'evidence');

export const CRITERIA = Object.freeze([
  ...Array.from({ length: 39 }, (_, i) => `RS-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 6 }, (_, i) => `NFR${i + 1}`),
]);
export const STATUSES = Object.freeze(['verified', 'fake-only', 'LIVE-DEPENDENT']);
export const SUITE_TAGS = Object.freeze(['D', 'B', 'I', 'LM', 'LP']);
export const BLOCKERS = Object.freeze(['LIVE-M1', 'LIVE-P1', 'LIVE-P2', 'OQ-D5', 'USER-Q9']);
const EV_ID = /^ev:ev-[0-9a-z]{8}-[0-9a-f]{8}$/;

// ---- parsing -----------------------------------------------------------------------------------------------------------------

/** parseTable(markdown) -> rows[]: the rows of the table whose first cell is a criterion id. */
export function parseTable(markdown) {
  const rows = [];
  for (const line of markdown.split('\n')) {
    if (!/^\|\s*(RS-\d\d|NFR\d)\s*\|/.test(line)) continue;
    const cells = line.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim());
    assert.equal(cells.length, 6, `a table row has 6 cells (id, status, suites, tests, evidence, unverified): ${line.slice(0, 80)}`);
    const [id, status, suites, tests, evidence, unverified] = cells;
    rows.push({
      id,
      status,
      suites: suites.split(/[\s,]+/).filter(Boolean),
      tests: tests.split(/<br>/).map((t) => t.trim()).filter(Boolean).map((t) => {
        const m = /^`([^`]+?) :: ([^`]+)`$/.exec(t);
        assert.ok(m, `${id}: a tests entry is \`file :: title\`, got ${t.slice(0, 80)}`);
        return { file: m[1], title: m[2] };
      }),
      evidence: evidence.split(/[\s,]+/).filter(Boolean),
      unverified,
    });
  }
  return rows;
}

/** The text of a recorded run's log, or null when there is none. */
export function evidenceLog(id) {
  const path = join(EVIDENCE_DIR, `${id.replace(/^ev:/, '')}.log`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * true when the TAP log shows at least one test whose title contains `title`, and EVERY such line is `ok` and not skipped or todo. A TAP
 * log carries no file name, so the binding of a title to its file rests on the fragment occurring in exactly one test file (checked
 * separately); a skipped or failed line anywhere among the matches is then that file's.
 */
export function logShowsPassed(log, title) {
  let seen = 0;
  for (const line of log.split('\n')) {
    const m = /^\s*(not ok|ok) \d+ - (.*)$/.exec(line);
    if (!m || !m[2].includes(title)) continue;
    if (m[1] !== 'ok' || /# (SKIP|TODO)/i.test(m[2])) return false;
    seen += 1;
  }
  return seen > 0;
}

const INSPECTION_REVIEW = 'rev-mv4fdv59-01732f16';

/** The text of every live PayPal file, joined (to show that none of them mentions a lost capture answer). */
function readdirLive() {
  const dir = join(ROOT, 'test', 'live', 'paypal');
  return readdirSync(dir).filter((n) => n.endsWith('.js')).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n');
}

/** The names of the files (of a name -> text map) whose text holds `title`. */
export function fileSetOf(title, texts) {
  return [...texts].filter(([, text]) => text.includes(title)).map(([name]) => name).sort();
}

/** Every .js file under test/, except this one, as a relative name -> text map. */
function testTexts() {
  const out = new Map();
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['out', '.out', 'node_modules'].includes(entry.name)) visit(path);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
        const name = relative(ROOT, path).split('\\').join('/');
        if (name !== 'test/scan/evidence-table.test.js') out.set(name, readFileSync(path, 'utf8'));
      }
    }
  };
  visit(join(ROOT, 'test'));
  return out;
}

const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
const rows = doc ? parseTable(doc) : [];
const byId = new Map(rows.map((r) => [r.id, r]));
const recordPresent = existsSync(EVIDENCE_DIR);

describe('the evidence table: the scan is not vacuous', () => {
  test('evidence table: the parser and the log reader do what the checks below rely on', () => {
    const row = parseTable('| RS-01 | verified | D B | `test/a.test.js :: RS-01: one` <br> `test/b.test.js :: two` | ev:ev-abcdef12-0123abcd | — |')[0];
    assert.deepEqual(row, {
      id: 'RS-01', status: 'verified', suites: ['D', 'B'],
      tests: [{ file: 'test/a.test.js', title: 'RS-01: one' }, { file: 'test/b.test.js', title: 'two' }], evidence: ['ev:ev-abcdef12-0123abcd'], unverified: '—',
    });
    const log = ['    ok 1 - RS-01: one', '    not ok 2 - RS-01: two', '    ok 3 - RS-01: three # SKIP no host', '    ok 4 - RS-01: four # TODO later'].join('\n');
    assert.equal(logShowsPassed(log, 'RS-01: one'), true);
    assert.equal(logShowsPassed(log, 'RS-01: two'), false, 'a failed test is not shown as passed');
    assert.equal(logShowsPassed(log, 'RS-01: three'), false, 'a skipped test is never shown as passed');
    assert.equal(logShowsPassed(log, 'RS-01: four'), false);
    assert.equal(logShowsPassed(log, 'RS-01: absent'), false);
    // a fragment that two tests share is shown only when BOTH lines are ok (TR-G-3): a skipped sibling is not hidden by a passing one
    const shared = ['ok 1 - RS-22: the second capture is declined: plan non_executable', 'ok 2 - RS-22: the second capture is declined: the first is refunded # SKIP x'].join('\n');
    assert.equal(logShowsPassed(shared, 'RS-22: the second capture is declined'), false);
    assert.equal(logShowsPassed(shared, 'RS-22: the second capture is declined: plan non_executable'), true);
    assert.equal(fileSetOf('RS-01: one', new Map([['a.js', 'RS-01: one'], ['b.js', 'x RS-01: one y'], ['c.js', 'zzz']])).join(), 'a.js,b.js');
    assert.throws(() => parseTable('| RS-01 | verified |'), /6 cells/);
    assert.equal(EV_ID.test('ev:ev-mv43mqlq-01b00d12'), true);
    assert.equal(EV_ID.test('ev:mv43mqlq'), false);
  });
});

describe('the evidence table: structure', () => {
  test('evidence table: docs/evidence-table.md exists and holds one row for each of the 45 criteria, RS-01..RS-39 and NFR1..NFR6, exactly once', () => {
    assert.ok(doc, 'docs/evidence-table.md exists');
    assert.deepEqual(rows.map((r) => r.id).sort(), [...CRITERIA].sort());
    assert.equal(new Set(rows.map((r) => r.id)).size, 45);
    assert.equal(rows.length, 45);
  });

  test('evidence table: every status is one of verified, fake-only, LIVE-DEPENDENT and every suite tag is one of D, B, I, LM, LP', () => {
    for (const row of rows) {
      assert.ok(STATUSES.includes(row.status), `${row.id}: status "${row.status}"`);
      assert.ok(row.suites.length >= 1, `${row.id}: at least one suite tag`);
      for (const tag of row.suites) assert.ok(SUITE_TAGS.includes(tag), `${row.id}: suite tag "${tag}"`);
    }
  });

  test('evidence table: every row cites at least one ev: id with the record pattern, and names at least one test', () => {
    for (const row of rows) {
      assert.ok(row.evidence.length >= 1, `${row.id}: cites no run`);
      for (const id of row.evidence) assert.match(id, EV_ID, `${row.id}: ${id}`);
      assert.ok(row.tests.length >= 1, `${row.id}: names no test`);
    }
  });

  test('evidence table: every test a row names exists: the file is in the tree and holds the title text', () => {
    const problems = [];
    for (const row of rows) {
      for (const { file, title } of row.tests) {
        const path = join(ROOT, file);
        if (!existsSync(path)) problems.push(`${row.id}: ${file} does not exist`);
        else if (!readFileSync(path, 'utf8').includes(title)) problems.push(`${row.id}: ${file} holds no test titled "${title.slice(0, 70)}"`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test('evidence table: every cited title occurs in exactly one test file, the one the row names (a TAP log carries no file name, so the title is the only binding of a log line to a file)', () => {
    const texts = testTexts();
    const problems = [];
    for (const row of rows) {
      for (const { file, title } of row.tests) {
        const holders = fileSetOf(title, texts);
        if (holders.length !== 1 || holders[0] !== file) problems.push(`${row.id}: "${title.slice(0, 60)}" is in ${holders.length} file(s): ${holders.join(', ')} (it must be in ${file} only)`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test('evidence table: the suite tags agree with the tests a row cites: a unit, API, integration, scan, eval or timing test needs D; a browser test needs B', () => {
    const problems = [];
    for (const row of rows) {
      const needsD = row.tests.some((t) => /^test\/(unit|api|integration|scan|eval|timing)\//.test(t.file));
      const needsB = row.tests.some((t) => /^test\/browser\//.test(t.file));
      if (needsD !== row.suites.includes('D')) problems.push(`${row.id}: ${needsD ? 'cites a D test but lacks the D tag' : 'carries D but cites no D test'}`);
      // B without a browser test is allowed for the scan that reads what the browser run writes (the screenshots).
      const readsBrowserOutput = row.tests.some((t) => /screenshot/i.test(t.title));
      if (needsB && !row.suites.includes('B')) problems.push(`${row.id}: cites a browser test but lacks the B tag`);
      if (!needsB && row.suites.includes('B') && !readsBrowserOutput) problems.push(`${row.id}: carries B but cites no browser test`);
    }
    assert.deepEqual(problems, []);
  });
});

describe('the evidence table: unverified parts are named, live suites are never claimed', () => {
  test('evidence table: a row that is not plain verified, or that has a live suite tag, names its blocker in the Unverified cell', () => {
    for (const row of rows) {
      const live = row.suites.includes('LM') || row.suites.includes('LP');
      if (row.status === 'verified' && !live) continue;
      assert.ok(row.unverified && row.unverified !== '—', `${row.id}: status ${row.status}, suites ${row.suites.join(' ')}: the Unverified cell is empty`);
      assert.ok(BLOCKERS.some((b) => row.unverified.includes(b)), `${row.id}: the Unverified cell names no blocker (${BLOCKERS.join(', ')})`);
    }
  });

  test('evidence table: LM rows name LIVE-M1 (A4/Q3); LP rows name LIVE-P1 (A6/Q2); RS-31 and RS-32 name LIVE-P2; no row says a live suite passed', () => {
    for (const row of rows) {
      if (row.suites.includes('LM')) assert.match(row.unverified, /LIVE-M1/, `${row.id}`);
      if (row.suites.includes('LP')) assert.match(row.unverified, /LIVE-P1/, `${row.id}`);
    }
    for (const id of ['RS-31', 'RS-32']) assert.match(byId.get(id).unverified, /LIVE-P2/, id);
    for (const id of ['RS-01', 'RS-02', 'RS-03', 'RS-05', 'NFR6']) assert.ok(byId.get(id).suites.includes('LM'), `${id} has a live-model part`);
    for (const id of ['RS-18', 'RS-19', 'RS-20', 'RS-23', 'RS-24']) assert.ok(byId.get(id).suites.includes('LP'), `${id} has a live-PayPal part`);
    assert.doesNotMatch(doc, /live[- ](model|paypal|sandbox)[^.\n]{0,40}\b(passed|green|verified)\b/i, 'the table never says a live run passed');
    assert.match(doc, /No live suite was run/i, 'the table says plainly that no live suite was run');
    for (const row of rows) {
      for (const { file } of row.tests) assert.doesNotMatch(file, /^test\/live\//, `${row.id} cites a live file as a test that ran`);
    }
  });

  test('evidence table: the SEC-18 wording (RS-20, RS-25, RS-26), the single-credential label A2, RS_MODEL_CUSTOMER_DAILY_SHARE=1 on NFR6, derive.js on RS-36 and the user-run Node 22.5 branch on NFR1 are in their rows', () => {
    for (const id of ['RS-20', 'RS-25', 'RS-26']) {
      assert.match(byId.get(id).unverified, /SEC-18/, `${id}`);
      assert.match(byId.get(id).unverified, /fake/i, `${id}: rests on the fake's model of PayPal`);
    }
    for (const id of ['RS-18', 'RS-19', 'RS-20', 'RS-23', 'RS-24']) assert.match(byId.get(id).unverified, /\(A2\)|\bA2\b/, `${id}: single-credential mode weakens the live row (A2)`);
    assert.match(byId.get('NFR6').unverified, /RS_MODEL_CUSTOMER_DAILY_SHARE=1/, 'NFR6 states that its case runs with RS_MODEL_CUSTOMER_DAILY_SHARE=1 (F-TR-18)');
    assert.match(byId.get('RS-36').unverified, /derive\.js/, 'RS-36 names the derive.js inspection');
    assert.match(byId.get('NFR1').unverified, /22\.5/);
    assert.match(byId.get('NFR1').unverified, /USER-Q9/);
    assert.match(byId.get('NFR1').unverified, /user/i);
  });

  test('evidence table: the criteria whose spec has an (I) part, RS-29, RS-35, RS-36, NFR3 and NFR4, carry the I tag and cite the recorded inspection; RS-36 no longer says its inspection is outside the evidence (TR-G-1)', () => {
    for (const id of ['RS-29', 'RS-35', 'RS-36', 'NFR3', 'NFR4']) {
      const row = byId.get(id);
      assert.ok(row.suites.includes('I'), `${id} carries the I tag`);
      assert.ok(row.unverified.includes(INSPECTION_REVIEW), `${id} cites the inspection ${INSPECTION_REVIEW}`);
      assert.match(row.unverified, /\(I\)/, `${id} says what the person inspected`);
    }
    assert.doesNotMatch(byId.get('RS-36').unverified, /NOT part of this evidence/, 'RS-36 does not disclaim the inspection it cites');
    assert.match(byId.get('RS-36').unverified, /derive\.js/, 'RS-36 names derive.js');
    assert.match(byId.get('RS-36').unverified, /FU-62/, 'RS-36 cites the FU-62 inspection of the final derive.js');
    if (recordPresent) assert.ok(existsSync(join(ROOT, '.eccode', 'reviews', `${INSPECTION_REVIEW}.json`)), `the review ${INSPECTION_REVIEW} is in the project record`);
  });

  test('evidence table: the pointers are right: RS-25 says no live file covers a lost capture answer; RS-13 and RS-15 name LIVE-P2 (RS-32(b)) for a real void, not the FU-52 list; the live void is asserted by the live journey file', () => {
    assert.match(byId.get('RS-25').unverified, /no live file covers a lost capture answer/i);
    assert.doesNotMatch(byId.get('RS-25').unverified, /LIVE-P1 \(OQ-D5\)/, 'RS-25 does not hand the lost answer to LIVE-P1');
    for (const id of ['RS-13', 'RS-15']) {
      assert.match(byId.get(id).unverified, /LIVE-P2/, `${id} names LIVE-P2`);
      assert.match(byId.get(id).unverified, /RS-32\(b\)/, `${id} names RS-32(b)`);
      assert.doesNotMatch(byId.get(id).unverified, /FU-52/, `${id} does not point at the FU-52 list, which has no plain void`);
    }
    const journey = readFileSync(join(ROOT, 'test', 'live', 'paypal', 'journey-sandbox.test.js'), 'utf8');
    assert.match(journey, /RS-32\(b\)[^\n]*VOIDED/, 'journey-sandbox.test.js asserts the authorizations VOIDED at PayPal');
    assert.ok(!/lost.?(capture|answer|response)/i.test(readdirLive()), 'no live file covers a lost capture answer');
  });

  test('evidence table: what no live file covers (FU-52) is listed in the table as in docs/runbooks/live-paypal.md, item for item', () => {
    const phrases = [
      'authorization DENIED or PENDING',
      'void after a capture',
      'PayPal-Request-Id` retention across a process takeover',
      'capture PENDING or DECLINED',
      'refund PENDING or FAILED',
      'EXPIRED read after a refused void',
      'RS-22',
      'cross-merchant signature rejection',
    ];
    const runbook = readFileSync(RUNBOOK, 'utf8');
    const section = (text) => text.slice(text.search(/Not covered by any live file/i));
    const t = section(doc);
    const r = section(runbook);
    assert.ok(t.length > 100 && r.length > 100, 'both documents have the section');
    for (const phrase of phrases) {
      const key = phrase.replace(/`/g, '');
      assert.ok(r.replace(/`/g, '').includes(key), `the runbook lists "${key}"`);
      assert.ok(t.replace(/`/g, '').includes(key), `the evidence table lists "${key}"`);
    }
  });

  test('evidence table: the limits section is there (platforms, browsers, Node, the lockfile, T20, the stub, the clock-shift run) and says no live suite was run', () => {
    for (const word of ['## Limits', 'Chromium', 'Node 22', 'Linux', 'fsevents', 'T20', 'stub', 'CLOCK_SHIFT_DAYS']) assert.ok(doc.includes(word), `the table mentions ${word}`);
  });
});

describe('the evidence table: the cited runs exist and show what the rows claim (needs the project record)', () => {
  test('evidence table: every cited run exists, exited 0, and its log shows each test the row names as ok and not skipped', (t) => {
    if (!recordPresent) {
      t.skip('the project record (.eccode/evidence) is not part of a clean checkout, so the cited runs cannot be read here');
      return;
    }
    const problems = [];
    for (const row of rows) {
      const logs = [];
      for (const id of row.evidence) {
        const log = evidenceLog(id);
        if (log === null) {
          problems.push(`${row.id}: ${id} has no log in .eccode/evidence`);
          continue;
        }
        if (!/^# exit: 0$/m.test(log)) problems.push(`${row.id}: ${id} did not exit 0`);
        logs.push(log);
      }
      for (const { file, title } of row.tests) {
        if (!logs.some((log) => logShowsPassed(log, title))) problems.push(`${row.id}: no cited run shows "${title.slice(0, 60)}" (${file}) as ok`);
      }
    }
    assert.deepEqual(problems, []);
  });
});
