// Probe: does `node --test "<glob>" <explicit file>` run a file twice when both name it?
import test from 'node:test';
test('one', () => { console.log('RAN-ONE'); });
