import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createVault, seal } from '../src/crypto.js';
const extensionPath = resolve('dist');
await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(resolve('test-results/direct-google-'));
const config = JSON.parse(await readFile('extension-config.json', 'utf8'));
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
assert.equal(manifest.background, undefined, 'Google sign-in must not depend on a background receiver');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, viewport: { width: 400, height: 640 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});
context.setDefaultTimeout(15000);
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'google-demo@example.test', app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {}, aud: 'authenticated', role: 'authenticated' };
const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now()/1000)+3600, role:'authenticated' })).toString('base64url')}.fake-test-signature`;
const session = { access_token: token, refresh_token: 'fake-test-refresh-token', token_type: 'bearer', expires_in: 3600, user };
const requests = [];
let row = null;
let offline = false;
const managedKey = Buffer.alloc(32, 37).toString('base64');
await context.route('https://axncazensmjdqpczvzwf.supabase.co/**', route => {
  if (offline) return route.abort('internetdisconnected');
  const request = route.request();
  requests.push({ url: request.url(), body: request.postData() });
  const path = new URL(request.url()).pathname;
  const body = request.postDataJSON();
  const respond = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  if (path.endsWith('/user')) return respond(user);
  if (path.endsWith('/token')) return respond(session);
  if (path.endsWith('/logout')) return respond({});
  if (path === '/rest/v1/quiet_vaults') {
    if (request.method() === 'GET') return respond(row ? [row] : []);
    row = { ...body }; return respond(row);
  }
  if (path.endsWith('/quiet_vault_managed_key')) return respond(managedKey);
  if (path.endsWith('/quiet_vault_save')) {
    if (body.expected_revision !== row.revision) return respond([]);
    row = { ...row, nonce: body.new_nonce, ciphertext: body.new_ciphertext, revision: row.revision + 1 };
    return respond([row]);
  }
  if (path.endsWith('/quiet_vault_enable_managed')) {
    if (body.expected_revision !== row.revision) return respond([]);
    row = { ...row, salt: body.new_salt, wrapped_key: body.new_wrapped_key, wrap_nonce: body.new_wrap_nonce, unlock_mode: 'managed', revision: row.revision + 1 };
    return respond([row]);
  }
  throw new Error(`Unexpected path ${path}`);
});
await context.addInitScript(callback => {
  globalThis.oauthMode = 'cancel';
  // Failing every runtime message reproduces the user's missing-receiver condition.
  chrome.runtime.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
  chrome.identity.launchWebAuthFlow = async options => {
    globalThis.testAuthURL = options.url;
    if (globalThis.oauthMode === 'cancel') throw new Error('The user did not approve access.');
    if (globalThis.oauthMode === 'wrong-origin') return 'https://wrong.example/supabase?code=stolen';
    return `${callback}?code=test-one-time-code`;
  };
}, config.redirectUrl);
try {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${config.id}/index.html`);
  assert.equal(await page.getByRole('button', { name: 'Use email instead', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Account password', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await page.getByText('Google sign-in was cancelled. You can try again.', { exact: true }).waitFor();
  const cancelled = await page.evaluate(async () => await chrome.storage.local.get());
  assert.equal(cancelled['quiet-vault.auth.v1-code-verifier'], undefined);
  assert.equal(cancelled['quiet-vault.auth.v1'], undefined);
  await page.evaluate(() => { globalThis.oauthMode = 'wrong-origin'; });
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await page.getByText(/Google sign-in could not finish/).waitFor();
  assert.equal(requests.filter(r => r.url.includes('/token')).length, 0);
  await page.evaluate(() => { globalThis.oauthMode = 'success'; });
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await page.getByRole('searchbox').waitFor();
  assert.equal(await page.getByLabel('Master password', { exact: true }).count(), 0);
  const state = await page.evaluate(async () => ({ stored: await chrome.storage.local.get(), authURL: globalThis.testAuthURL }));
  const authURL = new URL(state.authURL);
  assert.equal(authURL.searchParams.get('redirect_to'), config.redirectUrl);
  assert.equal(authURL.searchParams.get('code_challenge_method'), 's256');
  assert.ok(authURL.searchParams.get('code_challenge')?.length > 30);
  const body = JSON.parse(requests.find(r => r.url.includes('/token')).body);
  assert.equal(body.auth_code, 'test-one-time-code'); assert.ok(body.code_verifier.length > 30);
  assert.equal(JSON.parse(state.stored['quiet-vault.auth.v1']).user.id, user.id);
  assert.equal(state.stored['quiet-vault.auth.v1-code-verifier'], undefined);
  const diagnosticEvents = state.stored['quiet-vault.login-diagnostics.v1'];
  assert.ok(diagnosticEvents.some(event => event.reason === 'cancelled'));
  assert.ok(diagnosticEvents.some(event => event.reason === 'invalid_callback'));
  assert.ok(diagnosticEvents.some(event => event.stage === 'success'));
  for (const event of diagnosticEvents) assert.deepEqual(Object.keys(event).sort(), ['at', 'id', 'reason', 'stage', 'version']);
  assert.ok(!JSON.stringify(diagnosticEvents).includes('test-one-time-code'));
  assert.equal(row.unlock_mode, 'managed');
  await page.getByRole('searchbox').fill('My token');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  assert.equal(await page.getByLabel('Name', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).count(), 0);
  await page.getByRole('heading', { name: 'My token', exact: true }).waitFor();
  await page.getByLabel('Token or password', { exact: true }).fill('dummy-value-preserved');
  await page.getByLabel('Description or link (optional)', { exact: true }).fill('https://example.test/account');
  assert.equal(await page.getByLabel('Token or password', { exact: true }).getAttribute('type'), 'password');
  await mkdir(process.env.VAULT_OUTPUT_DIR ?? 'test-results', { recursive: true });
  await page.screenshot({ path: resolve(process.env.VAULT_OUTPUT_DIR ?? 'test-results', 'quiet-vault-add-compact.png') });
  await page.getByRole('button', { name: 'Save secret', exact: true }).click();
  await page.getByRole('button', { name: 'Edit My token', exact: true }).waitFor();
  await page.locator('#sync-status').click();
  await page.getByText('Vault is up to date.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Edit My token', exact: true }).click();
  assert.equal(await page.getByLabel('Description (optional)', { exact: true }).inputValue(), 'https://example.test/account');
  offline = true;
  await page.reload();
  await page.getByRole('button', { name: 'Edit My token', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open vault', exact: true }).click();
  await page.getByRole('button', { name: 'Edit My token', exact: true }).waitFor();
  offline = false;
  await page.getByRole('button', { name: 'Vault options', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => chrome.storage.local.get()))[`quiet-vault.managed.v1.${user.id}`], undefined);
  // Existing master vault: migrate once and preserve the original data encryption key.
  const master = 'old master password used once';
  const legacy = await createVault(user.id, master);
  const oldEntry = { id: crypto.randomUUID(), version: crypto.randomUUID(), name: 'Legacy token', value: 'legacy-private-value', kind: 'Secret', deleted: false, updatedAt: new Date().toISOString() };
  row = { ...legacy.row, ...await seal(legacy.key, user.id, { entries: [oldEntry] }), unlock_mode: 'master' };
  await page.evaluate(async () => { localStorage.clear(); await chrome.storage.local.clear(); });
  await page.reload();
  await page.evaluate(() => { globalThis.oauthMode = 'success'; });
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await page.getByText('One last unlock.', { exact: true }).waitFor();
  await page.getByLabel('Master password', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  await page.getByText(/Could not unlock/).waitFor();
  assert.equal(row.unlock_mode, 'master');
  await page.getByLabel('Master password', { exact: true }).fill(master);
  await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Legacy token', exact: true }).waitFor();
  assert.equal(row.unlock_mode, 'managed');
  await page.reload();
  await page.getByRole('button', { name: 'Edit Legacy token', exact: true }).click();
  assert.equal(await page.getByLabel('Value', { exact: true }).inputValue(), 'legacy-private-value');
  for (const forbidden of [master, 'legacy-private-value', 'dummy-value-preserved', 'https://example.test/account']) {
    assert.ok(!JSON.stringify(requests).includes(forbidden));
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(forbidden));
  }
  await page.getByRole('button', { name: 'All secrets', exact: true }).click();
  row = null; // Authorized server-side reset; old encrypted cache still exists locally.
  await page.reload();
  await page.getByRole('searchbox').waitFor();
  assert.equal(await page.getByLabel('Master password', { exact: true }).count(), 0);
  assert.equal(await page.locator('.secret-row').count(), 0);
  assert.equal(row.unlock_mode, 'managed');
  assert.ok(!(await page.locator('body').innerText()).includes('Legacy token'));
  // Simulate an actual action popup, then verify it opens a durable sign-in tab.
  await page.evaluate(async () => await chrome.storage.local.clear());
  const popup = await context.newPage();
  await popup.addInitScript(() => { chrome.extension.getViews = () => [window]; });
  await popup.goto(`chrome-extension://${config.id}/index.html`);
  const nextPage = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  const dedicated = await nextPage;
  await dedicated.getByText('Google sign-in was cancelled. You can try again.', { exact: true }).waitFor();
  assert.equal(dedicated.url(), `chrome-extension://${config.id}/index.html`);
  assert.deepEqual(errors, []);
  console.log('PASS: Google PKCE sign-in without any background worker and with runtime messaging forced to fail; cancellation, cleanup, callback validation, session storage, Google-only new/offline/reopened vaults, one-time migration preserving existing secrets, single form with a prefilled name and optional clickable link, key removal on sign-out, and popup-to-tab continuation. Google/API responses simulated.');
} finally { await context.close(); }
