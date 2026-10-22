import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve('dist');
const output = resolve(process.env.VAULT_OUTPUT_DIR ?? 'test-results');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const csp = manifest.content_security_policy.extension_pages;
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
    if (!target.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const type = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.json': 'application/json' }[extname(target)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': csp }); res.end(await readFile(target));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 400, height: 640 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.setDefaultTimeout(12000);
const errors = [];
const writes = [];
let row = null;
let available = true;
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'demo@example.test', app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {}, aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString() };
const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, role: 'authenticated', exp: Math.floor(Date.now()/1000) + 3600 })).toString('base64url')}.test-only-signature`;
await context.route('https://axncazensmjdqpczvzwf.supabase.co/**', async route => {
  if (!available) { await route.abort('internetdisconnected'); return; }
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const body = request.postDataJSON();
  const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (path === '/auth/v1/signup') return respond({ user: { ...user, identities: [] }, session: null });
  if (path === '/auth/v1/token') return respond({ access_token: jwt, refresh_token: 'test-refresh-token', expires_in: 3600, token_type: 'bearer', user });
  if (path === '/auth/v1/user') return respond(user);
  if (path === '/auth/v1/logout') return respond({});
  if (path === '/rest/v1/quiet_vaults') {
    if (request.method() === 'GET') return respond(row ? [row] : []);
    if (request.method() === 'POST') {
      writes.push(body); row = { ...(Array.isArray(body) ? body[0] : body), updated_at: new Date().toISOString() };
      return respond(row, 201);
    }
  }
  if (path === '/rest/v1/rpc/quiet_vault_managed_key') return respond(Buffer.alloc(32, 37).toString('base64'));
  if (path === '/rest/v1/rpc/quiet_vault_save') {
    writes.push(body);
    if (body.expected_revision !== row.revision) return respond([]);
    row = { ...row, nonce: body.new_nonce, ciphertext: body.new_ciphertext, revision: row.revision + 1 };
    return respond([row]);
  }
  throw new Error(`Unexpected request ${request.method()} ${path}`);
});
page.on('pageerror', error => errors.push(error.message));
page.on('console', event => { if (event.type() === 'error' && /content security policy|refused to/i.test(event.text())) errors.push(event.text()); });
await page.addInitScript(() => {
  globalThis.chrome = { runtime: { id: 'test-extension' }, identity: {
    getRedirectURL: () => 'https://test-extension.chromiumapp.org/supabase',
    launchWebAuthFlow: async () => 'https://test-extension.chromiumapp.org/supabase?code=browser-test-code'
  } };
});

async function add(name, value, kind = 'API key') {
  await page.getByRole('searchbox').fill(name);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  assert.equal(await page.getByLabel('Name', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).count(), 0);
  await page.getByRole('heading', { name, exact: true }).waitFor();
  await page.getByLabel('Token or password', { exact: true }).fill(value);
  if (name.startsWith('GitHub')) await page.getByLabel('Description or link (optional)', { exact: true }).fill('javascript:alert(1) http://[invalid');
  if (name.startsWith('OpenAI')) await page.getByLabel('Description or link (optional)', { exact: true }).fill('https://example.test/keys');
  await page.getByRole('button', { name: 'Save secret', exact: true }).click();
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).waitFor();
}
try {
  await page.goto(url);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'quiet-vault-google-signin.png') });
  assert.equal(await page.getByRole('button', { name: 'Use email instead', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Account password', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await page.getByRole('searchbox').waitFor();
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'quiet-vault-empty.png') });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).waitFor();
  await page.getByLabel('Token or password', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'All secrets', exact: true }).click();
  await add('OpenAI · personal', 'demo-openai-value');
  const savedLink = page.getByRole('link', { name: 'https://example.test/keys', exact: true });
  assert.equal(await savedLink.getAttribute('href'), 'https://example.test/keys');
  assert.equal(await savedLink.getAttribute('rel'), 'noopener noreferrer');
  await add('GitHub access token', 'demo-github-value', 'Secret');
  assert.equal(await page.locator('.secret-description a').count(), 1);
  await page.getByText('javascript:alert(1) http://[invalid', { exact: true }).waitFor();
  await add('DATABASE_URL', 'demo-database-value', 'Variable');
  await page.getByRole('button', { name: 'Sync vault now' }).count(); // Status has a title, not an extra focus control.
  await page.locator('#sync-status').click();
  await page.getByText('Vault is up to date.', { exact: true }).waitFor();
  await page.evaluate(() => document.querySelector('#toast').classList.remove('visible'));
  await page.locator('#toast').evaluate(node => { node.hidden = true; });
  await page.screenshot({ path: resolve(output, 'quiet-vault-preview.png') });
  await page.locator('#toast').evaluate(node => { node.hidden = false; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 400);
  assert.ok(!(await page.locator('body').innerText()).includes('demo-openai-value'));
  await page.getByRole('button', { name: 'Copy OpenAI · personal', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'demo-openai-value');
  await page.getByRole('searchbox').fill('github');
  assert.equal(await page.locator('.secret-row').count(), 1);
  await page.getByRole('searchbox').fill('nothing matches');
  await page.getByText('Nothing by that name.').waitFor();
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'Edit OpenAI · personal', exact: true }).click();
  assert.equal(await page.getByLabel('Description (optional)', { exact: true }).inputValue(), 'https://example.test/keys');
  assert.equal(await page.getByLabel('Value', { exact: true }).getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Show secret value', exact: true }).click();
  assert.equal(await page.getByLabel('Value', { exact: true }).getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Hide secret value', exact: true }).click();
  await page.getByLabel('Value', { exact: true }).fill('edited-demo-value');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Edit OpenAI · personal', exact: true }).waitFor();
  await page.locator('#sync-status').click();
  await page.getByText('Vault is up to date.', { exact: true }).waitFor();
  const saved = await page.evaluate(() => JSON.stringify(localStorage));
  for (const forbidden of ['edited-demo-value', 'demo-github-value', 'OpenAI · personal']) assert.ok(!saved.includes(forbidden));
  for (const forbidden of ['edited-demo-value', 'demo-github-value', 'OpenAI · personal']) assert.ok(!JSON.stringify(writes).includes(forbidden));
  await page.getByRole('button', { name: 'Vault options', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save encrypted backup', exact: true }).click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.app, 'quiet-vault'); assert.ok(!JSON.stringify(backup).includes('edited-demo-value'));
  await page.getByRole('button', { name: 'All secrets', exact: true }).click();
  await page.getByRole('button', { name: 'Edit GitHub access token', exact: true }).click();
  await page.getByRole('button', { name: 'Delete secret', exact: true }).click();
  await page.getByRole('button', { name: 'Delete this secret? Click again to confirm', exact: true }).click();
  assert.equal(await page.locator('.secret-row').count(), 2);
  available = false;
  await add('Offline key', 'offline-only-secret');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open vault', exact: true }).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('Offline key'));
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await page.reload();
  await page.getByRole('button', { name: 'Edit Offline key', exact: true }).waitFor();
  available = true;
  await page.locator('#sync-status').click();
  await page.getByText('Vault is up to date.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Vault options', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.getByRole('button', { name: /Edit GitHub access token/ }).waitFor();
  await page.clock.install();
  await page.getByRole('searchbox').click();
  await page.clock.fastForward(120001);
  await page.getByRole('button', { name: 'Open vault', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open vault', exact: true }).click();
  await page.getByRole('button', { name: 'Vault options', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('OpenAI'));
  assert.deepEqual(errors, []);
  console.log('PASS browser: Google-only sign-in, no email/password controls, automatic vault creation, add/search/copy/edit/delete, masks, backups/restore, offline automatic reopening, later sync, lock/sign-out, CSP, no plaintext persisted or sent.');
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); server.close(); }
