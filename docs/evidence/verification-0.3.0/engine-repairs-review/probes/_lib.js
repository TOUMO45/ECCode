'use strict';
// Shared scaffolding for the 0.3.0 verification probes (independent re-review).
// Each probe records steps with an `expect`ation and the observed outcome, so the
// results file is self-judging: any step whose verdict is UNEXPECTED is a finding
// (either a bypass the engine accepted, or legitimate work it refused).
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const REPO = process.env.ECCODE_REPO || require('path').resolve(__dirname, '../../../../..'); // the worktree under review

function attempt(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message, details: err.details };
  }
}

/** A probe report. `expect` is 'refused:<CODE>' | 'ok' | 'allowed' | 'denied' | 'documented' (no judgement). */
function report(name) {
  const out = { probe: name, repo: REPO, node: process.version, platform: process.platform, startedAt: new Date().toISOString(), steps: [], unexpected: 0 };
  const step = (id, description, expect, observed, classification) => {
    let verdict = 'as-expected';
    if (expect === 'documented') verdict = 'documented';
    else if (expect === 'ok') verdict = observed.ok ? 'as-expected' : 'UNEXPECTED';
    else if (expect.startsWith('refused:')) verdict = !observed.ok && observed.code === expect.slice(8) ? 'as-expected' : 'UNEXPECTED';
    else if (expect === 'refused') verdict = !observed.ok ? 'as-expected' : 'UNEXPECTED';
    else if (expect === 'denied') verdict = observed.decision === 'deny' ? 'as-expected' : 'UNEXPECTED';
    else if (expect === 'allowed') verdict = observed.decision === 'allow' ? 'as-expected' : 'UNEXPECTED';
    if (verdict === 'UNEXPECTED') out.unexpected += 1;
    const entry = { id, description, expect, verdict, ...(classification ? { classification } : {}), observed: trim(observed) };
    out.steps.push(entry);
    process.stderr.write(`[${verdict === 'UNEXPECTED' ? '!!' : 'ok'}] ${id} ${description} -> ${observed.ok === undefined ? observed.decision || '' : observed.ok ? 'ok' : observed.code}${observed.ok === false ? ': ' + String(observed.message).split('\n')[0].slice(0, 160) : ''}\n`);
    return entry;
  };
  const finish = (extra = {}) => {
    out.finishedAt = new Date().toISOString();
    Object.assign(out, extra);
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = 0; // UNEXPECTED steps are findings, not probe failures; the report says which
  };
  return { out, step, finish };
}

function trim(observed) {
  const o = { ...observed };
  if (typeof o.message === 'string' && o.message.length > 1200) o.message = o.message.slice(0, 1200) + '…';
  if (o.value !== undefined) {
    try {
      const s = JSON.stringify(o.value);
      if (s && s.length > 600) o.value = s.slice(0, 600) + '…';
    } catch {
      o.value = String(o.value);
    }
  }
  return o;
}

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(dir, msg = 'work') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

module.exports = { REPO, attempt, report, git, commitAll, cleanup };
