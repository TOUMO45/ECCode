'use strict';
// One benchmark run on a worker thread (lib/bench.js runBatch, concurrency 2):
// the run itself is synchronous (the agent is a child process the thread
// waits on), so each slot is a thread of its own. It reports the sandbox as
// soon as it exists (so a killed batch knows what it cut) and the record when
// the run is graded.
const { parentPort, workerData } = require('worker_threads');
const bench = require('./bench');

const { task, options } = workerData;
const record = bench.runOnce(task, { ...options, onStarted: (info) => parentPort.postMessage({ type: 'started', ...info }) });
parentPort.postMessage({ type: 'record', record });
