// Optional launcher of the opt-in live PayPal Sandbox suite, giving ONE clean exit code 2 for the whole run. It is NOT wired into
// package.json: test/unit/config/node-version.test.js pins the test:live-paypal line to the spec's `node --test` form, under which
// each file refuses by itself (exit 2) and node:test reports the run as failed (exit 1). To use the launcher, change that line and
// that test together. It refuses (exit 2, a named message on stderr,
// nothing on stdout, no network) unless RS_LIVE_PAYPAL=1 and the PayPal Sandbox credentials are present (live-support.js
// evaluateLiveLaunch), and only then runs the test files under node:test, one at a time. The exit code of the run is the exit
// code of node:test (0 all passed, 1 a failure). Every test file refuses on its own too, so running one directly is safe.
//
//   node test/live/paypal/run-live-paypal.js "test/live/paypal/**/*.test.js"
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateLiveLaunch } from './live-support.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_PATTERN = 'test/live/paypal/**/*.test.js';

/** -> exit code. `spawnTests(patterns)` is injectable; it must not be called when the launch is refused. */
export async function runLivePaypal({
  env = process.env,
  argv = process.argv.slice(2),
  err = (s) => process.stderr.write(s),
  guardInstalled,
  spawnTests = (patterns) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', ...patterns], { cwd: ROOT, stdio: 'inherit', env });
    child.once('error', (e) => {
      err(`could not start the live suite: ${e.message}\n`);
      resolve(1);
    });
    child.once('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  }),
} = {}) {
  const launch = guardInstalled === undefined ? evaluateLiveLaunch(env) : evaluateLiveLaunch(env, { guardInstalled });
  if (!launch.ok) {
    err(`${launch.message}\n`);
    return 2;
  }
  return spawnTests(argv.length > 0 ? argv : [DEFAULT_PATTERN]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLivePaypal().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`live PayPal suite failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}
