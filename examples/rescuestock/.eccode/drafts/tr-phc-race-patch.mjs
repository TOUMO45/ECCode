// technical-reviewer helper: makes tr-phc-race.mjs send customer 1's same-key pair LAST in even rounds, so the pair
// also loses the race sometimes (then both of its answers must be 409 OUT_OF_STOCK, the second a replay).
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.eccode/drafts/tr-phc-race.mjs';
let text = readFileSync(file, 'utf8');
const from = `    const answers = await Promise.all([
      send(customers[0].c, customers[0].plan.id, k(0)),
      send(customers[0].other, customers[0].plan.id, k(0)),
      send(customers[1].c, customers[1].plan.id, k(1)),
      send(customers[2].c, customers[2].plan.id, k(2)),
      send(customers[3].c, customers[3].plan.id, k(3)),
    ]);`;
const to = `    const pairLast = round % 2 === 0;
    const jobs = [
      () => send(customers[0].c, customers[0].plan.id, k(0)),
      () => send(customers[0].other, customers[0].plan.id, k(0)),
      () => send(customers[1].c, customers[1].plan.id, k(1)),
      () => send(customers[2].c, customers[2].plan.id, k(2)),
      () => send(customers[3].c, customers[3].plan.id, k(3)),
    ];
    const order = pairLast ? [2, 3, 4, 0, 1] : [0, 1, 2, 3, 4];
    const started = [];
    for (const i of order) {
      started[i] = jobs[i]();
      if (pairLast && i === 4) await new Promise((r) => setTimeout(r, 15));
    }
    const answers = await Promise.all(started);`;
if (!text.includes(from)) { console.error('pattern not found'); process.exit(1); }
text = text.replace(from, to);
writeFileSync(file, text);
console.log('patched');
