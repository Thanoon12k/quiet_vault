const KEY = 'quiet-vault.login-diagnostics.v1';
const stages = new Set(['start','authorize','browser','callback','exchange','success','failed']);
const reasons = new Set(['none','cancelled','page_load_failed','invalid_callback','exchange_failed','network','unknown']);
let writes = Promise.resolve();
export async function loginDiagnostics() {
  try {
    const saved = globalThis.chrome?.storage?.local ? (await chrome.storage.local.get(KEY))[KEY] : JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(saved) ? saved.slice(-40) : [];
  } catch { return []; }
}
export function loginAttempt() {
  const id = crypto.randomUUID().slice(0,8);
  return { id, record(stage, reason = 'none') {
    // Fixed fields only: never error messages, URLs, email, user IDs, keys or codes.
    const event = { id, at: new Date().toISOString(), stage: stages.has(stage) ? stage : 'failed',
      reason: reasons.has(reason) ? reason : 'unknown', version: globalThis.chrome?.runtime?.getManifest?.().version ?? 'preview' };
    writes = writes.then(async () => {
      const events = [...await loginDiagnostics(), event].slice(-40);
      if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [KEY]: events });
      else localStorage.setItem(KEY, JSON.stringify(events));
    }).catch(() => {});
  } };
}
export async function downloadLoginDiagnostics() {
  await writes;
  const data = await loginDiagnostics();
  const url = URL.createObjectURL(new Blob([JSON.stringify({ app:'Quiet Vault', events:data },null,2)], { type:'application/json' }));
  const link = document.createElement('a'); link.href=url; link.download='quiet-vault-login-diagnostics.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
