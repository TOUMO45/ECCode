#!/usr/bin/env node
'use strict';
// S4-PREREQ D-2 / plan P-4 (ECCode side): count human interventions by type from an ECCode event record alone.
// usage: node tools/count-interventions.js <events.jsonl | project root>   -> JSON on stdout
// Automated approvals (type "auto-approval") are reported apart and never counted. The bare arm has no event record;
// its count comes from its transcript (not handled here).
const fs = require('fs');
const path = require('path');
const { count } = require('../lib/greenfield/interventions');

const arg = process.argv[2];
if (!arg) { process.stderr.write('usage: count-interventions.js <events.jsonl | project root>\n'); process.exit(1); }
let file = path.resolve(arg);
if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, '.eccode', 'events.jsonl');
const log = [];
let bad = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { log.push(JSON.parse(line)); } catch { bad += 1; }
}
const out = count(log);
process.stdout.write(`${JSON.stringify({ file, events: log.length, unparsedLines: bad, ...out }, null, 2)}\n`);
