# Quiet Vault mobile

Android-first Flutter companion to Quiet Vault for Chrome. Created in `D:\apps\quiet_vault_mobile`.

## Use

Sign in with the **same Google account** used in Chrome. There is no master password for Google-managed vaults. The app opens the same existing vault in the free `clinic_queue` Supabase project.

The home screen has just **Find or name a secret** and **Add**. Type a name and press Add: one form asks for the token/password and an optional description or link. If the home field is blank, Name appears on that same form. Tap a row to edit; use its Copy button to copy the exact value. HTTP(S) links in descriptions open in the browser. Other schemes remain plain text.

Options provides sync, lock and sign-out. The app hides its contents when backgrounded or after two minutes of inactivity, and revealed values hide after fifteen seconds. Open vault uses the saved Google session and device key, with no second password. Sign out on shared phones. Clipboard contents remain until replaced.

## Sync and offline access

The app uses the existing `quiet_vaults` table and `quiet_vault_managed_key` / `quiet_vault_save` RPCs. It adds no tables, project or paid service. The complete vault format matches the Chrome extension: AES-256-GCM, PBKDF2-SHA256 with 600,000 iterations, random salt/nonces, a wrapped 256-bit data key, and account/purpose-bound authenticated encryption. Names and descriptions are encrypted too.

Offline access works after the first successful opening on this device. Each edit is encrypted and saved locally before syncing. Synchronization runs on opening, after edits, every 45 seconds while open, and manually from the sync indicator. Revision checks reject stale writes. Independent changes merge; conflicting edits preserve both versions with an idempotent conflict copy. A deletion conflicting with another device's edit preserves that edit.

The saved account session, PKCE verifier, server-managed wrapping secret and encrypted cache are stored using `flutter_secure_storage` with Android Keystore-backed protection. Android cloud backups are disabled. Sign-out removes the saved wrapping key/session and preserves the encrypted cache, so unsynced edits can be recovered by signing back into the same account. Clearing app storage or uninstalling loses local-only edits.

As already selected for Chrome, **Google vault keys are managed by Supabase; the server can decrypt the vault.** This is not end-to-end encryption against the server. A signed-in device can open the vault automatically. Protect the Google account and phone. No service-role key or Google client secret is bundled; the Supabase publishable key is intentionally public.

The first mobile version does not have website autofill, biometric unlocking or mobile backup export. Encrypted backup export/restore remains available in Chrome. Existing legacy master-password vaults must be migrated through Chrome once before mobile can open them.

## Android / Google setup

- Android application ID: `com.thanoon.quiet_vault`.
- Supabase callback: `com.thanoon.quietvault://login-callback`.
- Add that exact callback in Supabase Authentication → URL Configuration alongside the existing Chrome and clinic callbacks. Do not change the Site URL or existing provider credentials.
- Browser-based Google OAuth uses PKCE and returns through the Android intent filter. No additional Google Cloud Android client ID is needed for this browser flow.
- Flutter's default deep-link routing is disabled so `supabase_flutter` handles only the exact callback scheme/host/path with one authorization code and no fragment.

## Build

Flutter 3.47 / Dart 3.13 were used. Android 7.0+ (API 24), compile/target SDK 36. Dependencies are pinned and `pubspec.lock` is checked in. The existing Flutter/Android SDK is reused.

```powershell
cd D:\apps\quiet_vault_mobile
flutter pub get
flutter analyze
flutter test
flutter run
flutter build apk --release
```

The template currently signs release builds using the local **development** signing key for installing the preview. Configure a dedicated production signing key before any store publication. The APK is a review build, not a Play Store release.

For an explicit offline-only visual demo with synthetic values:

```powershell
flutter run --dart-define=QUIET_VAULT_DEMO=true
```

Demo mode makes no backend requests. The included demo asset and cryptographic fixtures contain fake values only.

## Verification

- Flutter analysis and UI tests: Google-only login controls, reused name with a single Add form, masked values, copy, editing, and background privacy cover.
- Real Chrome WebCrypto fixtures decrypt in Flutter; Flutter ciphertext decrypts in the Chrome client, including Unicode and preserved whitespace.
- Offline edit/restart, correct edit baselines, stale revision retries, conflict copies, deletion conflicts, local storage failure rollback and locked-state rejection.
- Optional live sync tests use only a disposable dummy account. Flutter writes a fake secret, the Chrome client reads/edits it, Flutter reads the response and soft-deletes the test entry. No personal vault is accessed.

The default test run skips the credential-dependent live test. To repeat it, provide an external JSON file with `email` and `accountPassword` via `QUIET_VAULT_TEST_CREDENTIALS`. Use a disposable Google-managed test vault, never a personal account. No credentials belong in this repository. A phone was not connected during development; complete actual Google sign-in on your Android device during review.
