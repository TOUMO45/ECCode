'use strict';
// Shared helpers of the pilot's model-free measurements (Part A): trees and
// commits from the bench mirror, seeded draws, recall and precision, replays
// that record what they skip, and results written with local paths hidden.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const bench = require('../../lib/bench');

/** The tree of `commit` (no history) into dest, from the bench mirror. */
function treeAt(repoUrl, commit, dest) {
  fs.mkdirSync(dest, { recursive: true });
  bench.exportSource({ repo: repoUrl, commit }, dest);
  return dest;
}

/**
 * The commits of `range` along the first-parent line, oldest first, each with
 * its files against its first parent. A merge is marked, not expanded.
 */
function commitsIn(mirror, range) {
  const out = execFileSync('git', ['--git-dir', mirror, 'log', '--reverse', '--first-parent', '--diff-merges=first-parent', '--name-status', '--format=@@%H%x09%P%x09%s', range], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const commits = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) {
      const [sha, parents, ...subject] = line.slice(2).split('\t');
      const ps = parents.split(' ').filter(Boolean);
      commits.push({ sha, parent: ps[0] || null, subject: subject.join('\t'), merge: ps.length > 1, files: [] });
    } else if (line.trim() && commits.length) {
      const [status, ...paths] = line.split('\t');
      commits[commits.length - 1].files.push({ status: status[0], path: paths[paths.length - 1], ...(paths.length > 1 ? { from: paths[0] } : {}) });
    }
  }
  return commits;
}

/** A seeded shuffle (Fisher-Yates on the bench's PRNG). */
function shuffle(items, rand) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * k items drawn with `seed`. With `strata` (item -> key), every stratum gets
 * floor(k / strata) or more; a stratum too small for its share gives the rest
 * to the others, in key order, so the draw still has k items when it can.
 */
function sample(items, k, seed = 42, strata = null) {
  const rand = bench.mulberry32(seed);
  if (!strata) return shuffle(items, rand).slice(0, k);
  const groups = new Map();
  for (const it of items) {
    const key = strata(it);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const keys = [...groups.keys()].sort();
  const pools = new Map(keys.map((key) => [key, shuffle(groups.get(key), rand)]));
  const share = Math.floor(k / keys.length);
  const out = [];
  for (const key of keys) out.push(...pools.get(key).splice(0, share));
  while (out.length < k && keys.some((key) => pools.get(key).length)) {
    for (const key of keys) {
      if (out.length < k && pools.get(key).length) out.push(pools.get(key).shift());
    }
  }
  return out;
}

/** Recall and precision of `predicted` against `truth` (both Sets); null when undefined. */
function recallPrecision(predicted, truth) {
  let tp = 0;
  for (const x of predicted) if (truth.has(x)) tp += 1;
  return { recall: truth.size ? tp / truth.size : null, precision: predicted.size ? tp / predicted.size : null, tp, fp: predicted.size - tp, fn: truth.size - tp };
}

/** fn over every item; an item that throws is recorded as skipped with the first line of its error. */
function replay(items, fn) {
  const results = [];
  const skipped = [];
  items.forEach((item, i) => {
    try {
      results.push(fn(item));
    } catch (e) {
      skipped.push({ id: item.id || item.sha || String(i), reason: String((e && e.message) || e).split('\n')[0] });
    }
  });
  return { results, skipped };
}

const RESULTS = path.join(__dirname, 'mealie', 'results');

/** Write results/<name>.json, with local temporary and cache paths shown as <scratch> and <cache>. */
function writeResult(name, obj, dir = RESULTS) {
  let text = JSON.stringify(obj, null, 1);
  for (const [prefix, label] of [[path.join(os.homedir(), '.cache', 'eccode'), '<cache>'], [fs.realpathSync(os.tmpdir()), '<scratch>'], [os.tmpdir(), '<scratch>']]) {
    text = text.split(prefix).join(label);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, `${text}\n`);
  return file;
}

/** The median of numbers (null for none). */
function median(xs) {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const MEALIE = 'https://github.com/mealie-recipes/mealie.git';

/** The bench mirror of Mealie (cloned on first use). */
function mealieMirror() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mealie-probe-'));
  try {
    // exportSource clones the mirror when it is missing; a tiny path keeps it cheap.
    bench.exportPaths({ repo: MEALIE, commit: 'dbe84cc91b9e1dfc88b783a1e31d8a8495800337' }, ['LICENSE'], dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return path.join(bench.cacheDir(), 'github.com-mealie-recipes-mealie.git');
}

module.exports = { treeAt, commitsIn, sample, shuffle, recallPrecision, replay, writeResult, median, mealieMirror, MEALIE, RESULTS };
