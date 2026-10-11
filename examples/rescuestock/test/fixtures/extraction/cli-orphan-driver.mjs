// Driver for the cli.test.js process-lifetime tests (TR-D-9, SEC-D-2 reproduction C7 inverted). It never contacts a model:
// the `claude` it spawns is the stub wrapper in the bin directory it is given.
//   node cli-orphan-driver.mjs <binDir> <tmpDir> <exit|sigterm-wait>
// It starts one extraction call against the stub in "hang" mode, prints "ready" once the stub child is running, then
//   exit          calls process.exit(0) at once (what main.js stop() does) and relies on the adapter's exit hook;
//   sigterm-wait  keeps running with the default SIGTERM disposition (the test kills it from outside).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCliProvider } from '../../../src/ai/cli.js';

const [binDir, tmpDir, action] = process.argv.slice(2);
const provider = createCliProvider({
  command: join(binDir, 'claude'), // SEC-D-17: the stub's absolute path; PATH is the stub directory alone
  env: { PATH: binDir, HOME: tmpDir, TMPDIR: tmpDir, LANG: 'C.UTF-8' },
  tmpRoot: tmpDir,
  timeoutMs: 120_000,
});
provider.extract({ text: 'two cups', image: null }).catch(() => {});
const started = Date.now();
const poll = setInterval(() => {
  if (existsSync(join(tmpDir, 'child.pid')) && existsSync(join(tmpDir, 'grandchild.pid'))) {
    clearInterval(poll);
    process.stdout.write('ready\n');
    if (action === 'exit') setTimeout(() => process.exit(0), 20);
  } else if (Date.now() - started > 20_000) {
    process.stderr.write('stub child never started\n');
    process.exit(3);
  }
}, 20);
