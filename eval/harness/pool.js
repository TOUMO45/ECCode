'use strict';
// Tiny job pool for running trial processes concurrently.

const { spawn } = require('child_process');
const path = require('path');

const RUN_TRIAL = path.join(__dirname, 'run-trial.js');

/** Run run-trial.js with args; resolves with its last JSON stdout line (or an error object). */
function runTrial(args, logFile) {
  const fs = require('fs');
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [RUN_TRIAL, ...args], { stdio: ['ignore', 'pipe', out] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      fs.appendFileSync(logFile, d);
    });
    child.on('exit', (code) => {
      const line = buf.trim().split('\n').pop();
      try {
        resolve({ code, ...JSON.parse(line) });
      } catch {
        resolve({ code, error: `run-trial exited ${code}` });
      }
    });
  });
}

async function pool(jobs, parallel, onDone = () => {}) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
      onDone(results[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  return results;
}

function argv(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

module.exports = { runTrial, pool, argv };
