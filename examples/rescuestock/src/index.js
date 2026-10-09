// Entry point. Second line of defence for the Node floor: the npm scripts run
// scripts/check-node.cjs first, but `node src/index.js` can be run directly.
// This file has no static imports, so nothing (in particular node:sqlite) is
// loaded before the check has passed.
const FLOOR = [22, 13, 0];

function meetsFloor(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (v[i] > FLOOR[i]) return true;
    if (v[i] < FLOOR[i]) return false;
  }
  return true;
}

if (!meetsFloor(process.versions.node)) {
  process.stderr.write(`RescueStock needs Node >= 22.13 (found ${process.versions.node}). See README.\n`);
  process.exit(1);
}

try {
  await import('node:sqlite');
} catch {
  process.stderr.write(
    `RescueStock needs the node:sqlite module, which this Node (${process.versions.node}) does not load. Try the --experimental-sqlite flag. See README.\n`,
  );
  process.exit(1);
}

const { main } = await import('./main.js');
await main();
