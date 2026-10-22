import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationCode, googleSignIn, oauthError } from '../src/oauth.js';
const redirect = 'https://example.chromiumapp.org/supabase';

test('callback accepts one code only at the exact callback and rejects tokens/errors', () => {
  assert.equal(authorizationCode(`${redirect}?code=one-time-code`, redirect), 'one-time-code');
  for (const url of [undefined, 'not a URL', `${redirect}?code=`, `${redirect}?code=a&code=b`,
    'https://evil.example/supabase?code=a', `${redirect}/extra?code=a`,
    `${redirect}?error=access_denied`, `${redirect}#access_token=token`, `${redirect}?code=a#token`]) {
    assert.throws(() => authorizationCode(url, redirect));
  }
});
test('Google uses browser-managed flow and code exchange, never implicit tokens', async () => {
  const expected = { user: { id: 'google-user' } };
  let exchanged = false;
  const client = { auth: {
    async signInWithOAuth(request) {
      assert.equal(request.provider, 'google'); assert.equal(request.options.redirectTo, redirect);
      assert.equal(request.options.skipBrowserRedirect, true); assert.equal(request.options.queryParams.prompt, 'select_account');
      return { data: { url: 'https://auth.example/authorize?provider=google' } };
    },
    async exchangeCodeForSession(code) { assert.equal(code, 'once'); exchanged = true; return { data: { session: expected } }; }
  } };
  const identity = { getRedirectURL: path => { assert.equal(path, 'supabase'); return redirect; },
    launchWebAuthFlow: async options => { assert.equal(options.interactive, true); return `${redirect}?code=once`; } };
  assert.deepEqual(await googleSignIn(client, identity), expected); assert.equal(exchanged, true);
});
test('cancel and exchange failures do not produce sessions or reveal token-bearing URLs', async () => {
  const client = { auth: { signInWithOAuth: async () => ({ data: { url: 'https://auth.example/authorize?provider=google' } }),
    exchangeCodeForSession: async () => ({ error: new Error('expired code') }) } };
  await assert.rejects(googleSignIn(client, { getRedirectURL: () => redirect, launchWebAuthFlow: async () => undefined }), /cancelled/);
  await assert.rejects(googleSignIn(client, { getRedirectURL: () => redirect, launchWebAuthFlow: async () => `${redirect}?code=old` }), /expired/);
  assert.ok(!oauthError(new Error('https://callback/?code=private-code')).includes('private-code'));
});
