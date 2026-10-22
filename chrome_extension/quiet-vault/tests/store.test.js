import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, readCache } from '../src/store.js';
import { open } from '../src/crypto.js';

class MemoryStorage {
  values = new Map(); full = false;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.full) throw new Error('Storage full'); this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
function backend() {
  let row = null; let online = true; let miss = false;
  return {
    setOnline(value) { online = value; },
    setMiss(value) { miss = value; },
    get row() { return structuredClone(row); },
    from() {
      return {
        select() { return { eq() { return { async maybeSingle() {
          if (!online) throw new Error('Network unavailable');
          return { data: structuredClone(row), error: null };
        } }; } }; },
        insert(next) { return { select() { return { async single() {
          if (!online) throw new Error('Network unavailable');
          if (row) return { data: null, error: { code: '23505' } };
          row = structuredClone(next); return { data: structuredClone(row), error: null };
        } }; } }; }
      };
    },
    async rpc(name, args) {
      if (!online) throw new Error('Network unavailable');
      if (miss) { miss = false; row.revision++; return { data: [], error: null }; }
      if (args.expected_revision !== row.revision) return { data: [], error: null };
      row = { ...row, ciphertext: args.new_ciphertext, nonce: args.new_nonce, revision: row.revision + 1 };
      return { data: [structuredClone(row)], error: null };
    }
  };
}
const owner = '11111111-1111-4111-8111-111111111111';
const password = 'a sufficiently long master password';
const input = value => ({ name: 'Very private name', value, kind: 'API key' });

test('offline save/edit/restart, encrypted cache, and later sync retain the right baseline', async () => {
  globalThis.localStorage = new MemoryStorage(); const server = backend();
  const first = new Vault(server, owner); await first.initialize(password, true);
  server.setOnline(false);
  const item = await first.save(input('first-value'));
  await first.save(input('updated-secret-value'), item.id);
  assert.equal(first.pending[item.id].baseVersion, null);
  const stored = JSON.stringify([...localStorage.values.values()]);
  assert.ok(!stored.includes('updated-secret-value')); assert.ok(!stored.includes('Very private name')); assert.ok(!stored.includes(password));
  await assert.rejects(first.sync()); first.lock();
  const reopened = new Vault(server, owner); await reopened.initialize(password, false);
  assert.equal(reopened.entries[0].value, 'updated-secret-value');
  server.setOnline(true); server.setMiss(true);
  const synced = await reopened.sync(); assert.equal(synced.conflicts, 0);
  assert.deepEqual(reopened.pending, {});
  assert.equal((await open(reopened.key, owner, server.row)).entries[0].value, 'updated-secret-value');
});
test('two devices, concurrent changes, delete conflicts, and restore preserve data', async () => {
  globalThis.localStorage = new MemoryStorage(); const server = backend();
  const a = new Vault(server, owner); await a.initialize(password, true);
  const item = await a.save(input('original')); await a.sync();
  const b = new Vault(server, owner); await b.initialize(password, false);
  await a.save(input('device-a-value'), item.id); await a.sync();
  await b.save(input('device-b-value'), item.id); const merged = await b.sync();
  assert.equal(merged.conflicts, 1); assert.equal(b.entries.filter(x => !x.deleted).length, 2);
  const backup = { app: 'quiet-vault', backupVersion: 1, owner, ...readCache(owner) };
  await b.remove(item.id); await b.sync();
  assert.equal(await b.restore(backup), 1);
  assert.equal(b.entries.filter(x => !x.deleted).length, 2);
  await assert.rejects(b.restore({ ...backup, owner: 'wrong-account' }));
});
test('quota failure rolls back an edit and locking drops keys', async () => {
  globalThis.localStorage = new MemoryStorage(); const server = backend();
  const vault = new Vault(server, owner); await vault.initialize(password, true);
  const item = await vault.save(input('safe-value'));
  localStorage.full = true;
  await assert.rejects(vault.save(input('lost-value'), item.id), /Storage full/);
  assert.equal(vault.entries[0].value, 'safe-value');
  localStorage.full = false; vault.lock();
  assert.equal(vault.key, null); assert.deepEqual(vault.entries, []);
  await assert.rejects(vault.save(input('cannot-save')), /locked/);
});
