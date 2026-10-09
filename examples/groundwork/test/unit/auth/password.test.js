import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, parseHash, DUMMY_HASH } from '../../../src/auth/password.js';

test('hash format is scrypt$N$r$p$salt$hash and salts differ', async () => {
  const a = await hashPassword('correct-horse-1');
  const b = await hashPassword('correct-horse-1');
  assert.match(a, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(a, b);
  assert.equal(parseHash(a).hash.length, 64);
});

test('verify accepts the right password and rejects others', async () => {
  const h = await hashPassword('correct-horse-1');
  assert.equal(await verifyPassword('correct-horse-1', h), true);
  assert.equal(await verifyPassword('correct-horse-2', h), false);
  assert.equal(await verifyPassword('', h), false);
});

test('malformed or hostile stored hashes verify false without throwing', async () => {
  for (const bad of [null, undefined, '', 'x', 'scrypt$1$2', 'bcrypt$16384$8$1$AAAA$BBBB',
    'scrypt$16384$8$1$AAAAAAAAAAA=$AA==', 'scrypt$3$8$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA',
    'scrypt$1073741824$32$16$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA']) {
    assert.equal(await verifyPassword('anything', bad), false, String(bad));
  }
});

test('dummy hash is well formed and never matches', async () => {
  assert.notEqual(parseHash(DUMMY_HASH), null);
  assert.equal(await verifyPassword('anything', DUMMY_HASH), false);
});

test('hashPassword refuses empty input', async () => {
  await assert.rejects(() => hashPassword(''), TypeError);
});
