'use strict';
// The three readings of the Mealie rerun (its protocol, amendment 1), as runs
// directories bench/pilot/analyse.js reads:
//   registered   the primary reading: for each process the restart cut, the
//                file bench/pilot/resume.js wrote under registered/ (cut runs
//                are failures, a dead chain's remaining items are not
//                delivered); every other process as it ran;
//   sensitivity  the registered reading without the runs that have no result
//                line or zero turns (the pilot's sensitivity rule);
//   continued    the batch files as they stand: each chain continued on its
//                surviving sandbox, each unstarted run run once.
// Each holds links to the batch's transcript directories (tr-<process>).
// usage: node bench/pilot/readings.js <batch dir>   (prints the three directories)
const fs = require('fs');
const path = require('path');

const PROCESSES = ['b1', 'b2', 'b3', 'b4', 'c1', 'c2'];

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const started = (r) => r.type || (r.usage && r.usage.turns !== 0);

function readings(batch) {
  const out = { registered: path.join(batch, 'reading-registered'), sensitivity: path.join(batch, 'reading-sensitivity'), continued: path.join(batch, 'reading-continued') };
  for (const dir of Object.values(out)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
  }
  for (const p of PROCESSES) {
    const own = path.join(batch, `${p}.jsonl`);
    if (!fs.existsSync(own)) continue;
    const reg = path.join(batch, 'registered', `${p}.jsonl`);
    const registered = lines(fs.existsSync(reg) ? reg : own);
    const write = (dir, rows) => fs.writeFileSync(path.join(dir, `${p}.jsonl`), rows.map((r) => JSON.stringify(r) + '\n').join(''));
    write(out.registered, registered);
    write(out.sensitivity, registered.filter(started));
    write(out.continued, lines(own));
    const tr = path.join(batch, `tr-${p}`);
    if (fs.existsSync(tr)) for (const dir of Object.values(out)) fs.symlinkSync(path.resolve(tr), path.join(dir, `tr-${p}`), 'dir');
  }
  return out;
}

module.exports = { readings };

if (require.main === module) {
  if (!process.argv[2]) {
    process.stderr.write('usage: node bench/pilot/readings.js <batch dir>\n');
    process.exit(2);
  }
  for (const [name, dir] of Object.entries(readings(path.resolve(process.argv[2])))) process.stdout.write(`${name}\t${dir}\n`);
}
