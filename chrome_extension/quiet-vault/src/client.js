import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const AUTH_KEY = 'quiet-vault.auth.v1';
const extensionStorage = globalThis.chrome?.storage?.local;
export const authStorage = {
  async getItem(key) {
    if (!extensionStorage) return globalThis.localStorage?.getItem(key) ?? null;
    const saved = (await extensionStorage.get(key))[key];
    if (typeof saved === 'string') return saved;
    // Migrate sessions from the earlier popup-only version when available.
    const legacy = globalThis.localStorage?.getItem(key);
    if (legacy) { await extensionStorage.set({ [key]: legacy }); globalThis.localStorage.removeItem(key); }
    return legacy ?? null;
  },
  async setItem(key, value) {
    if (extensionStorage) {
      await extensionStorage.set({ [key]: value });
      globalThis.localStorage?.removeItem(key);
    } else { globalThis.localStorage.setItem(key, value); }
  },
  async removeItem(key) {
    if (extensionStorage) await extensionStorage.remove(key);
    globalThis.localStorage?.removeItem(key);
  }
};

export const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storageKey: AUTH_KEY, storage: authStorage, flowType: 'pkce', detectSessionInUrl: false,
    persistSession: true, autoRefreshToken: typeof window !== 'undefined' },
  global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(12000) }) }
});
