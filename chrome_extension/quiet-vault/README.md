# Quiet Vault — Chrome preview 0.2.2

A small personal vault for API keys, passwords, secrets, and variables. The home screen focuses on **Search** and **Add**. Android is deferred until the Chrome version is approved.

## Install or update

Load `dist/` in `chrome://extensions` using Developer mode → Load unpacked. For an existing installation, click Reload. The extension ID stays `ecoganpmeologajglpdbkjnjmmllflga`.

Choose **Continue with Google**. A dedicated vault tab finishes authorization, then opens the vault automatically. An existing vault asks for its old master password **once** to migrate; new Google vaults need no master password. Google is the only sign-in option; email/password controls are not displayed. Existing legacy encrypted vaults still require their old password once to preserve their contents.

The Supabase redirect allowlist must contain `https://ecoganpmeologajglpdbkjnjmmllflga.chromiumapp.org/supabase` alongside the existing clinic callback. Keep the existing Site URL and Google provider credentials.

## Daily use

- **Type the name in the home search field → Add → Token or password + optional description/link → Save secret.** Add opens one compact form, with the name already set. If the home field is empty, Name appears on that same form. Saved HTTP(S) links are clickable. No type choice is required when adding.
- Search by name or type, copy from a row, or open a row to edit, reveal briefly, and delete with confirmation.
- Options provides Lock, encrypted backup/restore, sign-in diagnostics, and Sign out.
- Closing/hiding the vault, Escape, or two minutes of inactivity clears decrypted items from the UI. Google vaults reopen with the saved account session. The Open vault button after locking is a privacy cover, not an additional authentication factor. Sign out on shared devices.
- Offline access works after opening the vault online once on that device. Edits are encrypted locally and sync while the vault is open. The small sync status retries synchronization.
- Copied values stay on the system clipboard until replaced. The extension does not read your clipboard.

## Encryption and access

Full vault contents, including names and descriptions, use Web Crypto AES-256-GCM with random nonces. A random 256-bit data key is wrapped using PBKDF2-SHA256 (600,000 iterations); imported data keys are nonexportable. Authenticated encryption binds data to the account and purpose.

**Google vaults use server-managed encryption, not end-to-end encryption against the server.** Supabase Vault stores an encrypted wrapping secret and authenticated account-bound RPCs retrieve only the caller's secret. The server can decrypt Google vaults. The extension caches the wrapping secret in `chrome.storage.local` for automatic and offline access. Its saved session and local key must be protected by the browser profile/device. Development previews use localStorage instead. Signing out removes the cached wrapping secret and the local app session, while preserving the encrypted cache for recovery.

Legacy email vaults keep their separate master password, which is not persisted or sent to Supabase. There is no master-password reset. Migrating an existing Google vault rewraps the same data key, preserving encrypted items, pending edits, and old backups. The old master password is no longer sufficient to open a migrated vault.

RLS restricts rows to their owner. Public RPCs use SECURITY INVOKER; privileged key helpers are in an unexposed schema, use explicit account checks and fixed search paths, and deny anonymous access. Revision checks prevent stale migrations and writes. Concurrent conflicting edits keep both versions. No service-role key, content scripts, remote JavaScript, analytics, or page-reading permissions are bundled.

The app uses the existing free `clinic_queue` Supabase project. `supabase/schema.sql` documents the initial additive schema; apply `supabase/managed-unlock.sql` after it for Google unlocking. Existing clinic tables, policies and callbacks are preserved.

## Backups and diagnostics

Save encrypted backups from Options; restore into the same signed-in, open vault. Restore adds missing items and keeps changed items as restored copies. A backup alone does not recover the managed key: Google vaults still need the same account and its server-managed key. Email vaults need their master password. Uninstalling/clearing browser storage loses local-only edits; sync or export first.

Sign-in failures offer **Download sign-in diagnostics**, also available in Options. The local file contains only a random attempt ID, timestamps, version, stages and fixed failure categories. No email, secret, token, authorization code, URL or raw provider error is logged. Diagnostics are not uploaded automatically; share the exported file when troubleshooting.

## Development and verification

Node 22.12+ or 24+: `npm ci`, `npm test`, `npm run build`. Load `dist/`. `npm run dev` provides a separate HTTP preview; Google requires the installed extension.

`npm run test:browser` checks Google-only sign-in, automatic opening, single-screen adding, encrypted descriptions, editing/copy/delete, backup/restore, offline restart and syncing. `node tests/extension-smoke.mjs` loads an isolated real extension with simulated Google/API responses and verifies automatic Google opening, one-time migration, offline access, key removal on sign-out and popup continuation. Set `CHROME_PATH` / `EDGE_PATH` for an alternative Chromium browser.

Node tests exercise real encryption, rewrapping with old backup preservation, tampering, merge conflicts, offline storage and rollback. Live Supabase checks use dummy data and transaction rollback to verify permissions, stable separate account keys, migration revisions and private storage isolation. Supabase advisors report no findings for the vault objects; unrelated project findings are unchanged.
