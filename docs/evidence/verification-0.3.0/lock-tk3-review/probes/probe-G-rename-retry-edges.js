'use strict';
// Probe G (reviewer, round 2): writeFileAtomic's rename retry at the edges.
//  G1. The target directory vanishes between the temp write and the rename.
//  G2. The first rename lands but is reported as EPERM (a same-volume
//      MoveFileEx cannot do this; the probe shows what the retry would do).
//  G3. Success path: no temp file left; bound: attempts and elapsed for retryMs=200.
const path = require('path');
const fs = require('fs');
const os = require('os');
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const { writeFileAtomic } = require(path.join(root, 'lib', 'util'));
const REAL_RENAME = fs.renameSync;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-probeG-'));
const tmps = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.tmp')) : '(dir gone)');

// G1
{
  const dir = path.join(base, 'g1');
  const file = path.join(dir, 'state.json');
  let n = 0;
  fs.renameSync = (from, to) => {
    if (to === file && ++n === 1) fs.rmSync(dir, { recursive: true, force: true }); // directory vanishes under us
    return REAL_RENAME.call(fs, from, to);
  };
  const started = Date.now();
  try {
    writeFileAtomic(file, 'x');
    console.log('G1: landed (unexpected)');
  } catch (err) {
    console.log(`G1: threw ${err.code} (${err.syscall}) after ${Date.now() - started}ms, ${n} rename attempt(s); temp files: ${JSON.stringify(tmps(dir))}`);
  }
  fs.renameSync = REAL_RENAME;
}

// G2
{
  const dir = path.join(base, 'g2');
  const file = path.join(dir, 'state.json');
  let n = 0;
  fs.renameSync = (from, to) => {
    if (to === file && ++n === 1) {
      REAL_RENAME.call(fs, from, to); // the rename actually lands...
      const e = new Error('EPERM: mocked rename reported after success');
      e.code = 'EPERM';
      e.syscall = 'rename';
      throw e; // ...but is reported as refused
    }
    return REAL_RENAME.call(fs, from, to);
  };
  const started = Date.now();
  try {
    writeFileAtomic(file, 'x');
    console.log('G2: returned normally');
  } catch (err) {
    console.log(`G2: threw ${err.code} (${err.syscall}) after ${Date.now() - started}ms, ${n} attempts; target content: ${fs.existsSync(file) ? JSON.stringify(fs.readFileSync(file, 'utf8')) : '(missing)'}; temp files: ${JSON.stringify(tmps(dir))}`);
  }
  fs.renameSync = REAL_RENAME;
}

// G3
{
  const dir = path.join(base, 'g3');
  const file = path.join(dir, 'state.json');
  writeFileAtomic(file, 'first');
  writeFileAtomic(file, 'second');
  console.log(`G3a: success path leaves temp files: ${JSON.stringify(tmps(dir))}; content ${JSON.stringify(fs.readFileSync(file, 'utf8'))}`);
  let n = 0;
  fs.renameSync = (from, to) => {
    if (to === file) {
      n++;
      const e = new Error('EBUSY: mocked');
      e.code = 'EBUSY';
      e.syscall = 'rename';
      throw e;
    }
    return REAL_RENAME.call(fs, from, to);
  };
  const started = Date.now();
  try {
    writeFileAtomic(file, 'third', { retryMs: 200 });
  } catch (err) {
    console.log(`G3b: retryMs=200 gave up after ${Date.now() - started}ms and ${n} attempts with ${err.code}; content still ${JSON.stringify(fs.readFileSync(file, 'utf8'))}; temp files: ${JSON.stringify(tmps(dir))}`);
  }
  fs.renameSync = REAL_RENAME;
}
