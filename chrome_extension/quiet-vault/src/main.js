import { client, authStorage, AUTH_KEY } from './client.js';
import { googleSignIn, oauthError } from './oauth.js';
import { Vault, readCache } from './store.js';
import { managedSecret, migrateManaged, forgetManagedSecret } from './managed.js';
import { loginAttempt, downloadLoginDiagnostics } from './diagnostics.js';
import './style.css';

const app = document.querySelector('#app');
const toastElement = document.querySelector('#toast');

let session = null;
let vault = null;
let managedMode = false;
let query = '';
let idleTimer;
let revealTimer;
let toastTimer;
let syncTimer;
let bootVersion = 0;
let syncing = false;
let syncProblem = false;
const IDLE_MS = 120_000;

const icons = {
  lock: '<rect x="6" y="10" width="12" height="11" rx="3"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/><path d="M12 14v3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="3"/><path d="M15 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h2"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  key: '<circle cx="8" cy="9" r="4"/><path d="m11 12 8 8m-4-4 3-3m-6 0 3-3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  arrow: '<path d="M8 5h11v11M19 5 5 19"/>',
  sync: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2"/>'
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function toast(message) {
  clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.classList.add('visible');
  toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 4500);
}
function message(error) {
  const raw = error?.message || 'Something went wrong. Try again.';
  if (/failed to fetch|network|timeout|load failed/i.test(raw)) return 'Could not connect. Saved items are available offline.';
  return raw;
}
function errorText(container, text) { container.textContent = text; container.hidden = !text; }
function shell() {
  app.innerHTML = `<header><div class="brand"><span class="brand-mark"><img src="icons/icon48.png" alt="" width="36" height="36"></span><span>quiet vault<span class="brand-dot">.</span></span></div><div id="header-actions"></div></header><main id="main"></main><footer><span class="footer-dot"></span> A little space for your secrets.</footer>`;
  return document.querySelector('#main');
}
function pageHeading(main, eyebrow, title, subtitle) {
  main.append(element('div', 'eyebrow', eyebrow), element('h1', '', title), element('p', 'subtitle', subtitle));
}
function inputField(form, label, type, name, placeholder, autocomplete) {
  const wrapper = element('div', 'field');
  const labelElement = element('label', 'field-label', label);
  labelElement.htmlFor = `field-${name}`;
  wrapper.append(labelElement);
  const input = element('input');
  input.type = type; input.name = name; input.placeholder = placeholder;
  input.id = `field-${name}`;
  input.autocomplete = autocomplete; input.required = true;
  if (type !== 'email') input.spellcheck = false;
  wrapper.append(input); form.append(wrapper);
  return input;
}
function primary(text) { const button = element('button', 'primary full', text); button.type = 'submit'; return button; }
function smallButton(label, iconName, onClick) {
  const button = element('button', 'icon-button'); button.type = 'button';
  button.setAttribute('aria-label', label); button.title = label; button.innerHTML = icon(iconName);
  button.addEventListener('click', onClick); return button;
}
function resetIdle() {
  clearTimeout(idleTimer);
  if (vault) idleTimer = setTimeout(() => lockVault('Vault locked after two minutes of inactivity.'), IDLE_MS);
}
function lockVault(reason) {
  bootVersion++;
  clearTimeout(idleTimer); clearTimeout(revealTimer); clearTimeout(syncTimer);
  vault?.lock(); vault = null; query = ''; syncing = false;
  // Remove decrypted values and any editor immediately, before further async work.
  app.replaceChildren();
  if (managedMode) showManagedGate(); else showUnlock(false);
  if (reason) toast(reason);
}

function rememberAccount() { localStorage.setItem('quiet-vault.last-user.v1', JSON.stringify({ id: session.user.id, email: session.user.email })); }

function showAuth() {
  const main = shell();
  pageHeading(main, 'YOUR PRIVATE CORNER', 'Everything, in one place.',
    'API keys, passwords, and the little things you need to keep safe.');
  const google = element('button', 'google-button', 'Continue with Google');
  google.type = 'button'; google.id = 'google-sign-in';
  const googleMark = element('span', 'google-mark', 'G'); googleMark.setAttribute('aria-hidden', 'true'); google.prepend(googleMark);
  const googleError = element('p', 'form-error'); googleError.role = 'alert'; googleError.hidden = true;
  main.append(google, googleError);
  google.onclick = async () => {
    errorText(googleError, '');
    if (!globalThis.chrome?.runtime?.id || !chrome.identity?.launchWebAuthFlow) {
      errorText(googleError, 'Open the installed Quiet Vault extension to use Google sign-in.'); return;
    }
    const isActionPopup = chrome.extension?.getViews?.({ type: 'popup' }).includes(window) ?? false;
    if (isActionPopup) {
      google.disabled = true;
      try {
        await chrome.tabs.create({ url: chrome.runtime.getURL('index.html?google=1') });
        window.close();
      } catch { errorText(googleError, 'Could not open the sign-in tab. Reload Quiet Vault in chrome://extensions and try again.'); google.disabled = false; }
      return;
    }
    google.disabled = true; google.textContent = 'Opening Google…';
    try {
      // A full extension tab survives losing focus to Google's authorization window.
      // No runtime messages or background worker are involved in sign-in.
      const attempt = loginAttempt();
      session = await googleSignIn(client, chrome.identity, attempt.record);
      rememberAccount(); await routeToVault();
    } catch (failure) {
      await authStorage.removeItem(`${AUTH_KEY}-code-verifier`);
      errorText(googleError, oauthError(failure));
      if (!main.querySelector('#login-diagnostics')) {
        const logs = element('button', 'text-button full', 'Download sign-in diagnostics'); logs.id = 'login-diagnostics';
        logs.onclick = () => void downloadLoginDiagnostics(); googleError.after(logs);
      }
    } finally {
      google.disabled = false; google.textContent = 'Continue with Google'; google.prepend(googleMark);
    }
  };
  main.append(element('p', 'fine-print', 'Sign in with Google to open your vault. Your secrets sync automatically.'));
  google.focus();
}

function isGoogleAccount() {
  return session.user.app_metadata?.provider === 'google' || session.user.app_metadata?.providers?.includes('google');
}
async function routeToVault() {
  const stamp = ++bootVersion;
  const main = shell(); pageHeading(main, 'QUIET VAULT', 'Just a moment.', 'Finding your encrypted vault…');
  try {
    const cached = readCache(session.user.id);
    let row;
    let offline = !navigator.onLine;
    if (!offline) {
      try { row = await new Vault(client, session.user.id).fetchRow(); }
      catch (failure) {
        if (!cached || !/fetch|network|timeout|offline|load failed/i.test(failure.message ?? '')) throw failure;
        offline = true;
      }
    }
    if (offline) row = cached?.row;
    if (stamp !== bootVersion) return;
    managedMode = row?.unlock_mode === 'managed' || (!row && isGoogleAccount());
    if (managedMode) await openManaged(row, !row, offline);
    else showUnlock(!row);
  } catch (failure) {
    if (stamp !== bootVersion) return;
    main.append(element('p', 'form-error', message(failure)));
    const retry = element('button', 'primary full', 'Try again'); retry.onclick = routeToVault;
    const out = element('button', 'text-button full', 'Sign out'); out.onclick = signOut;
    main.append(retry, out);
  }
}

function showUnlock(isNew) {
  const migrating = !isNew && isGoogleAccount();
  const main = shell();
  pageHeading(main, 'ONLY YOU HOLD THE KEY', isNew ? 'Your secrets start here.' : migrating ? 'One last unlock.' : 'Welcome back.',
    isNew ? 'Create a master password to encrypt your vault.' : migrating ? 'Enter your old master password once. Next time, Google will open your vault.' : 'Unlock your vault. Everything else can wait.');
  const form = element('form', 'auth-form');
  const password = inputField(form, 'Master password', 'password', 'master', isNew ? 'At least 12 characters' : 'Enter your master password', isNew ? 'new-password' : 'current-password');
  password.minLength = isNew ? 12 : 1;
  let confirmation;
  if (isNew) confirmation = inputField(form, 'Confirm master password', 'password', 'confirm', 'One more time', 'new-password');
  const error = element('p', 'form-error'); error.role = 'alert'; error.hidden = true;
  const submit = primary(isNew ? 'Create my vault' : 'Unlock vault');
  form.append(error, submit); main.append(form);
  main.append(element('p', 'fine-print', isNew ? 'Keep this password somewhere safe. It cannot be recovered or reset.' : 'Your master password stays on this device while unlocking. It is never sent to the server.'));
  const account = element('button', 'text-button account-switch', 'Use a different account'); account.onclick = signOut; main.append(account);
  form.addEventListener('submit', async event => {
    event.preventDefault(); errorText(error, '');
    if (confirmation && password.value !== confirmation.value) { errorText(error, 'The passwords do not match.'); return; }
    const stamp = ++bootVersion;
    submit.disabled = true; account.disabled = true; submit.textContent = 'Unlocking…';
    const nextVault = new Vault(client, session.user.id);
    try {
      await nextVault.initialize(password.value, isNew);
      if (migrating) {
        await migrateManaged(nextVault, password.value); managedMode = true;
      }
      password.value = ''; if (confirmation) confirmation.value = '';
      if (stamp !== bootVersion) { nextVault.lock(); return; }
      if (document.hidden) { nextVault.lock(); if (managedMode) showManagedGate(); else showUnlock(false); return; }
      vault = nextVault; showHome(); resetIdle(); void syncVault();
    } catch (failure) {
      nextVault.lock();
      if (stamp === bootVersion) errorText(error, message(failure));
    } finally {
      password.value = ''; if (confirmation) confirmation.value = '';
      submit.disabled = false; account.disabled = false; submit.textContent = isNew ? 'Create my vault' : 'Unlock vault';
    }
  });
  password.focus();
}

function showHome() {
  clearTimeout(revealTimer);
  const main = shell();
  document.querySelector('#header-actions').append(smallButton('Vault options', 'more', showOptions));
  const heading = element('div', 'home-heading');
  heading.append(element('div', 'eyebrow', 'LESS TO REMEMBER'));
  const status = element('button', 'sync-status'); status.id = 'sync-status'; status.type = 'button';
  status.addEventListener('click', () => void syncVault(true)); heading.append(status);
  main.append(heading, element('h1', '', 'A clear head. A safe place.'));
  const toolbar = element('div', 'toolbar');
  const searchBox = element('div', 'search-box'); searchBox.innerHTML = icon('search');
  const search = element('input'); search.type = 'search'; search.placeholder = 'Find or name a secret…';
  search.setAttribute('aria-label', 'Search secrets'); search.autocomplete = 'off'; search.value = query;
  searchBox.append(search);
  const add = element('button', 'primary add-button'); add.innerHTML = `${icon('plus')}<span>Add</span>`;
  add.addEventListener('click', () => showAddSecret(search.value.trim())); toolbar.append(searchBox, add); main.append(toolbar);
  const list = element('div', 'secret-list'); list.id = 'secret-list'; list.setAttribute('aria-label', 'Saved secrets');
  main.append(list); search.addEventListener('input', () => { query = search.value; renderList(); });
  renderList(); updateStatus(); search.focus();
}

function renderList() {
  if (!vault) return;
  const list = document.querySelector('#secret-list'); if (!list) return;
  list.replaceChildren();
  const all = vault.entries.filter(item => !item.deleted);
  const items = all.filter(item => `${item.name} ${item.kind}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  list.append(element('div', 'list-caption', `${items.length} ${items.length === 1 ? 'secret' : 'secrets'}`));
  if (!items.length) {
    const empty = element('div', 'empty-state');
    const mark = element('div', 'empty-mark'); mark.innerHTML = icon(query ? 'search' : 'key');
    empty.append(mark, element('h2', '', query ? 'Nothing by that name.' : 'A little less to remember.'),
      element('p', '', query ? 'Try another name or clear your search.' : 'Add your first key, password, or variable.\nWe’ll keep it here for you.'));
    list.append(empty); return;
  }
  for (const item of items) {
    const row = element('div', 'secret-row');
    const open = element('button', 'secret-open'); open.type = 'button';
    const mark = element('span', `item-mark ${item.kind === 'Password' ? 'lavender' : ''}`);
    mark.innerHTML = icon(item.kind === 'Password' ? 'lock' : 'key');
    const text = element('span', 'item-text'); text.append(element('span', 'item-name', item.name), element('span', 'item-meta', `${item.kind}  ·  ••••••••`));
    open.append(mark, text); open.setAttribute('aria-label', `Edit ${item.name}`); open.onclick = () => showEditor(item.id);
    const copy = smallButton(`Copy ${item.name}`, 'copy', async () => {
      try { await navigator.clipboard.writeText(item.value); toast('Copied.'); copy.innerHTML = icon('check'); setTimeout(() => { copy.innerHTML = icon('copy'); }, 1500); }
      catch { toast('Could not copy. Open the item to reveal and copy it manually.'); }
    });
    row.append(open, copy);
    const card = element('div', 'secret-card'); card.append(row);
    if (item.description) card.append(descriptionNode(item.description));
    list.append(card);
  }
}

function updateStatus(override) {
  const status = document.querySelector('#sync-status'); if (!status || !vault) return;
  const pending = Object.keys(vault.pending).length;
  status.textContent = override ?? (syncing ? 'Syncing…' : syncProblem ? 'Sync paused · retry' : pending ? 'Saved on this device' : 'Synced');
  status.title = 'Sync vault now';
  status.classList.toggle('pending', Boolean(pending));
}

async function syncVault(manual = false) {
  if (!vault) return;
  if (syncing) {
    if (manual) {
      const waitingFor = vault;
      await waitingFor.tail;
      if (vault === waitingFor) return syncVault(true);
    }
    return;
  }
  const current = vault;
  syncing = true; updateStatus();
  try {
    const result = await current.sync();
    if (vault !== current) return;
    syncProblem = false;
    if (document.querySelector('#secret-list')) renderList();
    if (result.conflicts) toast('Both edits were kept. Check the items marked “conflict copy”.');
    else if (manual) toast('Vault is up to date.');
  } catch (failure) {
    if (vault !== current) return;
    syncProblem = true;
    if (failure.status === 401 || failure.code === 'PGRST301') toast('Sign in again to sync. Your changes are saved on this device.');
    else if (manual) toast(message(failure));
    updateStatus('Sync paused · retry');
  } finally {
    if (vault === current) { syncing = false; updateStatus(); }
  }
}

function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => void syncVault(), 250); }

function showEditor(id) {
  clearTimeout(revealTimer);
  if (!vault) return;
  const current = vault;
  const existing = id ? vault.entries.find(item => item.id === id && !item.deleted) : null;
  if (id && !existing) { showHome(); return; }
  const main = shell();
  const back = element('button', 'back-button', 'All secrets'); back.prepend(element('span')); back.firstChild.innerHTML = icon('back'); back.onclick = showHome;
  main.append(back); pageHeading(main, existing ? 'YOUR SECRET' : 'A LITTLE PEACE OF MIND', existing ? 'The details.' : 'Keep something safe.', 'Just a name and a value.');
  const form = element('form', 'editor-form');
  const name = inputField(form, 'Name', 'text', 'name', 'e.g. OpenAI · personal', 'off'); name.maxLength = 160;
  const value = inputField(form, 'Value', 'password', 'value', 'Paste your secret here', 'off'); value.maxLength = 32000; value.autocapitalize = 'off';
  const toggle = element('button', 'reveal-button', 'Show'); toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Show secret value'); value.parentElement.classList.add('secret-field'); value.parentElement.append(toggle);
  toggle.onclick = () => {
    const reveal = value.type === 'password'; value.type = reveal ? 'text' : 'password'; toggle.textContent = reveal ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', reveal ? 'Hide secret value' : 'Show secret value');
    clearTimeout(revealTimer);
    if (reveal) revealTimer = setTimeout(() => { value.type = 'password'; toggle.textContent = 'Show'; toggle.setAttribute('aria-label', 'Show secret value'); }, 15000);
  };
  const description = inputField(form, 'Description (optional)', 'text', 'description', 'A link or a short note', 'off');
  description.required = false; description.maxLength = 2000; description.value = existing?.description ?? '';
  const label = element('div', 'field');
  const typeLabel = element('label', 'field-label', 'Type'); typeLabel.htmlFor = 'field-kind'; label.append(typeLabel);
  const kind = element('select'); kind.name = 'kind';
  kind.id = 'field-kind';
  for (const type of ['API key', 'Password', 'Variable', 'Secret']) { const option = element('option', '', type); option.value = type; kind.append(option); }
  label.append(kind); form.append(label);
  if (existing) { name.value = existing.name; value.value = existing.value; kind.value = existing.kind; }
  const error = element('p', 'form-error'); error.role = 'alert'; error.hidden = true;
  const save = primary(existing ? 'Save changes' : 'Save secret'); form.append(error, save); main.append(form);
  let remove;
  if (existing) {
    remove = element('button', 'text-button danger full', 'Delete secret'); let confirming = false;
    remove.onclick = async () => {
      if (!confirming) { confirming = true; remove.textContent = 'Delete this secret? Click again to confirm'; return; }
      remove.disabled = true; save.disabled = true; back.disabled = true;
      try { await current.remove(id); if (vault === current) { showHome(); toast('Secret deleted.'); scheduleSync(); } }
      catch (failure) { errorText(error, message(failure)); }
      finally { remove.disabled = false; save.disabled = false; back.disabled = false; }
    };
    main.append(remove);
  }
  form.onsubmit = async event => {
    event.preventDefault(); save.disabled = true; back.disabled = true; if (remove) remove.disabled = true;
    try {
      await current.save({ name: name.value, value: value.value, kind: kind.value, description: description.value }, id);
      value.value = '';
      if (vault === current) { showHome(); toast('Saved.'); scheduleSync(); }
    } catch (failure) { errorText(error, message(failure)); }
    finally { save.disabled = false; back.disabled = false; if (remove) remove.disabled = false; }
  };
  name.focus();
}

function showOptions() {
  const main = shell();
  const back = element('button', 'back-button', 'All secrets'); back.onclick = showHome; main.append(back);
  pageHeading(main, 'A FEW SMALL THINGS', 'Your vault.', 'Private by design. Simple by choice.');
  const account = element('p', 'account-label', session.user.email); main.append(account);
  const lock = element('button', 'option-button', 'Lock vault'); lock.prepend(element('span')); lock.firstChild.innerHTML = icon('lock'); lock.onclick = () => lockVault();
  const backup = element('button', 'option-button', 'Save encrypted backup'); backup.prepend(element('span')); backup.firstChild.innerHTML = icon('arrow');
  backup.onclick = () => {
    try {
      const data = readCache(session.user.id);
      const blob = new Blob([JSON.stringify({ app: 'quiet-vault', backupVersion: 1, owner: session.user.id, ...data })], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const anchor = element('a'); anchor.href = url;
      anchor.download = `quiet-vault-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); toast(managedMode ? 'Encrypted backup saved.' : 'Encrypted backup saved. Keep your master password too.');
    } catch (failure) { toast(message(failure)); }
  };
  const restore = element('button', 'option-button', 'Restore encrypted backup');
  const file = element('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
  const current = vault;
  restore.onclick = () => file.click();
  file.onchange = async () => {
    const selected = file.files?.[0]; if (!selected) return;
    restore.disabled = true;
    try {
      if (selected.size > 4000000) throw new Error('This backup is too large.');
      const count = await current.restore(JSON.parse(await selected.text()));
      if (vault === current) { showHome(); toast(count ? `Restored ${count} ${count === 1 ? 'item' : 'items'}.` : 'These items are already in your vault.'); scheduleSync(); }
    } catch (failure) { if (vault === current) toast(message(failure)); }
    finally { restore.disabled = false; file.value = ''; }
  };
  const out = element('button', 'option-button danger', 'Sign out'); out.onclick = signOut;
  const logs = element('button', 'option-button', 'Download sign-in diagnostics'); logs.onclick = () => void downloadLoginDiagnostics();
  main.append(lock, backup, restore, file, logs, out);
  main.append(element('p', 'fine-print', 'Locks when hidden or after 2 minutes of inactivity. Revealed values hide after 15 seconds. Copied values stay on your system clipboard until replaced.'));
  main.append(element('p', 'fine-print', managedMode ? 'Your Google account opens this vault. Supabase manages the encryption key. Sign out on shared devices.' : 'Your master password cannot be reset. Keep it safe alongside your encrypted backups.'));
}

async function signOut() {
  const owner = session?.user.id;
  bootVersion++; vault?.lock(); vault = null; managedMode = false;
  clearTimeout(idleTimer); clearTimeout(syncTimer); clearTimeout(revealTimer);
  app.replaceChildren();
  localStorage.removeItem('quiet-vault.last-user.v1');
  if (owner) await forgetManagedSecret(owner);
  // Only this app's session is signed out. Existing clinic sessions are untouched.
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) toast('Sign-out could not reach the server. This vault is locked.');
  session = null; showAuth();
}

document.addEventListener('pointerdown', resetIdle, { passive: true });
document.addEventListener('keydown', event => {
  resetIdle();
  if (event.key === 'Escape' && vault) lockVault();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && vault) lockVault(); });
window.addEventListener('pagehide', () => { vault?.lock(); vault = null; });
window.addEventListener('online', () => void syncVault());
window.addEventListener('storage', event => {
  if (session && event.key === `quiet-vault.cache.v1.${session.user.id}` && vault) {
    lockVault('Vault changed in another window. Unlock to load the latest changes.');
  }
});
setInterval(() => { if (vault && !document.hidden) void syncVault(); }, 60_000);
client.auth.onAuthStateChange((event, nextSession) => {
  if (event === 'TOKEN_REFRESHED') session = nextSession;
  if (event === 'SIGNED_IN' && session && nextSession?.user.id !== session.user.id) {
    bootVersion++; vault?.lock(); vault = null; session = nextSession;
    app.replaceChildren(); setTimeout(() => { rememberAccount(); void routeToVault(); }, 0);
  }
  if (event === 'SIGNED_OUT' && session) {
    bootVersion++; vault?.lock(); vault = null; session = null; showAuth();
  }
});

async function boot() {
  let offlineIdentity = null;
  try {
    const identity = JSON.parse(localStorage.getItem('quiet-vault.last-user.v1') || 'null');
    if (identity && typeof identity.id === 'string' && readCache(identity.id)) offlineIdentity = identity;
  } catch { /* A damaged hint is not an authentication credential. */ }
  if (!navigator.onLine && offlineIdentity) {
    session = { user: offlineIdentity }; await routeToVault(); return;
  }
  try {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    session = data.session;
    const currentURL = new URL(location.href);
    const beginGoogle = currentURL.searchParams.get('google') === '1';
    currentURL.searchParams.delete('google');
    if (beginGoogle) history.replaceState(null, '', currentURL.pathname + currentURL.search + currentURL.hash);
    if (session) { rememberAccount(); await routeToVault(); }
    else {
      showAuth();
      if (beginGoogle) document.querySelector('#google-sign-in').click();
    }
  } catch (failure) {
    if (offlineIdentity && /fetch|network|timeout|offline|load failed/i.test(failure?.message || '')) {
      session = { user: offlineIdentity }; await routeToVault();
    } else { showAuth(); toast('Please sign in to continue.'); }
  }
}
void boot();

async function openManaged(row, isNew, offline = false) {
  const stamp=++bootVersion;
  const main=shell(); pageHeading(main,'YOUR PRIVATE CORNER','Opening your vault.','One less password to remember.');
  const next=new Vault(client,session.user.id);
  try {
    const secret=await managedSecret(client,session.user.id,isNew,offline);
    try { await next.initialize(secret,isNew,{ mode:'managed',row }); }
    catch (failure) {
      if (!isNew || !/already exists/.test(failure.message)) throw failure;
      const current=await next.fetchRow();
      await next.initialize(secret,false,{mode:'managed',row:current});
    }
    if (stamp!==bootVersion) { next.lock(); return; }
    if (document.hidden) { next.lock(); showManagedGate(); return; }
    vault=next; showHome(); resetIdle(); void syncVault();
  } catch (failure) {
    next.lock();
    if (stamp!==bootVersion) return;
    main.append(element('p','form-error',message(failure)));
    const retry=element('button','primary full','Try again'); retry.onclick=routeToVault;
    const out=element('button','text-button full','Sign out'); out.onclick=signOut;
    main.append(retry,out);
  }
}
function showManagedGate() {
  const main=shell(); pageHeading(main,'YOUR PRIVATE CORNER','Ready when you are.','Open your vault to continue.');
  const open=element('button','primary full','Open vault'); open.onclick=routeToVault;
  const out=element('button','text-button full','Sign out'); out.onclick=signOut;
  main.append(open,out);
}


// Render user text as text nodes; only explicit HTTP(S) URLs become links.
function descriptionNode(text) {
  const note = element('p', 'secret-description');
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    let href;
    try { href = new URL(match[0]).href; } catch { continue; }
    note.append(document.createTextNode(text.slice(offset, match.index)));
    const link = element('a', '', match[0]);
    link.href = href;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    note.append(link); offset = match.index + match[0].length;
  }
  note.append(document.createTextNode(text.slice(offset)));
  return note;
}

function showAddSecret(prefilledName = '') {
  if (!vault) return;
  const current = vault;
  const main = shell();
  const back = element('button', 'back-button', 'All secrets'); back.onclick = showHome; main.append(back);
  main.append(element('h1', 'add-title', prefilledName || 'Add a secret'));
  const form = element('form', 'editor-form');
  let name;
  if (!prefilledName) {
    name = inputField(form, 'Name', 'text', 'name', 'e.g. OpenAI', 'off'); name.maxLength = 160;
  }
  const token = inputField(form, 'Token or password', 'password', 'value', 'Paste your secret', 'off');
  token.maxLength = 32000; token.autocapitalize = 'off';
  const description = inputField(form, 'Description or link (optional)', 'text', 'description', 'https://… or a short note', 'off');
  description.required = false; description.maxLength = 2000;
  const error = element('p', 'form-error'); error.role = 'alert'; error.hidden = true;
  const save = primary('Save secret'); form.append(error, save); main.append(form);
  form.onsubmit = async event => {
    event.preventDefault(); save.disabled = true; back.disabled = true; errorText(error, '');
    try {
      await current.save({ name: prefilledName || name.value, value: token.value, description: description.value, kind: 'Secret' });
      token.value = ''; description.value = '';
      if (vault === current) { query = ''; showHome(); toast('Saved.'); scheduleSync(); }
    } catch (failure) { if (vault === current) errorText(error, message(failure)); }
    finally { save.disabled = false; back.disabled = false; }
  };
  (name || token).focus();
}
