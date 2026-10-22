import { seal, open, createVault, unlockVault } from './crypto.js';
import { mergeEntries, validateEntries } from './merge.js';

const cacheKey = owner => `quiet-vault.cache.v1.${owner}`;
export const readCache = owner => {
  try { return JSON.parse(localStorage.getItem(cacheKey(owner)) || 'null'); }
  catch { throw new Error('Local vault cache is damaged. Your cloud vault has not been changed.'); }
};

export class Vault {
  constructor(client, owner) {
    this.client = client;
    this.owner = owner;
    this.entries = [];
    this.pending = {};
    this.key = null;
    this.row = null;
    this.tail = Promise.resolve();
    this.closed = false;
  }

  serial(task) {
    const result = this.tail.then(() => {
      if (this.closed) throw new Error('Vault is locked.');
      return task();
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async fetchRow() {
    const { data, error } = await this.client.from('quiet_vaults').select('*').eq('user_id', this.owner).maybeSingle();
    if (error) throw error;
    return data;
  }

  async initialize(password, isNew, options = {}) {
    const cached = readCache(this.owner);
    if (isNew) {
      const created = await createVault(this.owner, password);
      const { data, error } = await this.client.from('quiet_vaults').insert({ ...created.row, unlock_mode: options.mode ?? 'master' }).select().single();
      if (error) {
        if (error.code === '23505') throw new Error('A vault already exists. Go back and unlock it with its master password.');
        throw error;
      }
      this.key = created.key;
      this.row = data;
    } else {
      // Local encrypted pending changes must survive an offline restart.
      this.row = options.row ?? cached?.row ?? await this.fetchRow();
      if (!this.row) throw new Error('No vault found. Connect to the internet to create one.');
      try {
        this.key = await unlockVault(this.owner, password, this.row);
        if (cached) {
          const contents = await open(this.key, this.owner, cached.encrypted, 'cache');
          this.entries = validateEntries(contents.entries);
          if (!contents.pending || typeof contents.pending !== 'object' || Array.isArray(contents.pending)) throw new Error('Invalid pending changes.');
          this.pending = contents.pending;
        } else {
          const contents = await open(this.key, this.owner, this.row);
          this.entries = validateEntries(contents.entries);
        }
      } catch {
        this.lock();
        throw new Error(options.mode === 'managed' ? 'Could not open this encrypted vault. Reconnect and try again.' : 'Could not unlock. Check your master password. If it is correct, the encrypted data may be damaged.');
      }
    }
    await this.persist();
  }

  async persist() {
    const encrypted = await seal(this.key, this.owner, { entries: this.entries, pending: this.pending }, 'cache');
    if (this.closed) throw new Error('Vault is locked.');
    // Only ciphertext and key-wrapping metadata are persisted. Never plaintext.
    localStorage.setItem(cacheKey(this.owner), JSON.stringify({ row: this.row, encrypted }));
  }

  save(input, id) {
    return this.serial(async () => {
      const previous = this.entries;
      const previousPending = this.pending;
      const old = id ? this.entries.find(item => item.id === id && !item.deleted) : null;
      if (id && !old) throw new Error('This item no longer exists.');
      const record = { id: old?.id ?? crypto.randomUUID(), name: input.name.trim(), value: input.value,
        kind: input.kind, description: input.description ?? '', deleted: false, version: crypto.randomUUID(), updatedAt: new Date().toISOString() };
      if (!record.name || !record.value || record.name.length > 160 || record.value.length > 32000
        || typeof record.description !== 'string' || record.description.length > 2000
        || !['API key', 'Password', 'Variable', 'Secret'].includes(record.kind)) throw new Error('Enter a name and value (up to 32,000 characters).');
      this.entries = [...this.entries.filter(item => item.id !== record.id), record];
      this.pending = { ...this.pending, [record.id]: { baseVersion: Object.hasOwn(this.pending, record.id) ? this.pending[record.id].baseVersion : old?.version ?? null } };
      try { await this.persist(); }
      catch (error) { this.entries = previous; this.pending = previousPending; throw error; }
      return record;
    });
  }

  remove(id) {
    return this.serial(async () => {
      const old = this.entries.find(item => item.id === id && !item.deleted);
      if (!old) return;
      const previous = this.entries;
      const previousPending = this.pending;
      this.entries = this.entries.map(item => item.id === id ? { ...item, value: '', name: '', description: '', deleted: true,
        version: crypto.randomUUID(), updatedAt: new Date().toISOString() } : item);
      this.pending = { ...this.pending, [id]: { baseVersion: Object.hasOwn(this.pending, id) ? this.pending[id].baseVersion : old.version } };
      try { await this.persist(); }
      catch (error) { this.entries = previous; this.pending = previousPending; throw error; }
    });
  }

  sync() {
    return this.serial(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await this.fetchRow();
        if (!remote) throw new Error('Cloud vault not found. Local changes are still saved on this device.');
        // Rewrapping preserves the data key. Authenticate the payload before accepting metadata.
        const remoteContents = await open(this.key, this.owner, remote);
        validateEntries(remoteContents.entries);
        if (!Object.keys(this.pending).length) {
          const previous = this.entries;
          const previousRow = this.row;
          this.entries = remoteContents.entries;
          this.row = remote;
          try { await this.persist(); }
          catch (error) { this.entries = previous; this.row = previousRow; throw error; }
          return { conflicts: 0 };
        }
        const merged = mergeEntries(remoteContents.entries, this.entries, this.pending);
        const encrypted = await seal(this.key, this.owner, { entries: merged.entries });
        const { data, error } = await this.client.rpc('quiet_vault_save', {
          expected_revision: remote.revision, new_ciphertext: encrypted.ciphertext, new_nonce: encrypted.nonce
        });
        if (error) throw error;
        if (!data?.length) continue; // Another device won the compare-and-swap; merge again.
        const previous = { entries: this.entries, pending: this.pending, row: this.row };
        this.row = data[0];
        this.entries = merged.entries;
        this.pending = {};
        try { await this.persist(); }
        catch (error) { Object.assign(this, previous); throw error; }
        return { conflicts: merged.conflicts };
      }
      throw new Error('Another device is updating the vault. Your changes are safe locally; sync again shortly.');
    });
  }

  restore(backup) {
    return this.serial(async () => {
      if (backup?.app !== 'quiet-vault' || backup.backupVersion !== 1 || backup.owner !== this.owner) {
        throw new Error('This backup belongs to a different account or vault.');
      }
      const contents = await open(this.key, this.owner, backup.encrypted, 'cache');
      const imported = validateEntries(contents.entries);
      const previous = this.entries;
      const previousPending = this.pending;
      let count = 0;
      const additions = [];
      const pending = { ...this.pending };
      for (const item of imported) {
        if (item.deleted || this.entries.some(current => current.version === item.version)) continue;
        const exists = this.entries.some(current => current.id === item.id);
        const restored = { ...item, id: crypto.randomUUID(), version: crypto.randomUUID(),
          name: item.name + (exists ? ' (restored copy)' : ''), updatedAt: new Date().toISOString() };
        additions.push(restored); pending[restored.id] = { baseVersion: null }; count++;
      }
      this.entries = [...this.entries, ...additions]; this.pending = pending;
      try { await this.persist(); }
      catch (error) { this.entries = previous; this.pending = previousPending; throw error; }
      return count;
    });
  }

  lock() {
    this.closed = true;
    this.key = null;
    this.entries = [];
    this.pending = {};
    this.row = null;
  }
}
