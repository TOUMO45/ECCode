#!/usr/bin/env node
'use strict';
// A6: ECCode's bug rules on the diff of every first-parent commit of a range.
// Each commit becomes a small scratch repo (its changed files at the parent,
// committed, then at the commit), and `bugs.scan` runs on the change, with the
// external analyzers that are installed. Every hit gets an id for the hand
// labels (labels/bugs.json: real defect, intentional, false positive).
// usage: node a6-bugs.js <range>
const lib = require('../lib');
const bugs = require('../../../lib/bugs');
const { scratchRepo } = require('./scratch');
const fs = require('fs');
const path = require('path');

/** Added lines of one file: its Set from bugs.addedLines, or every line when the file is new (null). */
function addedCount(root, file, lines) {
  if (lines) return lines.size;
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function main(argv) {
  const range = argv[0];
  if (!range) throw new Error('usage: a6-bugs.js <range>');
  const mirror = lib.mealieMirror();
  const commits = lib.commitsIn(mirror, range).filter((c) => c.parent && !c.merge);
  let changedLines = 0;
  const out = lib.replay(commits, (c) => {
    const s = scratchRepo(mirror, c, { full: false });
    try {
      const res = bugs.scan(s.root, { base: s.base });
      let added = 0;
      for (const [file, lines] of bugs.addedLines(s.root, s.base) || []) if (bugs.isCode(file)) added += addedCount(s.root, file, lines);
      changedLines += added;
      return { sha: c.sha, subject: c.subject, added, analyzers: res.analyzers.map((a) => ({ tool: a.tool, ran: a.ran })), hits: res.findings.map((f) => ({ id: `${c.sha}:${f.file}:${f.line}:${f.rule}`, sha: c.sha, file: f.file, line: f.line, rule: f.rule, severity: f.severity, text: String(f.message || '').slice(0, 200) })) };
    } finally {
      s.cleanup();
    }
  });
  const hits = out.results.flatMap((r) => r.hits);
  const result = { range, commits: commits.length, skipped: out.skipped, changedLines, hits, hitsPerTenK: changedLines ? (hits.length / changedLines) * 10000 : null, analyzers: [...new Set(out.results.flatMap((r) => r.analyzers.filter((a) => a.ran).map((a) => a.tool)))] };
  const file = lib.writeResult('a6-bugs', result, process.env.ECCODE_PILOT_RESULTS || lib.RESULTS);
  process.stdout.write(`${file}\n${JSON.stringify({ commits: result.commits, changedLines, hits: hits.length, hitsPerTenK: result.hitsPerTenK, analyzers: result.analyzers, skipped: out.skipped.length })}\n`);
}

module.exports = { addedCount };

if (require.main === module) main(process.argv.slice(2));
