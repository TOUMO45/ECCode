#!/usr/bin/env node
'use strict';
// Senior Bench round 1 (bench/protocols/2026-11-01-senior-bench.md, amendment 2):
// the item pools of the three categories, drawn mechanically from the Mealie
// mirror before any model sees them, and validated live exactly as the
// earlier Mealie suites were (../../mealie/_tools/select.js): the commit's new
// or changed tests fail on its parent and pass at the commit, twice on each
// side, and the regression set passes on both sides.
//
// Window: v3.10.0..75332567 (the proof run's and the multi-file run's windows
// together). A candidate is a fix or feature (no dependency update, bump or
// dev change) that changes mealie/, has backend tests, and counts at most
// 1,500 changed non-test lines (the multi-file rule's ceiling). Categories:
//   migration      adds a file under mealie/alembic/versions/
//   authorization  the subject names access control (AUTHZ) and not an
//                  authentication provider, token, cookie or transport fix
//                  (NOT_AUTHZ); never a migration item
//   ambiguous      a feature, in neither pool above, not an item of the
//                  mealie, mealie2, mealie3 or mealie4 suites (their requests
//                  are registered in full); its request is written with one
//                  decision left open and that decision registered as the
//                  item's question. Short of 12, the pool expands, in this
//                  order (the protocol's rule 2): the window's features that
//                  WERE items of an earlier suite (a different request on the
//                  same commit; disclosed per item), then the window's fixes
//                  in neither pool above
// Each pool is shuffled with mulberry32(42) and validated front to back until
// 16 are accepted (the registered minimum is 12, drawn up to 16). Every skip
// is recorded with its reason.
// usage: ECCODE_MEALIE_ENVS=<dir> node select.js [--only <category>] [--take 16]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../../../pilot/lib');
const bench = require('../../../../lib/bench');
const mealie = require('../../mealie/_tools/select.js');

const WINDOW = 'v3.10.0..753325676331cf8df48cae7c64ce634f2cb693cb';
const TAKE = 16;
const MAX_LINES = 1500;
const FIX = /^fix(\([^)]*\))?!?:/;
const FEAT = /^feat(\([^)]*\))?!?:/;
const EXCLUDED_SUBJECT = /^fix\(deps\)|\bbump\b|^dev:|^chore/i;
const AUTHZ = /permission|ownership|owner|authoriz|private|public|sensitive|visibility|organize|household|admin|GHSA|scope/i;
const NOT_AUTHZ = /token|cookie|ldap|oidc|smtp|ssrf|xss|i18n|message|avatar|reverse proxy|log\b|logging/i;
const MIGRATION_FILE = (f) => f.status === 'A' && /^mealie\/alembic\/versions\/.*\.py$/.test(f.path);
const OUT = path.join(__dirname, 'selection.json');

function eligible(c) {
  return (FIX.test(c.subject) || FEAT.test(c.subject)) && !EXCLUDED_SUBJECT.test(c.subject)
    && c.files.some((f) => f.path.startsWith('mealie/')) && mealie.backendTests(c).length > 0 && mealie.largeCounts(c).lines <= MAX_LINES;
}

function pools(commits) {
  const used = new Set([...mealie.earlierItems(path.join(__dirname, '..', '..')), ...Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'mealie4', '_tools', 'selection.json'), 'utf8')).accepted).map((a) => a.sha)]);
  const ok = commits.filter(eligible);
  const migration = ok.filter((c) => c.files.some(MIGRATION_FILE));
  const inMigration = new Set(migration.map((c) => c.sha));
  const authorization = ok.filter((c) => !inMigration.has(c.sha) && AUTHZ.test(c.subject) && !NOT_AUTHZ.test(c.subject));
  const inAuth = new Set(authorization.map((c) => c.sha));
  const free = (c) => !inMigration.has(c.sha) && !inAuth.has(c.sha);
  const ambiguous = ok.filter((c) => FEAT.test(c.subject) && free(c) && !used.has(c.sha));
  const ambiguousExpansion = [...ok.filter((c) => FEAT.test(c.subject) && free(c) && used.has(c.sha)), ...ok.filter((c) => FIX.test(c.subject) && free(c))];
  const draw = (list) => lib.shuffle(list, bench.mulberry32(42)).map((c) => c.sha);
  // The expansion keeps its order (earlier-suite features, then fixes), each part shuffled.
  const expansion = [...draw(ambiguousExpansion.filter((c) => FEAT.test(c.subject))), ...draw(ambiguousExpansion.filter((c) => FIX.test(c.subject)))];
  return { migration: draw(migration), authorization: draw(authorization), ambiguous: [...draw(ambiguous), ...expansion] };
}

function main(argv) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const take = argv.includes('--take') ? Number(argv[argv.indexOf('--take') + 1]) : TAKE;
  const mirror = lib.mealieMirror();
  const commits = lib.commitsIn(mirror, WINDOW).filter((c) => c.parent && !c.merge);
  for (const c of commits) {
    c.numstat = spawnSync('git', ['--git-dir', mirror, 'diff', '--numstat', c.parent, c.sha], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\n').filter(Boolean).map((l) => {
      const [a, d, ...p] = l.split('\t');
      return { path: p.join('\t'), lines: (Number(a) || 0) + (Number(d) || 0) };
    });
  }
  const byId = new Map(commits.map((c) => [c.sha, c]));
  const prior = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  const selection = { window: WINDOW, seed: 42, take, maxLines: MAX_LINES, rules: { authz: AUTHZ.source, notAuthz: NOT_AUTHZ.source, excludedSubject: EXCLUDED_SUBJECT.source }, pools: pools(commits), accepted: (prior && prior.accepted) || {}, skipped: (prior && prior.skipped) || [] };
  const save = () => fs.writeFileSync(OUT, `${JSON.stringify(selection, null, 1)}\n`);
  save();
  for (const [category, pool] of Object.entries(selection.pools)) {
    if (only && only !== category) continue;
    selection.accepted[category] = selection.accepted[category] || [];
    for (const sha of pool) {
      if (selection.accepted[category].length >= take) break;
      if (selection.accepted[category].some((a) => a.sha === sha) || selection.skipped.some((s) => s.sha === sha && s.category === category)) continue;
      const c = byId.get(sha);
      process.stderr.write(`select: ${category} candidate ${sha.slice(0, 8)} ${c.subject}\n`);
      let t;
      try {
        t = mealie.trees(c);
        const backend = mealie.validateBackend(c, t);
        selection.accepted[category].push({ sha, parent: c.parent, subject: c.subject, lines: mealie.largeCounts(c).lines, files: c.files.filter((f) => !mealie.NOT_COUNTED.test(f.path)).map((f) => f.path), hidden: t.hidden, backend });
        process.stderr.write(`select: ${category} accepted ${sha.slice(0, 8)} (${selection.accepted[category].length}/${take})\n`);
      } catch (e) {
        selection.skipped.push({ category, sha, subject: c.subject, reason: String(e.message).split('\n')[0] });
        process.stderr.write(`select: ${category} skipped ${sha.slice(0, 8)}: ${String(e.message).split('\n')[0]}\n`);
      } finally {
        if (t) t.cleanup();
      }
      save();
    }
  }
  save();
  process.stdout.write(Object.entries(selection.accepted).map(([k, v]) => `${k}: ${v.length} accepted of ${selection.pools[k].length} in the pool`).join('\n') + `\n${selection.skipped.length} skipped\n`);
}

module.exports = { WINDOW, TAKE, MAX_LINES, AUTHZ, NOT_AUTHZ, eligible, pools };

if (require.main === module) main(process.argv.slice(2));
