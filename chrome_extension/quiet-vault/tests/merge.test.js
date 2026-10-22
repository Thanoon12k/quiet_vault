import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEntries, validateEntries } from '../src/merge.js';
const record = (id, version, value = 'secret') => ({ id, version, value, name: id, kind: 'Secret', deleted: false, updatedAt: '2026-10-21' });
test('different devices editing different items merge', () => {
  const result = mergeEntries([record('a', 'a2'), record('b', 'b1')], [record('b', 'b2')], { b: { baseVersion: 'b1' } });
  assert.equal(result.conflicts, 0);
  assert.deepEqual(result.entries.map(x => x.version), ['a2', 'b2']);
});
test('conflicting edits keep both values and retries do not duplicate conflict copies', () => {
  const local = record('a', 'local-version', 'ours');
  const result = mergeEntries([record('a', 'remote-version', 'theirs')], [local], { a: { baseVersion: 'old' } });
  assert.equal(result.conflicts, 1);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries.map(x => x.value), ['theirs', 'ours']);
  assert.match(result.entries[1].name, /conflict copy/);
  const retry = mergeEntries(result.entries, [local], { a: { baseVersion: 'old' } });
  assert.equal(retry.entries.length, 2);
  assert.equal(retry.conflicts, 0);
});
test('offline delete cannot erase a conflicting edit', () => {
  const result = mergeEntries([record('a', 'remote')], [{ ...record('a', 'deleted'), deleted: true }], { a: { baseVersion: 'old' } });
  assert.equal(result.entries[0].deleted, false);
  assert.equal(result.conflicts, 1);
});
test('successful write with a lost response is safe to retry', () => {
  const local = record('a', 'version');
  const result = mergeEntries([local], [local], { a: { baseVersion: null } });
  assert.equal(result.entries.length, 1);
  assert.equal(result.conflicts, 0);
});
test('duplicate IDs and malformed entries are rejected', () => {
  assert.throws(() => validateEntries([record('a', '1'), record('a', '2')]));
  assert.throws(() => validateEntries([{ name: 'wrong' }]));
});
