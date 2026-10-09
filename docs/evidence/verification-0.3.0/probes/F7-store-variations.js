'use strict';
// F7 (state mutation from a corrupted snapshot; recoverability), variations not in tests/review-F7.test.js:
//   a torn final line of events.jsonl in the two shapes a crash and a disk fault leave; eight concurrent writers
//   of two different kinds; the task.completed/handoff.recorded gap recovered through the CLI; the whole chain
//   rewritten and re-hashed (residual 3); and a forged `user` event appended with valid hashes (residual 3 as it
//   bears on F5).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { REPO, attempt, report, cleanup } = require('./_lib');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const runs = require(REPO + '/lib/runs');
const delivery = require(REPO + '/lib/delivery');
const { Store, stateDigest } = require(REPO + '/lib/store');
const { reduce } = require(REPO + '/lib/reducer');
const { sha256 } = require(REPO + '/lib/util');
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor } = require(REPO + '/tests/helpers');

const BIN = path.join(REPO, 'bin/eccode.js');
const cli = (dir, args) => {
  const r = spawnSync(process.execPath, [BIN, '--root', dir, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, exit: r.status, stdout: r.stdout.trim().slice(0, 300), stderr: r.stderr.trim().slice(0, 300) };
};
const LOG = (dir) => path.join(dir, '.eccode', 'events.jsonl');
const SNAP = (dir) => path.join(dir, '.eccode', 'state.json');

/** Rewrite the chain from event index `from` after mutating events in place: prevHash, stateHash and hash recomputed; snapshot rewritten. */
function rehash(dir, events) {
  let state = require(REPO + '/lib/reducer').initialState();
  let prev = '0'.repeat(64);
  const lines = [];
  for (const ev of events) {
    const { hash, stateHash, ...body } = ev;
    body.prevHash = prev;
    const ordered = { seq: body.seq, ts: body.ts, type: body.type, actor: body.actor, data: body.data, prevHash: body.prevHash };
    ordered.stateHash = stateDigest(reduce(state, JSON.parse(JSON.stringify(ordered))));
    const line = JSON.stringify({ ...ordered, hash: sha256(prev + JSON.stringify(ordered)) });
    const persisted = JSON.parse(line);
    state = reduce(state, persisted);
    prev = persisted.hash;
    lines.push(line);
    void hash;
    void stateHash;
  }
  fs.writeFileSync(LOG(dir), lines.join('\n') + '\n');
  fs.writeFileSync(SNAP(dir), JSON.stringify(state, null, 2) + '\n');
  return state;
}

const { step, finish } = report('F7-store-variations');
const dirs = [];
(async () => {
  try {
    // ---- A. The reviewer's forge (sanity) and a forged snapshot that also edits seq/lastHash.
    let ctx = tmpProject();
    dirs.push(ctx.dir);
    runs.recordRisk(ctx.store, 'delivery-lead', { id: 'R1', title: 'one', severity: 'low' });
    let snap = JSON.parse(fs.readFileSync(SNAP(ctx.dir), 'utf8'));
    snap.gates.architecture.status = 'approved';
    fs.writeFileSync(SNAP(ctx.dir), JSON.stringify(snap, null, 2));
    step('F7.forge.state', 'state() on a snapshot whose content differs from the log (seq/lastHash intact)', 'refused:SNAPSHOT_DIVERGED', attempt(() => ctx.store.state()));
    step('F7.forge.commit', 'gate start design on it', 'refused:SNAPSHOT_DIVERGED', attempt(() => gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator')));
    step('F7.forge.rebuild', 'eccode rebuild --actor orchestrator repairs it', 'ok', cli(ctx.dir, ['rebuild', '--actor', 'orchestrator']));
    step('F7.forge.after', 'then the forged approval is gone', 'refused:GATE_BLOCKED', attempt(() => gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator')));

    // ---- B. Torn tail, crash shape: the log holds N complete lines plus a fragment; the snapshot is at N.
    ctx = tmpProject();
    dirs.push(ctx.dir);
    runs.recordRisk(ctx.store, 'delivery-lead', { id: 'R1', title: 'one', severity: 'low' });
    const n = ctx.store.state().seq;
    fs.appendFileSync(LOG(ctx.dir), '{"seq":' + (n + 1) + ',"ts":"2026-10-09T00:00:00.000Z","type":"risk.recorded","actor":"delivery-lead","data":{"id":"R2","ti');
    const torn = attempt(() => new Store(ctx.dir).state());
    step('F7.torn.crash.state', 'state() with a torn fragment after the last complete event', 'ok', { ...torn, value: torn.ok ? { seq: torn.value.seq, risks: Object.keys(torn.value.risks) } : undefined });
    step('F7.torn.crash.audit', 'audit before any repair', 'documented', { ok: ctx.store.audit().ok, value: ctx.store.audit().errors });
    step('F7.torn.crash.commit', 'the next commit cuts the fragment and appends cleanly', 'ok', attempt(() => runs.recordRisk(ctx.store, 'delivery-lead', { id: 'R3', title: 'three', severity: 'low' })));
    step('F7.torn.crash.after', 'audit, seq and the event count after the repair', 'documented', { ok: ctx.store.audit().ok, value: { seq: ctx.store.state().seq, events: ctx.store.readEvents().length, risks: Object.keys(ctx.store.state().risks), lastLineComplete: fs.readFileSync(LOG(ctx.dir), 'utf8').endsWith('\n') } });
    // Disk-fault shape: the last COMPLETE line is cut mid-JSON while the snapshot already recorded it.
    const text = fs.readFileSync(LOG(ctx.dir), 'utf8');
    fs.writeFileSync(LOG(ctx.dir), text.slice(0, text.length - 40));
    step('F7.torn.fault.state', 'state() when the last recorded event itself is torn (snapshot ahead of the readable log)', 'refused:LOG_ROLLBACK', attempt(() => new Store(ctx.dir).state()));
    step('F7.torn.fault.commit', 'a commit on it', 'refused:LOG_ROLLBACK', attempt(() => runs.recordRisk(ctx.store, 'delivery-lead', { id: 'R4', title: 'four', severity: 'low' })));
    step('F7.torn.fault.audit', 'audit names the condition', 'documented', { ok: !ctx.store.audit().ok, value: ctx.store.audit().errors.map((e) => e.slice(0, 160)) });

    // ---- C. Eight concurrent writers of two kinds.
    ctx = tmpProject();
    dirs.push(ctx.dir);
    const procs = [];
    for (let i = 0; i < 4; i += 1) {
      procs.push(new Promise((resolve) => spawn(process.execPath, [BIN, '--root', ctx.dir, 'risk', 'add', '--id', `R${i}`, '--title', `risk ${i}`, '--severity', 'low', '--actor', 'delivery-lead']).on('exit', resolve)));
      procs.push(new Promise((resolve) => spawn(process.execPath, [BIN, '--root', ctx.dir, 'evidence', 'run', '--actor', 'test-engineer', '--label', `check ${i}`, '--', 'node -e "process.exit(0)"']).on('exit', resolve)));
    }
    const codes = await Promise.all(procs);
    const st = new Store(ctx.dir).state();
    const events = ctx.store.readEvents();
    step('F7.concurrent', '4 risk adds + 4 evidence runs spawned at once', 'documented', { ok: codes.every((c) => c === 0) && events.length === st.seq && ctx.store.audit().ok && Object.keys(st.risks).length === 4 && Object.keys(st.evidence).length === 4, value: { exitCodes: codes, seq: st.seq, events: events.length, risks: Object.keys(st.risks).length, evidence: Object.keys(st.evidence).length, auditOk: ctx.store.audit().ok, snapshotEqualsReplay: JSON.stringify(st) === JSON.stringify(ctx.store.rebuild(events)) } });

    // ---- D. The handoff gap, recovered through the CLI.
    ctx = tmpProject();
    dirs.push(ctx.dir);
    approveThroughPlan(ctx);
    gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
    tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
    write(ctx.dir, 'src/server/a.js', '// api\n');
    const ev = passCheck(ctx.store, 'backend-engineer');
    const handoff = handoffFor('api', 'backend-engineer', [ev.id], ['src/server/a.js']);
    const original = ctx.store.commit.bind(ctx.store);
    ctx.store.commit = (t, ...rest) => { if (t === 'handoff.recorded') throw new Error('simulated crash'); return original(t, ...rest); };
    const crash = attempt(() => tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', handoff));
    ctx.store.commit = original;
    step('F7.gap.crash', 'task.completed committed, handoff.recorded never written', 'documented', { ok: !crash.ok, value: { taskStatus: ctx.store.state().tasks.api.status, handoffInRecord: Boolean(ctx.store.state().handoffs[ctx.store.state().tasks.api.handoffId]) } });
    step('F7.gap.audit', 'audit: ok with a warning naming the recovery command', 'documented', { ok: ctx.store.audit().ok && ctx.store.audit().warnings.length === 1, value: ctx.store.audit().warnings.map((w) => w.slice(0, 200)) });
    step('F7.gap.resume', 'eccode resume on the gap', 'ok', cli(ctx.dir, ['resume']));
    write(ctx.dir, '.eccode/drafts/handoff-api.json', JSON.stringify(handoff, null, 2));
    step('F7.gap.recover', 'eccode handoff record --actor backend-engineer --file <handoff.json>', 'ok', cli(ctx.dir, ['handoff', 'record', '--actor', 'backend-engineer', '--file', '.eccode/drafts/handoff-api.json']));
    step('F7.gap.after', 'audit after the recovery: no warning', 'documented', { ok: ctx.store.audit().ok && ctx.store.audit().warnings.length === 0, value: ctx.store.audit().warnings });

    // ---- E. Rewrite and re-hash the whole chain (residual 3): a risk flipped from open to accepted by "user".
    ctx = tmpProject();
    dirs.push(ctx.dir);
    runs.recordRisk(ctx.store, 'delivery-lead', { id: 'RISK-X', title: 'Data loss on restart', severity: 'critical' });
    runs.recordRisk(ctx.store, 'delivery-lead', { id: 'RISK-Y', title: 'Slow cold start', severity: 'low' });
    let evs = ctx.store.readEvents();
    const target = evs.find((e) => e.type === 'risk.recorded' && e.data.id === 'RISK-X');
    target.data.severity = 'low'; // the critical risk becomes low in history
    const rewritten = rehash(ctx.dir, evs);
    const fresh = new Store(ctx.dir);
    step('F7.rewrite', 'event 2 edited (critical -> low), every later hash and stateHash recomputed, snapshot rewritten', 'documented', { ok: fresh.audit().ok && fresh.state().risks['RISK-X'].severity === 'low' && rewritten.seq === evs.length, value: { auditOk: fresh.audit().ok, auditErrors: fresh.audit().errors, severityNow: fresh.state().risks['RISK-X'].severity, cliAudit: cli(ctx.dir, ['audit']).exit } }, 'RESIDUAL 3 (documented): not detected; the digests live in the same writable files');
    // ---- F. A forged user event appended with valid hashes: the engine then reports a user decision nobody made.
    evs = fresh.readEvents();
    const last = evs[evs.length - 1];
    evs.push({ seq: last.seq + 1, ts: new Date().toISOString(), type: 'risk.recorded', actor: 'user', data: { id: 'RISK-X', status: 'accepted' }, prevHash: last.hash });
    rehash(ctx.dir, evs);
    const forgedUser = new Store(ctx.dir);
    const report = delivery.buildReport(forgedUser.state(), forgedUser.audit(), { events: forgedUser.readEvents() });
    step('F7.forgedUserEvent', 'a risk.recorded accepted event with actor user appended offline with valid hashes', 'documented', { ok: forgedUser.audit().ok && forgedUser.state().risks['RISK-X'].status === 'accepted' && /accepted by user/.test(report), value: { auditOk: forgedUser.audit().ok, status: forgedUser.state().risks['RISK-X'].status, reportSaysAcceptedByUser: /accepted by user/.test(report), reportLine: (report.split('\n').find((l) => /User decisions|accepted by user/.test(l)) || '').slice(0, 160) } }, 'RESIDUAL 3 as it bears on F5: the TTY check protects the CLI path only; an actor with write access to .eccode/ mints user events offline and the handoff presents them as confirmed');
  } finally {
    cleanup(...dirs);
  }
  finish();
})();
