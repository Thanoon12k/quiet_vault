import { rewrapVault } from './crypto.js';
const storageKey = owner => `quiet-vault.managed.v1.${owner}`;
export async function cachedManagedSecret(owner) {
  const key = storageKey(owner);
  if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(key))[key] ?? null;
  return localStorage.getItem(key);
}
async function remember(owner, secret) {
  const key = storageKey(owner);
  if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [key]: secret });
  else localStorage.setItem(key, secret);
}
export async function forgetManagedSecret(owner) {
  const key = storageKey(owner);
  if (globalThis.chrome?.storage?.local) await chrome.storage.local.remove(key);
  localStorage.removeItem(key);
}
export async function managedSecret(client, owner, create = false, offline = false) {
  if (offline) {
    const cached = await cachedManagedSecret(owner);
    if (!cached) throw new Error('Connect once on this device to open your vault.');
    return cached;
  }
  const { data, error } = await client.rpc('quiet_vault_managed_key', { create_if_missing: create });
  if (error) throw error;
  if (typeof data !== 'string' || data.length !== 44) throw new Error('Managed vault key is not available.');
  await remember(owner, data); return data;
}
export async function migrateManaged(vault, password) {
  await vault.sync();
  const secret = await managedSecret(vault.client, vault.owner, true);
  const wrapping = await rewrapVault(vault.owner, password, secret, vault.row);
  const { data, error } = await vault.client.rpc('quiet_vault_enable_managed', {
    expected_revision: vault.row.revision, new_salt: wrapping.salt,
    new_wrapped_key: wrapping.wrapped_key, new_wrap_nonce: wrapping.wrap_nonce
  });
  if (error) throw error;
  if (!data?.length) throw new Error('Another device changed the vault. Please try again.');
  vault.row = data[0]; await vault.persist();
}
