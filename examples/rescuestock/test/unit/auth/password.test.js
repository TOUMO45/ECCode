// Unit tests for src/auth/password.js. FU-6: the verifier accepts exactly the format scripts/seed.js writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword as seedHash } from '../../../scripts/seed.js';
import { SCRYPT, getDummyHash, hashPassword, parseHash, verifyAgainstDummy, verifyPassword } from '../../../src/auth/password.js';

const FORMAT = /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/;

test('FU-6: a hash written by scripts/seed.js verifies, and a wrong password does not', async () => {
  const stored = seedHash('correct horse battery');
  assert.match(stored, FORMAT);
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('correct horse batterz', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('FU-6: hashPassword writes the seed format (N=16384, r=8, p=1, 16-byte salt, 64-byte key) and the seed verifies it', async () => {
  assert.deepEqual({ N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keyLen: SCRYPT.keyLen, saltLen: SCRYPT.saltLen }, { N: 16384, r: 8, p: 1, keyLen: 64, saltLen: 16 });
  const stored = await hashPassword('another passphrase');
  assert.match(stored, FORMAT);
  assert.notEqual(stored, await hashPassword('another passphrase'), 'a fresh salt per hash');
  assert.equal(await verifyPassword('another passphrase', stored), true);
});

test('FU-6: the dummy hash used for unknown users has the same format and parameters', async () => {
  const dummy = await getDummyHash();
  assert.match(dummy, FORMAT);
  assert.equal(await getDummyHash(), dummy, 'built once');
  assert.ok(parseHash(dummy));
  assert.equal(await verifyAgainstDummy('anything'), false);
});

test('ARCH-25: malformed, foreign or differently parameterised hashes are false, never an exception or a custom cost', async () => {
  const good = seedHash('pw-for-malformed-test');
  const [, , r, p, salt, key] = good.split('$');
  const bad = [
    '',
    'plain-text',
    'scrypt$16384$8$1$$',
    `scrypt$16384$8$1$${salt}`,
    `scrypt$32768$8$1$${salt}$${key}`,
    `scrypt$16384$${r}$2$${salt}$${key}`,
    `scrypt$1048576$8$1$${salt}$${key}`,
    `bcrypt$16384$8$${p}$${salt}$${key}`,
    `scrypt$16384$8$1$${salt}$${key.slice(0, 40)}`,
    `scrypt$16384$8$1$${salt}!$${key}`,
    `${good}$extra`,
    'x'.repeat(5000),
    null,
    undefined,
    42,
  ];
  for (const stored of bad) assert.equal(await verifyPassword('pw-for-malformed-test', stored), false, String(stored).slice(0, 40));
  assert.equal(await verifyPassword(undefined, good), false);
  assert.equal(await verifyPassword('x'.repeat(2000), good), false, 'an oversize password is refused, not hashed');
  assert.equal(parseHash(good).key.length, 64);
});

test('ARCH-25: hashPassword refuses a non-string or oversize password with a TypeError', async () => {
  await assert.rejects(() => hashPassword(undefined), TypeError);
  await assert.rejects(() => hashPassword('y'.repeat(1025)), TypeError);
});
