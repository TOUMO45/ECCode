#!/usr/bin/env node
'use strict';
// Writes the Senior Bench task directories from _tools/selection.json (the
// draw and its live validation), the requests (_tools/prompts.<category>.json,
// drafted and reviewed), the authorization policies (_tools/policies/<sha8>.json)
// and the ambiguous items' registered questions (_tools/questions/<sha8>.json).
// No Mealie file is written: tasks name commits; hidden tests are exported
// from the mirror at run time. An item dropped by the instrument check
// (selection.json `dropped`) or without a reviewed request is not built, and
// is listed. Items are ordered by category, then pool order.
// usage: node build.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('../../../pilot/lib');
const env = require('../../mealie/_tools/env');
const { checksFor } = require('../../mealie/_tools/build.js');

const SUITE = path.join(__dirname, '..');
const TOOLS = __dirname;
const TRACK = { migration: 'feature', authorization: 'fix', ambiguous: null };
const selection = JSON.parse(fs.readFileSync(path.join(TOOLS, 'selection.json'), 'utf8'));
// The instrument check's results (reference.js), by sha8: an item it dropped is not built.
const instrument = fs.existsSync(path.join(TOOLS, 'instrument.json')) ? JSON.parse(fs.readFileSync(path.join(TOOLS, 'instrument.json'), 'utf8')) : {};

function venvKey(mirror, commit) {
  return env.envKey(execFileSync('git', ['--git-dir', mirror, 'show', `${commit}:uv.lock`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function main() {
  const mirror = lib.mealieMirror();
  // Task directories are rewritten in place (a screening may be running from them): a directory of an item no longer built is removed.
  const built = new Set();
  const skipped = [];
  let order = 0;
  for (const category of ['migration', 'authorization', 'ambiguous']) {
    const promptsFile = path.join(TOOLS, `prompts.${category}.json`);
    const prompts = fs.existsSync(promptsFile) ? JSON.parse(fs.readFileSync(promptsFile, 'utf8')) : {};
    for (const a of selection.accepted[category] || []) {
      const sha8 = a.sha.slice(0, 8);
      const prompt = prompts[sha8];
      const inst = instrument[sha8] || {};
      if (inst.dropped) { skipped.push(`${category} ${sha8}: dropped (${inst.dropped})`); continue; }
      if (category !== 'ambiguous' && !inst.referenceGrade && !inst.instrument) { skipped.push(`${category} ${sha8}: instrument check not run`); continue; }
      if (!prompt || !prompt.text || !prompt.reviewed) { skipped.push(`${category} ${sha8}: no reviewed request`); continue; }
      const policy = category === 'authorization' ? path.join(TOOLS, 'policies', `${sha8}.json`) : null;
      const question = category === 'ambiguous' ? path.join(TOOLS, 'questions', `${sha8}.json`) : null;
      if (policy && !fs.existsSync(policy)) { skipped.push(`${category} ${sha8}: no policy`); continue; }
      if (question && !fs.existsSync(question)) { skipped.push(`${category} ${sha8}: no registered question`); continue; }
      order += 1;
      const id = `${String(order).padStart(2, '0')}-${category}-${sha8}`;
      const checks = checksFor(a);
      if (category === 'migration') checks.push({ id: 'grade', command: 'node "$ECCODE_BENCH_TASK_DIR/../_tools/grade.js" migration --tree .', timeoutMs: 1800000 });
      if (category === 'authorization') checks.push({ id: 'grade', command: 'node "$ECCODE_BENCH_TASK_DIR/../_tools/grade.js" authorization --tree . --config "$ECCODE_BENCH_TASK_DIR/security.json"', timeoutMs: 1800000 });
      const task = {
        id: `senior-${category}-${sha8}`,
        category,
        order,
        source: { repo: lib.MEALIE, commit: a.parent },
        env: { PATH: `\${ECCODE_MEALIE_ENVS}/py-${venvKey(mirror, a.parent)}/bin:\${PATH}`, PYTHONDONTWRITEBYTECODE: '1', pnpm_config_verify_deps_before_run: 'false', ECCODE_MEALIE_ENVS: '${ECCODE_MEALIE_ENVS}' },
        setup: 'node "$ECCODE_BENCH_TASK_DIR/../../mealie/_tools/env.js" python . > /dev/null',
        prompt: prompt.text,
        title: a.subject,
        track: TRACK[category] || (/^fix/.test(a.subject) ? 'fix' : 'feature'),
        fixCommit: a.sha,
        hidden: { fromSource: { commit: a.sha, paths: a.hidden } },
        hiddenChecks: checks,
        measured: { target: a.backend.target.length, regression: a.backend.regression, failingBeforeAndAfter: a.backend.failingBoth },
        ...(inst.referenceGrade ? { referenceGrade: { safe: inst.referenceGrade.safe } } : {}),
        ...(inst.instrument ? { instrument: { parentUnsafe: inst.instrument.parentUnsafe, commitSafe: inst.instrument.commitSafe } } : {}),
        ...(a.earlierSuiteItem ? { earlierSuiteItem: a.earlierSuiteItem } : {}),
      };
      built.add(id);
      fs.mkdirSync(path.join(SUITE, id), { recursive: true });
      fs.writeFileSync(path.join(SUITE, id, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
      if (policy) fs.copyFileSync(policy, path.join(SUITE, id, 'security.json'));
      if (question) fs.copyFileSync(question, path.join(SUITE, id, 'question.json'));
      process.stdout.write(`${id}: ${task.track}, ${task.title}\n`);
    }
  }
  for (const d of fs.readdirSync(SUITE)) if (/^\d\d-/.test(d) && !built.has(d)) fs.rmSync(path.join(SUITE, d), { recursive: true, force: true });
  for (const s of skipped) process.stdout.write(`not built: ${s}\n`);
}

if (require.main === module) main();
