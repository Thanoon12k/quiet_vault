import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, unlockVault, seal, open, rewrapVault } from '../src/crypto.js';

const owner = '11111111-1111-4111-8111-111111111111';
const password = 'a very long test passphrase';
test('real encryption round-trip, random nonces, nonexportable keys, and encrypted metadata', async () => {
  const { key, row } = await createVault(owner, password);
  assert.equal(key.extractable, false);
  const payload = { entries: [{ name: 'Private key label', value: 'test-secret-value' }] };
  const first = await seal(key, owner, payload);
  const second = await seal(key, owner, payload);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(await open(key, owner, first), payload);
  const unlocked = await unlockVault(owner, password, row);
  assert.deepEqual(await open(unlocked, owner, first), payload);
  assert.ok(!JSON.stringify({ row, first }).includes('test-secret-value'));
  await assert.rejects(crypto.subtle.exportKey('raw', unlocked));
});
test('wrong password, changed account, changed purpose, and tampering all fail closed', async () => {
  const { key, row } = await createVault(owner, password);
  await assert.rejects(unlockVault(owner, 'a different master password', row));
  await assert.rejects(unlockVault('another-account', password, row));
  await assert.rejects(open(key, owner, row, 'cache'));
  await assert.rejects(open(key, 'another-account', row));
  const modified = { ...row, ciphertext: (row.ciphertext[0] === 'A' ? 'B' : 'A') + row.ciphertext.slice(1) };
  await assert.rejects(open(key, owner, modified));
  await assert.rejects(unlockVault(owner, password, { ...row, iterations: 1 }));
});
test('creation rejects short master passwords', async () => {
  await assert.rejects(createVault(owner, 'short'), /12 characters/);
});

test('managed migration keeps the same data key and existing backups', async () => {
  const { key, row } = await createVault(owner, password);
  const cache = await seal(key, owner, { entries: [{ name: 'old item', value: 'kept' }] }, 'cache');
  const secret = 'a'.repeat(43) + '=';
  const updated = { ...row, ...await rewrapVault(owner, password, secret, row) };
  const reopened = await unlockVault(owner, secret, updated);
  assert.deepEqual(await open(reopened, owner, row), { entries: [] });
  assert.equal((await open(reopened, owner, cache, 'cache')).entries[0].value, 'kept');
  await assert.rejects(unlockVault(owner, password, updated));
  await assert.rejects(rewrapVault(owner, 'wrong', secret, row));
});
