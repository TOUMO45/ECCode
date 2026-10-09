import { test } from 'node:test';
test('probe', () => {
  console.log('EXECARGV', JSON.stringify(process.execArgv), 'NODE_OPTIONS=', process.env.NODE_OPTIONS);
  console.log('GUARD', typeof globalThis[Symbol.for('rescuestock.netGuard')]);
});
