// Child-side probe for the node-proc tests: prints what this process was started with.
import { guardInstalled } from './net-guard.js';

process.stdout.write(
  `${JSON.stringify({
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    testContext: process.env.NODE_TEST_CONTEXT ?? null,
    guard: guardInstalled(),
    argv: process.argv.slice(2),
    pick: process.env.RS_PROBE ?? null,
  })}\n`,
);
